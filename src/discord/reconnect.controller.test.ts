/**
 * Reconnect controller tests using an injected fake transport and scheduler.
 */
import { describe, expect, test } from "bun:test";
import { createReconnectController } from "./reconnect";
import type {
  TimeoutHandle,
  Transport,
  TransportEvent,
  TransportListener,
  TransportState,
} from "./transport";

/** Controllable transport used to drive reconnect transitions deterministically. */
class FakeTransport implements Transport {
  state: TransportState = "disconnected";
  readonly activities: Array<{ activity: Record<string, unknown> | null; nonce: string }> = [];
  private readonly listeners = new Map<TransportEvent, Set<TransportListener>>();
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((error: Error) => void) | null = null;

  connect(): Promise<void> {
    this.state = "connecting";
    return new Promise((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });
  }

  setActivity(activity: Record<string, unknown> | null, nonce: string): Promise<void> {
    this.activities.push({ activity, nonce });
    return Promise.resolve();
  }

  clear(): Promise<void> {
    return Promise.resolve();
  }

  async close(): Promise<void> {
    this.state = "closed";
  }

  on(event: TransportEvent, listener: TransportListener): void {
    const subscribers = this.listeners.get(event) ?? new Set<TransportListener>();
    subscribers.add(listener);
    this.listeners.set(event, subscribers);
  }

  off(event: TransportEvent, listener: TransportListener): void {
    this.listeners.get(event)?.delete(listener);
  }

  /** Simulate the server completing the handshake. */
  ready(): void {
    this.state = "ready";
    this.emit("ready");
    this.resolveConnect?.();
  }

  /** Simulate a connect/handshake failure. */
  fail(error: Error): void {
    this.state = "disconnected";
    this.emit("disconnected");
    this.rejectConnect?.(error);
  }

  private emit(event: TransportEvent): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener();
    }
  }
}

/** Controller plus the scheduled retries and transports it produced. */
interface Harness {
  controller: ReturnType<typeof createReconnectController>;
  scheduled: Array<{ fn: () => void; ms: number }>;
  connectTimeouts: Array<() => void>;
  transports: FakeTransport[];
}

/** Yield to the event loop so pending microtasks settle. */
const tick = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

/** Distinctive per-attempt connect timeout so retry schedules can be isolated. */
const CONNECT_TIMEOUT_MS = 999_999;

/** Build a controller with a recording scheduler and fake transport factory. */
function createHarness(options: { maxAttempts?: number; enabled?: boolean } = {}): Harness {
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  const connectTimeouts: Array<() => void> = [];
  const transports: FakeTransport[] = [];
  const controller = createReconnectController({
    createTransport: () => {
      const transport = new FakeTransport();
      transports.push(transport);
      return transport;
    },
    random: () => 0.5,
    maxAttempts: options.maxAttempts ?? 10,
    enabled: options.enabled ?? true,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    setTimeoutFn: (fn, ms) => {
      if (ms === CONNECT_TIMEOUT_MS) {
        connectTimeouts.push(fn);
      } else {
        scheduled.push({ fn, ms });
      }
      return 0 as unknown as TimeoutHandle;
    },
    clearTimeoutFn: () => undefined,
  });
  return { controller, scheduled, connectTimeouts, transports };
}

describe("createReconnectController", () => {
  test("connects on start and resets the attempt counter on ready", async () => {
    const { controller, transports } = createHarness();
    controller.start();
    await tick();

    expect(controller.state).toBe("connecting");
    (transports[0] as FakeTransport).ready();
    await tick();

    expect(controller.state).toBe("ready");
    expect(controller.attempt).toBe(0);
  });

  test("schedules exponential backoff after a failed connect", async () => {
    const { controller, scheduled, transports } = createHarness();
    controller.start();
    await tick();

    (transports[0] as FakeTransport).fail(new Error("boom"));
    await tick();

    expect(controller.state).toBe("disconnected");
    expect(controller.attempt).toBe(1);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.ms).toBe(1_000);

    scheduled[0]?.fn();
    await tick();
    expect(transports).toHaveLength(2);

    (transports[1] as FakeTransport).fail(new Error("boom"));
    await tick();
    expect(scheduled[1]?.ms).toBe(2_000);
  });

  test("closes the candidate transport when a connect attempt times out", async () => {
    const { controller, scheduled, connectTimeouts, transports } = createHarness();
    controller.start();
    await tick();

    expect(transports).toHaveLength(1);
    connectTimeouts[0]?.();
    await tick();

    expect((transports[0] as FakeTransport).state).toBe("closed");
    expect(controller.state).toBe("disconnected");
    expect(scheduled).toHaveLength(1);
  });

  test("closes once maxAttempts is exhausted", async () => {
    const { controller, scheduled, transports } = createHarness({ maxAttempts: 2 });
    controller.start();
    await tick();

    (transports[0] as FakeTransport).fail(new Error("boom"));
    await tick();
    scheduled[0]?.fn();
    await tick();

    (transports[1] as FakeTransport).fail(new Error("boom"));
    await tick();

    expect(controller.state).toBe("closed");
    expect(scheduled).toHaveLength(1);
  });

  test("closes without retrying when reconnect is disabled", async () => {
    const { controller, scheduled, transports } = createHarness({ enabled: false });
    controller.start();
    await tick();

    (transports[0] as FakeTransport).fail(new Error("boom"));
    await tick();

    expect(controller.state).toBe("closed");
    expect(scheduled).toHaveLength(0);
  });

  test("queues activity while not ready and flushes it on ready", async () => {
    const { controller, transports } = createHarness();
    controller.start();
    await tick();

    await controller.send({ details: "queued" }, "nonce-queued");
    expect((transports[0] as FakeTransport).activities).toHaveLength(0);

    (transports[0] as FakeTransport).ready();
    await tick();

    expect((transports[0] as FakeTransport).activities).toEqual([
      { activity: { details: "queued" }, nonce: "nonce-queued" },
    ]);
  });
});
