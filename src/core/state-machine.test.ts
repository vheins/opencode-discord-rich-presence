/**
 * State machine tests — focused on retaining tool context while `tool-running`.
 */
import { describe, expect, test } from "bun:test";
import { createStateMachine, type StateMachineConfig } from "./state-machine";

/** Rendering config that exposes tool file paths for assertions. */
const CONFIG: StateMachineConfig = {
  largeImageKey: "opencode",
  largeImageText: "opencode",
  detailsTemplate: "Working with {model}",
  stateTemplate: "{cost} · {tokens} tokens",
  idle: { enabled: true, details: "Idle — ready", state: "Ready" },
  sessionStats: { showModel: true, showTokens: true, showCost: true, showElapsed: false },
  privacy: { hideProjectPath: false, hideModel: false, hideCost: false, hideFilePaths: false },
};

describe("createStateMachine tool context", () => {
  test("retains the active tool name and file path across intermediate events", () => {
    const machine = createStateMachine({ sessionID: "ses_tool", config: CONFIG });

    const started = machine.dispatch({
      type: "tool.start",
      sessionID: "ses_tool",
      tool: "read",
      filePath: "src/foo.ts",
    });
    expect(started?.details).toBe("Running read · src/foo.ts");

    const afterTodo = machine.dispatch({
      type: "todo.updated",
      sessionID: "ses_tool",
      done: 1,
      total: 3,
    });
    expect(afterTodo).toBeNull();
    expect(machine.state).toBe("tool-running");
    expect(machine.getModel().details).toBe("Running read · src/foo.ts");
  });

  test("drops the retained tool context on tool.end", () => {
    const machine = createStateMachine({ sessionID: "ses_tool", config: CONFIG });

    machine.dispatch({
      type: "tool.start",
      sessionID: "ses_tool",
      tool: "edit",
      filePath: "src/bar.ts",
    });
    machine.dispatch({ type: "tool.end", sessionID: "ses_tool" });

    expect(machine.state).toBe("active");
    expect(machine.getModel().details).not.toBe("Running edit · src/bar.ts");
  });
});
