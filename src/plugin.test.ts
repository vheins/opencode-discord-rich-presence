/**
 * Plugin wiring tests — graceful degradation without Discord plus event-to-presence mapping.
 */
import { describe, expect, test } from "bun:test";
import type { PluginInput } from "@opencode-ai/plugin";
import type { Event, Message } from "@opencode-ai/sdk";
import { DEFAULT_CLIENT_ID } from "./config/schema";
import type {
  Transport,
  TransportEvent,
  TransportListener,
  TransportState,
} from "./discord/transport";
import { buildDiscordPresenceHooks } from "./plugin";
import type { LogEntry } from "./utils/logger";

/** Transport that always fails to connect, mimicking a missing Discord socket. */
class FailingTransport implements Transport {
  state: TransportState = "disconnected";

  connect(): Promise<void> {
    return Promise.reject(new Error("ENOENT: no such file or directory, connect"));
  }

  setActivity(): Promise<void> {
    return Promise.resolve();
  }

  clear(): Promise<void> {
    return Promise.resolve();
  }

  async close(): Promise<void> {
    this.state = "closed";
  }

  on(): void {
    // no listeners needed for the failure path
  }

  off(): void {
    // no listeners needed for the failure path
  }
}

/** In-memory transport that reports ready and records every activity update. */
class ReadyTransport implements Transport {
  state: TransportState = "disconnected";
  readonly activities: Array<{ activity: Record<string, unknown> | null; nonce: string }> = [];
  private readonly listeners = new Map<TransportEvent, Set<TransportListener>>();

  connect(): Promise<void> {
    queueMicrotask(() => {
      this.state = "ready";
      this.emit("ready");
    });
    return Promise.resolve();
  }

  setActivity(activity: Record<string, unknown> | null, nonce: string): Promise<void> {
    this.activities.push({ activity, nonce });
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.activities.push({ activity: null, nonce: "clear" });
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

  private emit(event: TransportEvent): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener();
    }
  }
}

/** Yield to the event loop so pending microtasks and zero-delay timers settle. */
const tick = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

/** Plugin options that keep debounce/throttle at zero for deterministic tests. */
const TEST_OPTIONS = {
  applicationId: "123456789012345678",
  enabled: true,
  throttle: { debounceMs: 0, minIntervalMs: 0 },
  idle: { enabled: true, details: "Idle — ready", state: "Ready" },
  buttons: [],
};

/** Config loader overrides that isolate tests from the host filesystem and environment. */
const TEST_LOADER = {
  env: {} as Record<string, string | undefined>,
  homeDir: "/nonexistent-opencode-discord-home",
  readFile: async (): Promise<string | null> => null,
};

/** Build a fake PluginInput whose `app.log` records entries into `logs`. */
function createInput(logs: LogEntry[]): PluginInput {
  const client = {
    app: {
      log: async (input: { body: LogEntry }): Promise<boolean> => {
        logs.push(input.body);
        return true;
      },
    },
  };
  return {
    client,
    project: {},
    directory: "/tmp/opencode-discord-test",
    worktree: "/tmp/opencode-discord-test",
    experimental_workspace: { register: () => undefined },
    serverUrl: new URL("http://localhost:4096"),
    $: {},
  } as unknown as PluginInput;
}

/** Build a minimal valid `session.created` event. */
function sessionCreated(sessionID: string): Event {
  return {
    type: "session.created",
    properties: {
      info: {
        id: sessionID,
        projectID: "proj_test",
        directory: "/tmp/opencode-discord-test",
        title: "Test session",
        version: "1.18.30",
        time: { created: 1_000, updated: 1_000 },
      },
    },
  };
}

/** Build an assistant `message.updated` event carrying per-message stats. */
function assistantUpdated(sessionID: string, modelID: string, cost: number): Event {
  const info: Message = {
    id: `msg_${modelID}`,
    sessionID,
    role: "assistant",
    parentID: "msg_user",
    time: { created: 2_000, completed: 2_100 },
    modelID,
    providerID: "anthropic",
    mode: "build",
    path: { cwd: "/tmp/opencode-discord-test", root: "/tmp/opencode-discord-test" },
    cost,
    tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  return { type: "message.updated", properties: { info } };
}

/** Build a `session.idle` event. */
function sessionIdle(sessionID: string): Event {
  return { type: "session.idle", properties: { sessionID } };
}

/** Build a `session.deleted` event. */
function sessionDeleted(sessionID: string): Event {
  return {
    type: "session.deleted",
    properties: {
      info: {
        id: sessionID,
        projectID: "proj_test",
        directory: "/tmp/opencode-discord-test",
        title: "Test session",
        version: "1.18.30",
        time: { created: 1_000, updated: 1_000 },
      },
    },
  };
}

describe("buildDiscordPresenceHooks", () => {
  test("initializes and degrades gracefully when no Discord socket exists", async () => {
    const logs: LogEntry[] = [];
    const hooks = await buildDiscordPresenceHooks(createInput(logs), TEST_OPTIONS, {
      createTransport: () => new FailingTransport(),
      configLoaderOptions: TEST_LOADER,
    });

    expect(typeof hooks.event).toBe("function");
    expect(typeof hooks.dispose).toBe("function");

    await tick();
    expect(
      logs.some(
        (entry) => entry.level === "warn" && entry.message.includes("Discord IPC unavailable"),
      ),
    ).toBe(true);

    await hooks.dispose?.();
  });

  test("maps session lifecycle events to presence updates over a ready transport", async () => {
    const logs: LogEntry[] = [];
    const holder: { transport: ReadyTransport | null } = { transport: null };
    const hooks = await buildDiscordPresenceHooks(createInput(logs), TEST_OPTIONS, {
      createTransport: () => {
        const transport = new ReadyTransport();
        holder.transport = transport;
        return transport;
      },
      configLoaderOptions: TEST_LOADER,
    });

    await tick();
    expect(holder.transport).not.toBeNull();

    await hooks.event?.({ event: sessionCreated("ses_test") });
    await tick();
    const idleActivity = holder.transport?.activities.at(-1)?.activity;
    expect(idleActivity?.details).toBe("Idle — ready");
    expect(idleActivity?.assets).toMatchObject({ large_image: "opencode" });

    await hooks.event?.({ event: assistantUpdated("ses_test", "claude-3", 0.01) });
    await tick();
    const activeActivity = holder.transport?.activities.at(-1)?.activity;
    expect(activeActivity?.details).toBe("Working with claude-3");
    expect(typeof activeActivity?.state).toBe("string");

    await hooks.event?.({ event: sessionIdle("ses_test") });
    await tick();
    expect(holder.transport?.activities.at(-1)?.activity?.details).toBe("Idle — ready");

    await hooks.event?.({ event: sessionDeleted("ses_test") });
    await tick();
    expect(holder.transport?.activities.at(-1)?.activity).toBeNull();

    await hooks.dispose?.();
  });

  test("falls back to the bundled DEFAULT_CLIENT_ID when applicationId is empty", async () => {
    const logs: LogEntry[] = [];
    const holder: { transport: ReadyTransport | null } = { transport: null };
    const hooks = await buildDiscordPresenceHooks(
      createInput(logs),
      { ...TEST_OPTIONS, applicationId: "" },
      {
        createTransport: () => {
          const transport = new ReadyTransport();
          holder.transport = transport;
          return transport;
        },
        configLoaderOptions: TEST_LOADER,
      },
    );

    await tick();
    expect(DEFAULT_CLIENT_ID).toMatch(/^\d{17,20}$/);
    expect(typeof hooks.event).toBe("function");
    expect(holder.transport).not.toBeNull();

    await hooks.dispose?.();
  });
});
