/**
 * Reconnect FSM for the Discord transport.
 *
 * Wraps a transport factory with bounded exponential backoff, jitter and a generation
 * guard so stale async callbacks cannot resurrect a closed session. Neither upstream
 * Discord library implements IPC reconnection, so this controller owns the policy
 * (`docs/ARCHITECTURE.md` §6.2, `docs/DISCORD-RPC.md` §7.1–7.2).
 */
import type {
  ClearTimeoutFn,
  SetTimeoutFn,
  TimeoutHandle,
  Transport,
  TransportEvent,
  TransportState,
} from "./transport";
import { unrefTimer } from "./transport";

/** Backoff tuning options; every field is optional and injectable for tests. */
export interface BackoffOptions {
  /** First retry delay in ms; defaults to 1000. */
  baseMs?: number;
  /** Maximum backoff delay in ms; defaults to 30000. */
  capMs?: number;
  /** Consecutive failed attempts before closing; defaults to 10. */
  maxAttempts?: number;
  /** Jitter ratio applied symmetrically; defaults to 0.2 (±20%). */
  jitterRatio?: number;
  /** Floor for any computed delay in ms; defaults to 250. */
  minDelayMs?: number;
  /** Random source in `[0, 1)`; defaults to `Math.random`. */
  random?: () => number;
}

/** Backoff tuning with every field resolved to a concrete value. */
export interface ResolvedBackoff {
  /** First retry delay in ms. */
  baseMs: number;
  /** Maximum backoff delay in ms. */
  capMs: number;
  /** Consecutive failed attempts before closing. */
  maxAttempts: number;
  /** Symmetric jitter ratio. */
  jitterRatio: number;
  /** Floor for any computed delay in ms. */
  minDelayMs: number;
}

/** Documented reconnect defaults (`docs/ARCHITECTURE.md` §6.2). */
export const DEFAULT_BACKOFF: ResolvedBackoff = {
  baseMs: 1_000,
  capMs: 30_000,
  maxAttempts: 10,
  jitterRatio: 0.2,
  minDelayMs: 250,
};

/**
 * Resolve partial backoff options against the documented defaults.
 *
 * @param options Partial tuning overrides.
 * @returns A fully populated backoff configuration.
 */
export function resolveBackoff(options: BackoffOptions = {}): ResolvedBackoff {
  return {
    baseMs: options.baseMs ?? DEFAULT_BACKOFF.baseMs,
    capMs: options.capMs ?? DEFAULT_BACKOFF.capMs,
    maxAttempts: options.maxAttempts ?? DEFAULT_BACKOFF.maxAttempts,
    jitterRatio: options.jitterRatio ?? DEFAULT_BACKOFF.jitterRatio,
    minDelayMs: options.minDelayMs ?? DEFAULT_BACKOFF.minDelayMs,
  };
}

/**
 * Compute the next backoff delay for a zero-based attempt index.
 *
 * `exp = min(cap, base * 2^attempt)`, jittered by `±exp * jitterRatio` and floored at
 * `minDelayMs`.
 *
 * @param attempt Zero-based retry index.
 * @param options Partial tuning overrides.
 * @returns Delay in milliseconds.
 */
export function nextDelay(attempt: number, options: BackoffOptions = {}): number {
  const { baseMs, capMs, jitterRatio, minDelayMs } = resolveBackoff(options);
  const random = options.random ?? Math.random;
  const exponent = Math.max(0, Math.floor(attempt));
  const exp = Math.min(capMs, baseMs * 2 ** exponent);
  const jitter = exp * jitterRatio * (random() * 2 - 1);
  return Math.max(minDelayMs, Math.round(exp + jitter));
}

/**
 * Compute the full retry delay schedule.
 *
 * @param options Partial tuning overrides.
 * @returns One delay per allowed attempt, from `baseMs` up to `capMs`.
 */
export function backoffSchedule(options: BackoffOptions = {}): number[] {
  const { maxAttempts } = resolveBackoff(options);
  const attempts = Math.max(0, Math.floor(maxAttempts));
  return Array.from({ length: attempts }, (_, index) => nextDelay(index, options));
}

/** Events emitted by the reconnect controller. */
export type ReconnectEvent = TransportEvent;

/** Listener registered for a reconnect controller event. */
export type ReconnectListener = (arg?: unknown) => void;

/** Construction options for `createReconnectController`. */
export interface ReconnectControllerOptions extends BackoffOptions {
  /** Creates a fresh transport per connection attempt. */
  createTransport: () => Transport;
  /** Auto-reconnect toggle; defaults to true. */
  enabled?: boolean;
  /** Per-attempt connect+handshake timeout in ms; defaults to 10000. */
  connectTimeoutMs?: number;
  /** Timeout scheduler injection point. */
  setTimeoutFn?: SetTimeoutFn;
  /** Timeout cancellation injection point. */
  clearTimeoutFn?: ClearTimeoutFn;
}

/** Reconnect controller contract. */
export interface ReconnectController {
  /** Current lifecycle state. */
  readonly state: TransportState;
  /** Number of consecutive failed attempts. */
  readonly attempt: number;
  /** Begin connecting (idempotent while connecting/ready). */
  start(): void;
  /** Stop retrying, close the active transport and move to `closed`. */
  stop(): Promise<void>;
  /** Send `SET_ACTIVITY`, queueing the latest payload while not ready. */
  send(activity: Record<string, unknown> | null, nonce: string): Promise<void>;
  /** Subscribe to a lifecycle event. */
  on(event: ReconnectEvent, listener: ReconnectListener): void;
  /** Unsubscribe from a lifecycle event. */
  off(event: ReconnectEvent, listener: ReconnectListener): void;
}

/**
 * Create a reconnect controller around a transport factory.
 *
 * @param options Transport factory, backoff tuning and injection points.
 * @returns A `ReconnectController` owning the reconnect lifecycle.
 */
export function createReconnectController(
  options: ReconnectControllerOptions,
): ReconnectController {
  const backoff = resolveBackoff(options);
  const enabled = options.enabled ?? true;
  const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  const scheduleTimeout = options.setTimeoutFn ?? setTimeout;
  const cancelTimeout = options.clearTimeoutFn ?? clearTimeout;

  const listeners = new Map<ReconnectEvent, Set<ReconnectListener>>();
  let state: TransportState = "disconnected";
  let attempt = 0;
  let generation = 0;
  let transport: Transport | null = null;
  let timer: TimeoutHandle | null = null;
  let stopped = false;
  let pending: { activity: Record<string, unknown> | null; nonce: string } | null = null;

  /** Emit an event to every subscriber, isolating listener failures. */
  function emit(event: ReconnectEvent, arg?: unknown): void {
    const subscribers = listeners.get(event);
    if (subscribers === undefined) {
      return;
    }
    for (const listener of [...subscribers]) {
      try {
        listener(arg);
      } catch {
        // Listener failures must never break the controller.
      }
    }
  }

  /** Move to a new lifecycle state. */
  function setState(next: TransportState): void {
    state = next;
  }

  /** Cancel the pending retry timer, if any. */
  function clearTimer(): void {
    if (timer !== null) {
      cancelTimeout(timer);
      timer = null;
    }
  }

  /** Forward the most recent queued activity after a successful reconnect. */
  function flushPending(): void {
    const queued = pending;
    if (queued === null || transport === null) {
      return;
    }
    pending = null;
    transport.setActivity(queued.activity, queued.nonce).catch((error: unknown) => {
      emit("error", error);
    });
  }

  /** Schedule the next connection attempt after a failure. */
  function scheduleReconnect(): void {
    clearTimer();
    setState("disconnected");
    const delay = nextDelay(attempt - 1, options);
    const guard = generation;
    timer = scheduleTimeout(() => {
      timer = null;
      if (guard !== generation || stopped) {
        return;
      }
      void connectAttempt();
    }, delay);
    unrefTimer(timer);
  }

  /** Count a failure and either close or schedule a retry. */
  function handleFailure(reason: unknown): void {
    if (stopped) {
      return;
    }
    attempt += 1;
    emit("error", reason);
    if (!enabled || attempt >= backoff.maxAttempts) {
      setState("closed");
      emit("closed", reason);
      return;
    }
    scheduleReconnect();
  }

  /** Run one connect attempt guarded by the current generation. */
  async function connectAttempt(): Promise<void> {
    if (stopped) {
      return;
    }
    const guard = ++generation;
    setState("connecting");
    const active = options.createTransport();
    transport = active;
    let settled = false;

    active.on("ready", () => {
      if (guard !== generation || settled) {
        return;
      }
      settled = true;
      attempt = 0;
      setState("ready");
      emit("ready");
      flushPending();
    });
    active.on("disconnected", () => {
      if (guard !== generation || settled) {
        return;
      }
      settled = true;
      handleFailure(new Error("transport disconnected"));
    });
    active.on("error", (error?: unknown) => {
      if (guard !== generation) {
        return;
      }
      emit("error", error);
    });
    active.on("closed", () => {
      if (guard !== generation || settled) {
        return;
      }
      settled = true;
      setState("closed");
      emit("closed");
    });

    try {
      await connectWithTimeout(active);
    } catch (error) {
      if (guard !== generation || settled) {
        return;
      }
      settled = true;
      try {
        await active.close();
      } catch {
        // Cleanup failures must not block the next backoff attempt.
      }
      handleFailure(error);
    }
  }

  /** Race a transport connect against the per-attempt timeout. */
  function connectWithTimeout(active: Transport): Promise<void> {
    return new Promise((resolve, reject) => {
      const handle = scheduleTimeout(() => {
        reject(new Error(`connect timed out after ${connectTimeoutMs} ms`));
      }, connectTimeoutMs);
      unrefTimer(handle);
      active.connect().then(
        () => {
          cancelTimeout(handle);
          resolve();
        },
        (error: unknown) => {
          cancelTimeout(handle);
          reject(error);
        },
      );
    });
  }

  return {
    get state(): TransportState {
      return state;
    },
    get attempt(): number {
      return attempt;
    },
    start(): void {
      if (stopped) {
        stopped = false;
      }
      if (state === "connecting" || state === "ready") {
        return;
      }
      generation += 1;
      attempt = 0;
      clearTimer();
      void connectAttempt();
    },
    async stop(): Promise<void> {
      stopped = true;
      generation += 1;
      clearTimer();
      const active = transport;
      transport = null;
      pending = null;
      if (active !== null) {
        await active.close();
      }
      setState("closed");
      emit("closed");
    },
    send(activity: Record<string, unknown> | null, nonce: string): Promise<void> {
      if (stopped) {
        return Promise.reject(new Error("reconnect controller is stopped"));
      }
      if (state === "ready" && transport !== null) {
        return transport.setActivity(activity, nonce);
      }
      pending = { activity, nonce };
      return Promise.resolve();
    },
    on(event: ReconnectEvent, listener: ReconnectListener): void {
      const subscribers = listeners.get(event) ?? new Set<ReconnectListener>();
      subscribers.add(listener);
      listeners.set(event, subscribers);
    },
    off(event: ReconnectEvent, listener: ReconnectListener): void {
      listeners.get(event)?.delete(listener);
    },
  };
}
