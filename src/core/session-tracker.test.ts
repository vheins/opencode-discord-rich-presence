/**
 * Session tracker tests — rotation cleanup on non-tool transitions and signal priority.
 */
import { describe, expect, test } from "bun:test";
import type { Message } from "@opencode-ai/sdk";
import type { ClearTimeoutFn, SetTimeoutFn, TimeoutHandle } from "../discord/transport";
import type { PresenceModel, ToolActivity } from "../types";
import { createSessionTracker, type SessionTrackerOptions } from "./session-tracker";
import type { StateMachineConfig } from "./state-machine";
import type { ToolActivityInput } from "./tool-activity-resolver";

/** Rendering config that exposes the idle/error/permission text for assertions. */
const CONFIG: StateMachineConfig = {
  largeImageKey: "opencode",
  largeImageText: "opencode",
  detailsTemplate: "Working with {model}",
  stateTemplate: "{cost} · {tokens} tokens",
  idle: { enabled: true, details: "Idle — ready", state: "Ready" },
  sessionStats: { showModel: true, showTokens: true, showCost: true, showElapsed: false },
  privacy: { hideProjectPath: false, hideModel: false, hideCost: false, hideFilePaths: false },
};

/** A scheduled fake timer. */
interface ScheduledTimer {
  /** Callback passed to the injected scheduler. */
  handler: () => void;
  /** Delay in milliseconds; used to tell idle timers from rotation timers. */
  ms: number;
  /** Opaque handle returned to the caller. */
  handle: TimeoutHandle;
}

/** Fake scheduler plus its recorded timers and cancellations. */
interface FakeScheduler {
  /** Timers in scheduling order. */
  scheduled: ScheduledTimer[];
  /** Handles passed to the injected cancellation function. */
  cleared: TimeoutHandle[];
  /** Injected timeout scheduler. */
  setTimeoutFn: SetTimeoutFn;
  /** Injected timeout cancellation. */
  clearTimeoutFn: ClearTimeoutFn;
}

/** Build a deterministic scheduler that records timers and cancellations. */
function createScheduler(): FakeScheduler {
  const scheduled: ScheduledTimer[] = [];
  const cleared: TimeoutHandle[] = [];
  let seq = 0;
  const setTimeoutFn: SetTimeoutFn = (handler, ms) => {
    seq += 1;
    const handle = { unref: () => undefined, id: seq } as unknown as TimeoutHandle;
    scheduled.push({ handler, ms, handle });
    return handle;
  };
  const clearTimeoutFn: ClearTimeoutFn = (handle) => {
    cleared.push(handle);
  };
  return { scheduled, cleared, setTimeoutFn, clearTimeoutFn };
}

/** Find the first scheduled timer with a given delay, failing when absent. */
function findTimer(scheduler: FakeScheduler, ms: number): ScheduledTimer {
  const timer = scheduler.scheduled.find((entry) => entry.ms === ms);
  if (timer === undefined) {
    throw new Error(`no timer scheduled for ${ms}ms`);
  }
  return timer;
}

/** Find the most recently scheduled timer with a given delay, failing when absent. */
function findLastTimer(scheduler: FakeScheduler, ms: number): ScheduledTimer {
  const timer = [...scheduler.scheduled].reverse().find((entry) => entry.ms === ms);
  if (timer === undefined) {
    throw new Error(`no timer scheduled for ${ms}ms`);
  }
  return timer;
}

/** Normalize a tool input into a stable activity for assertions. */
function activity(input: ToolActivityInput): ToolActivity {
  return {
    source: "builtin",
    tool: input.tool,
    action: "Running",
    target: input.filePath,
    phrase: "Let the terminal cook",
  };
}

/** Build a tracker with fake timers and a recording `onModel`. */
function buildTracker(overrides: Partial<SessionTrackerOptions> = {}): {
  tracker: ReturnType<typeof createSessionTracker>;
  scheduler: FakeScheduler;
  models: PresenceModel[];
} {
  const scheduler = createScheduler();
  const models: PresenceModel[] = [];
  const tracker = createSessionTracker({
    config: CONFIG,
    idle: { enabled: false, timeoutMs: 30_000 },
    now: () => 1_000,
    setTimeoutFn: scheduler.setTimeoutFn,
    clearTimeoutFn: scheduler.clearTimeoutFn,
    onModel: (model) => {
      models.push(model);
    },
    resolveActivity: activity,
    rotateActivity: activity,
    rotateMs: 5_000,
    ...overrides,
  });
  return { tracker, scheduler, models };
}

/** Build an assistant `message.updated` payload. */
function assistantMessage(sessionID: string): Message {
  return {
    id: "msg_1",
    sessionID,
    role: "assistant",
    parentID: "msg_user",
    time: { created: 2_000, completed: 2_100 },
    modelID: "claude-3",
    providerID: "anthropic",
    mode: "build",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0.01,
    tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

describe("session tracker rotation cleanup", () => {
  test("stops rotation when a session goes idle", () => {
    const { tracker, scheduler, models } = buildTracker();
    tracker.onSessionCreated("ses_1", "Test session", 0);
    tracker.onToolStart("ses_1", "bash", "pnpm test");
    const rotation = findTimer(scheduler, 5_000);

    tracker.onSessionIdle("ses_1");
    expect(scheduler.cleared).toContain(rotation.handle);

    const count = models.length;
    rotation.handler();
    expect(models.length).toBe(count);
    expect(models.at(-1)?.details).toBe("Idle — ready");
  });

  test("stops rotation when a session errors", () => {
    const { tracker, scheduler, models } = buildTracker();
    tracker.onSessionCreated("ses_1", "Test session", 0);
    tracker.onToolStart("ses_1", "bash", "pnpm test");
    const rotation = findTimer(scheduler, 5_000);

    tracker.onSessionError("ses_1", "Boom");
    expect(scheduler.cleared).toContain(rotation.handle);

    const count = models.length;
    rotation.handler();
    expect(models.length).toBe(count);
    expect(models.at(-1)?.details).toBe("Error");
  });

  test("stops rotation when permission is requested", () => {
    const { tracker, scheduler, models } = buildTracker();
    tracker.onSessionCreated("ses_1", "Test session", 0);
    tracker.onToolStart("ses_1", "bash", "pnpm test");
    const rotation = findTimer(scheduler, 5_000);

    tracker.onPermissionAsked("ses_1", "Approve bash");
    expect(scheduler.cleared).toContain(rotation.handle);

    const count = models.length;
    rotation.handler();
    expect(models.length).toBe(count);
    expect(models.at(-1)?.details).toBe("Waiting for approval");
  });

  test("stops rotation when compacting starts", () => {
    const { tracker, scheduler, models } = buildTracker();
    tracker.onSessionCreated("ses_1", "Test session", 0);
    tracker.onToolStart("ses_1", "bash", "pnpm test");
    const rotation = findTimer(scheduler, 5_000);

    tracker.onCompactingStart("ses_1");
    expect(scheduler.cleared).toContain(rotation.handle);

    // Rotation is stopped even though the FSM keeps `tool-running` (no compacting edge).
    const count = models.length;
    rotation.handler();
    expect(models.length).toBe(count);
  });

  test("stops rotation when the idle timeout fires", () => {
    const { tracker, scheduler, models } = buildTracker({
      idle: { enabled: true, timeoutMs: 30_000 },
    });
    tracker.onSessionCreated("ses_1", "Test session", 0);
    tracker.onToolStart("ses_1", "bash", "pnpm test");
    const rotation = findTimer(scheduler, 5_000);
    const idle = findLastTimer(scheduler, 30_000);

    idle.handler();
    expect(scheduler.cleared).toContain(rotation.handle);

    const count = models.length;
    rotation.handler();
    expect(models.length).toBe(count);
    expect(models.at(-1)?.details).toBe("Idle — ready");
  });
});

describe("session tracker signal priority", () => {
  test("does not downgrade an active tool signal on message.updated", () => {
    const { tracker, scheduler } = buildTracker({
      idle: { enabled: true, timeoutMs: 30_000 },
      rotateMs: 0,
    });
    tracker.onSessionCreated("ses_1", "Test session", 0);
    tracker.onToolStart("ses_1", "bash", "pnpm test");
    tracker.onMessageUpdated(assistantMessage("ses_1"));

    // A `file` part (rank 2) must not be allowed to re-arm while `tool` (rank 3) is active.
    const before = scheduler.scheduled.length;
    tracker.onMessagePart("ses_1", "file");
    expect(scheduler.scheduled.length).toBe(before);
  });

  test("does not downgrade an active permission signal on message.updated", () => {
    const { tracker, scheduler } = buildTracker({
      idle: { enabled: true, timeoutMs: 30_000 },
      rotateMs: 0,
    });
    tracker.onSessionCreated("ses_1", "Test session", 0);
    tracker.onPermissionAsked("ses_1", "Approve bash");
    tracker.onMessageUpdated(assistantMessage("ses_1"));

    const before = scheduler.scheduled.length;
    tracker.onMessagePart("ses_1", "file");
    expect(scheduler.scheduled.length).toBe(before);
  });
});
