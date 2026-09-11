/**
 * Presence model tests — RPC type mapping, telemetry merge and rotation timers.
 */
import { describe, expect, test } from "bun:test";
import type { ActivityType } from "../discord/presence";
import { validateActivity } from "../discord/presence";
import type { TimeoutHandle } from "../discord/transport";
import type { RpcActivityType, SessionStats } from "../types";
import {
  activityTypeToRpc,
  buildPresenceModel,
  createRotationTimer,
  formatContextTelemetry,
  formatTodoTelemetry,
  mergeTelemetry,
} from "./presence-model";
import type { PresenceBuildInput, StateMachineConfig } from "./state-machine";

/** Minimal rendering config for the modern (presence-enabled) path. */
function config(overrides: Partial<StateMachineConfig> = {}): StateMachineConfig {
  return {
    largeImageKey: "opencode",
    largeImageText: "opencode",
    detailsTemplate: "Working with {model}",
    stateTemplate: "{cost} · {tokens} tokens",
    idle: { enabled: true, details: "Idle — ready", state: "Ready" },
    sessionStats: { showModel: true, showTokens: true, showCost: true, showElapsed: true },
    privacy: { hideProjectPath: false, hideModel: false, hideCost: false, hideFilePaths: false },
    presence: { showTodo: true, showContext: true, showSessionTitle: true, showMcpProvider: true },
    ...overrides,
  };
}

/** Minimal session stats fixture. */
function stats(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    sessionID: "ses_test",
    providerID: "anthropic",
    modelID: "claude-3",
    mode: "build",
    cost: 0.01,
    tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    promptCount: 1,
    startedAt: 1_000,
    lastActivityAt: 2_000,
    ...overrides,
  };
}

/** Build a tool-running presence input with an optional activity and todos. */
function toolInput(overrides: Partial<PresenceBuildInput> = {}): PresenceBuildInput {
  return {
    state: "tool-running",
    stats: stats({ contextTokens: 150_400, contextLimit: 263_000 }),
    previous: null,
    event: { type: "tool.start", sessionID: "ses_test", tool: "read", filePath: "a.ts" },
    config: config(),
    sessionTitle: "Test session",
    activity: {
      source: "builtin",
      tool: "read",
      action: "Reading",
      target: "a.ts",
      phrase: "Tracing the code",
    },
    ...overrides,
  };
}

describe("activity type mapping", () => {
  test("maps the four configured names to the RPC subset only", () => {
    expect(activityTypeToRpc("playing")).toBe(0);
    expect(activityTypeToRpc("listening")).toBe(2);
    expect(activityTypeToRpc("watching")).toBe(3);
    expect(activityTypeToRpc("competing")).toBe(5);
  });

  test("never produces the invalid RPC types 1 or 4", () => {
    const mapped: RpcActivityType[] = (
      ["playing", "listening", "watching", "competing"] as const
    ).map((name) => activityTypeToRpc(name));
    expect(mapped).not.toContain(1 as RpcActivityType);
    expect(mapped).not.toContain(4 as RpcActivityType);
  });

  test("rejects invalid activity types at the Discord boundary", () => {
    expect(() => validateActivity({ type: 2 })).not.toThrow();
    expect(() => validateActivity({ type: 1 as ActivityType })).toThrow(RangeError);
    expect(() => validateActivity({ type: 4 as ActivityType })).toThrow(RangeError);
  });
});

describe("buildPresenceModel", () => {
  test("sets the mapped activity type and name", () => {
    const model = buildPresenceModel(
      toolInput({ config: config({ activityType: "listening", activityName: "Spotify" }) }),
    );
    expect(model.activityType).toBe(2);
    expect(model.activityName).toBe("Spotify");
  });

  test("merges context and TODO telemetry into the state line", () => {
    const model = buildPresenceModel(toolInput({ todos: { done: 4, total: 9 } }));
    expect(model.details).toBe("Test session");
    expect(model.state).toBe("Reading a.ts • Tracing the code • 150.4K (57%) • TODO 4/9");
  });

  test("omits telemetry when disabled", () => {
    const model = buildPresenceModel(
      toolInput({
        todos: { done: 4, total: 9 },
        config: config({
          presence: {
            showTodo: false,
            showContext: false,
            showSessionTitle: true,
            showMcpProvider: true,
          },
        }),
      }),
    );
    expect(model.state).toBe("Reading a.ts • Tracing the code");
  });
});

describe("telemetry formatting", () => {
  test("formats context telemetry and never shows a 0% fallback", () => {
    expect(formatContextTelemetry(150_400, 263_000)).toBe("150.4K (57%)");
    expect(formatContextTelemetry(150_400)).toBe("150.4K");
    expect(formatContextTelemetry(0, 263_000)).toBe("");
    expect(formatContextTelemetry(undefined, 263_000)).toBe("");
  });

  test("formats TODO telemetry and merges segments", () => {
    expect(formatTodoTelemetry(4, 9)).toBe("TODO 4/9");
    expect(formatTodoTelemetry(0, 0)).toBe("");
    expect(mergeTelemetry("base", ["a", "", "b"])).toBe("base • a • b");
    expect(mergeTelemetry(undefined, [])).toBeUndefined();
    expect(mergeTelemetry("base", [])).toBe("base");
  });
});

describe("rotation timer", () => {
  test("schedules, unrefs, reschedules, clears and disposes", () => {
    const handles: Array<{ fire: () => void; ms: number; handle: TimeoutHandle }> = [];
    const cleared: TimeoutHandle[] = [];
    let unrefs = 0;
    let ticks = 0;

    const timer = createRotationTimer({
      rotateMs: 5_000,
      onTick: () => {
        ticks += 1;
      },
      setTimeoutFn: (handler, ms) => {
        const handle = {
          unref: () => {
            unrefs += 1;
          },
        } as unknown as TimeoutHandle;
        handles.push({ fire: handler, ms, handle });
        return handle;
      },
      clearTimeoutFn: (handle) => {
        cleared.push(handle);
      },
    });

    timer.start();
    expect(handles).toHaveLength(1);
    expect(handles[0]?.ms).toBe(5_000);
    expect(unrefs).toBe(1);

    handles[0]?.fire();
    expect(ticks).toBe(1);
    expect(handles).toHaveLength(2);

    timer.stop();
    expect(cleared).toHaveLength(1);
    timer.start();
    timer.dispose();
    expect(cleared.length).toBeGreaterThanOrEqual(2);
  });

  test("is a no-op when rotation is disabled", () => {
    let scheduled = 0;
    const timer = createRotationTimer({
      rotateMs: 0,
      onTick: () => undefined,
      setTimeoutFn: () => {
        scheduled += 1;
        return 0 as unknown as TimeoutHandle;
      },
    });
    timer.start();
    expect(scheduled).toBe(0);
    timer.dispose();
  });
});
