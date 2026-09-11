/**
 * Presence scheduler — coalesces presence updates before they reach the transport.
 *
 * Applies the architecture's three-stage rate limit: debounce rapid changes, throttle to a
 * minimum interval, and dedupe identical payloads by fingerprint (docs/ARCHITECTURE.md §6.3).
 */
import { type Activity, buildActivity } from "../discord/presence";
import {
  type ClearTimeoutFn,
  type SetTimeoutFn,
  type TimeoutHandle,
  unrefTimer,
} from "../discord/transport";
import type { PresenceModel } from "../types";

/** Construction options for a presence scheduler. */
export interface PresenceSchedulerOptions {
  /** Coalesce window in milliseconds. */
  debounceMs: number;
  /** Minimum interval between transport sends in milliseconds. */
  minIntervalMs: number;
  /** Whether to validate built activities before sending. */
  validate: boolean;
  /** Sends one activity (null clears the card) with a correlation nonce. */
  send: (activity: Activity | null, nonce: string) => Promise<void>;
  /** Called when a send fails; the payload is requeued automatically. */
  onError?: (error: unknown) => void;
  /** Clock injection; defaults to `Date.now`. */
  now?: () => number;
  /** Timeout scheduler injection; defaults to the global `setTimeout`. */
  setTimeoutFn?: SetTimeoutFn;
  /** Timeout cancellation injection; defaults to the global `clearTimeout`. */
  clearTimeoutFn?: ClearTimeoutFn;
}

/** Debouncing/throttling presence update scheduler. */
export interface PresenceScheduler {
  /** Queue a presence model (null clears the card); identical payloads are dropped. */
  schedule(model: PresenceModel | null): void;
  /** Cancel pending work and clear queued state. */
  dispose(): void;
}

/** Create a presence scheduler. */
export function createPresenceScheduler(options: PresenceSchedulerOptions): PresenceScheduler {
  const now = options.now ?? Date.now;
  const scheduleTimeout = options.setTimeoutFn ?? setTimeout;
  const cancelTimeout = options.clearTimeoutFn ?? clearTimeout;
  let pending: { activity: Activity | null; fingerprint: string } | null = null;
  let lastSentFingerprint: string | undefined;
  let lastSentAt = 0;
  let nonceSeq = 0;
  let debounceHandle: TimeoutHandle | null = null;
  let throttleHandle: TimeoutHandle | null = null;

  /** Clear a scheduled timer handle, returning null for easy reassignment. */
  function clearTimer(handle: TimeoutHandle | null): null {
    if (handle !== null) {
      cancelTimeout(handle);
    }
    return null;
  }

  /** Schedule a throttled flush, keeping at most one throttle timer alive. */
  function scheduleFlush(delayMs: number): void {
    if (throttleHandle !== null) {
      return;
    }
    throttleHandle = scheduleTimeout(
      () => {
        throttleHandle = null;
        flush();
      },
      Math.max(0, delayMs),
    );
    unrefTimer(throttleHandle);
  }

  /** Send the queued activity, requeueing it if the transport rejects. */
  function flush(): void {
    const queued = pending;
    if (queued === null) {
      return;
    }
    const wait = options.minIntervalMs - (now() - lastSentAt);
    if (wait > 0) {
      scheduleFlush(wait);
      return;
    }
    pending = null;
    lastSentAt = now();
    lastSentFingerprint = queued.fingerprint;
    options.send(queued.activity, nextNonce()).catch((error: unknown) => {
      if (pending === null) {
        pending = queued;
      }
      scheduleFlush(options.minIntervalMs);
      options.onError?.(error);
    });
  }

  /** Generate a monotonically increasing correlation nonce. */
  function nextNonce(): string {
    nonceSeq += 1;
    return `presence-${now()}-${nonceSeq}`;
  }

  return {
    schedule(model: PresenceModel | null): void {
      let activity: Activity | null;
      try {
        activity = buildActivity(model, { validate: options.validate });
      } catch (error) {
        options.onError?.(error);
        return;
      }
      const fingerprint = JSON.stringify(activity);
      if (fingerprint === lastSentFingerprint && pending === null) {
        return;
      }
      if (pending !== null && pending.fingerprint === fingerprint) {
        return;
      }
      pending = { activity, fingerprint };
      if (debounceHandle !== null) {
        return;
      }
      debounceHandle = scheduleTimeout(() => {
        debounceHandle = null;
        flush();
      }, options.debounceMs);
      unrefTimer(debounceHandle);
    },
    dispose(): void {
      debounceHandle = clearTimer(debounceHandle);
      throttleHandle = clearTimer(throttleHandle);
      pending = null;
    },
  };
}
