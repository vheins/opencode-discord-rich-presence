/**
 * Session tracker — owns one state machine per opencode session and picks the active one.
 *
 * Keeps per-session stats, drives state-machine transitions, and emits the active session's
 * presence model through the `onModel` callback. Multi-session selection uses last activity
 * ("last-wins") within the process; cross-process leader election is not implemented
 * (docs/ARCHITECTURE.md §7).
 */
import type { Message, Todo } from "@opencode-ai/sdk";
import {
  type ClearTimeoutFn,
  type SetTimeoutFn,
  type TimeoutHandle,
  unrefTimer,
} from "../discord/transport";
import type { PresenceModel, SessionStats, TokenUsage } from "../types";
import {
  createStateMachine,
  type StateEvent,
  type StateMachine,
  type StateMachineConfig,
} from "./state-machine";

/** Construction options for a session tracker. */
export interface SessionTrackerOptions {
  /** State-machine configuration derived from the resolved config. */
  config: StateMachineConfig;
  /** Idle timeout behavior. */
  idle: { enabled: boolean; timeoutMs: number };
  /** Clock injection; defaults to `Date.now`. */
  now?: () => number;
  /** Timeout scheduler injection; defaults to the global `setTimeout`. */
  setTimeoutFn?: SetTimeoutFn;
  /** Timeout cancellation injection; defaults to the global `clearTimeout`. */
  clearTimeoutFn?: ClearTimeoutFn;
  /** Called with the active session's presence model on every visible change. */
  onModel: (model: PresenceModel) => void;
  /** Called when the active session disappears and presence should be cleared. */
  onClear?: () => void;
}

/** Tracks per-session state and emits presence models for the active session. */
export interface SessionTracker {
  /** Track a new session and make it active. */
  onSessionCreated(sessionID: string, title: string, startedAt?: number): void;
  /** Refresh the active presence after a session metadata change. */
  onSessionUpdated(sessionID: string): void;
  /** Transition a session to idle. */
  onSessionIdle(sessionID: string): void;
  /** Transition a session to the error state. */
  onSessionError(sessionID: string, errorName: string): void;
  /** Drop a session; clears presence when it was the active one. */
  onSessionDeleted(sessionID: string): void;
  /** Replace session stats from an assistant/user message. */
  onMessageUpdated(message: Message): void;
  /** Refresh activity for a streaming message part without changing stats. */
  onMessagePart(sessionID: string): void;
  /** Update todo progress for a session. */
  onTodoUpdated(sessionID: string, todos: readonly Todo[]): void;
  /** Transition a session to waiting-for-permission. */
  onPermissionAsked(sessionID: string, title?: string): void;
  /** Resume a session after a permission decision. */
  onPermissionReplied(sessionID: string): void;
  /** Transition a session to compacting. */
  onCompactingStart(sessionID: string): void;
  /** Leave the compacting state. */
  onCompactingEnd(sessionID: string): void;
  /** Transition a session to running a tool. */
  onToolStart(sessionID: string, tool: string, filePath?: string): void;
  /** Finish the running tool and return to active. */
  onToolEnd(sessionID: string): void;
  /** Dispose every state machine and cancel the idle timer. */
  dispose(): void;
}

/** Create a session tracker. */
export function createSessionTracker(options: SessionTrackerOptions): SessionTracker {
  const now = options.now ?? Date.now;
  const scheduleTimeout = options.setTimeoutFn ?? setTimeout;
  const cancelTimeout = options.clearTimeoutFn ?? clearTimeout;
  const machines = new Map<string, StateMachine>();
  const stats = new Map<string, SessionStats>();
  let activeSessionID: string | null = null;
  let idleHandle: TimeoutHandle | null = null;

  /** Cancel the idle timer. */
  function clearIdle(): void {
    if (idleHandle !== null) {
      cancelTimeout(idleHandle);
      idleHandle = null;
    }
  }

  /** (Re)arm the idle timer for the active session. */
  function armIdle(): void {
    if (!options.idle.enabled) {
      return;
    }
    clearIdle();
    idleHandle = scheduleTimeout(() => {
      idleHandle = null;
      const sessionID = activeSessionID;
      if (sessionID === null) {
        return;
      }
      const machine = machines.get(sessionID);
      if (machine !== undefined) {
        apply(machine, { type: "idle.timeout", sessionID });
      }
    }, options.idle.timeoutMs);
    unrefTimer(idleHandle);
  }

  /** Dispatch an event and forward the active session's model when it changes. */
  function apply(machine: StateMachine, event: StateEvent): void {
    const model = machine.dispatch(event);
    if (activeSessionID !== null && machine.sessionID !== activeSessionID) {
      return;
    }
    if (event.type !== "idle.timeout") {
      armIdle();
    }
    if (model !== null) {
      options.onModel(model);
    }
  }

  /** Return the machine for a session, creating it on first sight. */
  function ensureMachine(sessionID: string): StateMachine {
    const existing = machines.get(sessionID);
    if (existing !== undefined) {
      return existing;
    }
    const machine = createStateMachine({
      sessionID,
      config: options.config,
      now,
      initialStats: stats.get(sessionID),
    });
    machines.set(sessionID, machine);
    return machine;
  }

  /** Mark a session active and reset its idle countdown. */
  function setActive(sessionID: string): void {
    activeSessionID = sessionID;
    armIdle();
  }

  /** Pick the most recently active tracked session. */
  function pickActive(): string | null {
    let best: string | null = null;
    let bestAt = Number.NEGATIVE_INFINITY;
    for (const [sessionID, entry] of stats) {
      if (entry.lastActivityAt >= bestAt) {
        bestAt = entry.lastActivityAt;
        best = sessionID;
      }
    }
    return best;
  }

  /** Emit the current active session's model, if any. */
  function pushActiveModel(): void {
    if (activeSessionID === null) {
      return;
    }
    const machine = machines.get(activeSessionID);
    if (machine !== undefined) {
      options.onModel(machine.getModel());
    }
  }

  /** Remove a session and fall back to the next most recent one. */
  function removeSession(sessionID: string): void {
    const machine = machines.get(sessionID);
    if (machine !== undefined) {
      machine.dispose();
    }
    machines.delete(sessionID);
    stats.delete(sessionID);
    if (activeSessionID !== sessionID) {
      return;
    }
    activeSessionID = pickActive();
    if (activeSessionID === null) {
      clearIdle();
      options.onClear?.();
      return;
    }
    pushActiveModel();
    armIdle();
  }

  /** Merge an opencode message into per-session stats. */
  function buildStats(message: Message, sessionID: string): SessionStats {
    const previous = stats.get(sessionID);
    if (message.role === "assistant") {
      return {
        sessionID,
        providerID: message.providerID,
        modelID: message.modelID,
        mode: message.mode,
        cost: message.cost,
        tokens: message.tokens,
        promptCount: previous?.promptCount ?? 0,
        startedAt: previous?.startedAt ?? message.time.created,
        lastActivityAt: now(),
        contextTokens: previous?.contextTokens,
        contextLimit: previous?.contextLimit,
      };
    }
    return {
      sessionID,
      providerID: message.model.providerID,
      modelID: message.model.modelID,
      mode: previous?.mode ?? "",
      cost: previous?.cost ?? 0,
      tokens: previous?.tokens ?? emptyTokens(),
      promptCount: (previous?.promptCount ?? 0) + 1,
      startedAt: previous?.startedAt ?? message.time.created,
      lastActivityAt: now(),
      contextTokens: previous?.contextTokens,
      contextLimit: previous?.contextLimit,
    };
  }

  return {
    onSessionCreated(sessionID, title, startedAt) {
      const machine = ensureMachine(sessionID);
      setActive(sessionID);
      apply(machine, { type: "session.created", sessionID, title, startedAt });
    },
    onSessionUpdated(sessionID) {
      if (activeSessionID === sessionID) {
        pushActiveModel();
      }
    },
    onSessionIdle(sessionID) {
      const machine = machines.get(sessionID);
      if (machine !== undefined) {
        apply(machine, { type: "session.idle", sessionID });
      }
    },
    onSessionError(sessionID, errorName) {
      const machine = ensureMachine(sessionID);
      apply(machine, { type: "session.error", sessionID, errorName });
    },
    onSessionDeleted(sessionID) {
      removeSession(sessionID);
    },
    onMessageUpdated(message) {
      const machine = ensureMachine(message.sessionID);
      const nextStats = buildStats(message, message.sessionID);
      stats.set(message.sessionID, nextStats);
      setActive(message.sessionID);
      apply(machine, {
        type: "message.updated",
        sessionID: message.sessionID,
        stats: nextStats,
      });
    },
    onMessagePart(sessionID) {
      const machine = machines.get(sessionID);
      const current = stats.get(sessionID);
      if (machine !== undefined && current !== undefined) {
        apply(machine, { type: "message.updated", sessionID, stats: current });
      }
    },
    onTodoUpdated(sessionID, todos) {
      const machine = machines.get(sessionID);
      if (machine === undefined) {
        return;
      }
      const done = todos.filter((todo) => todo.status === "completed").length;
      apply(machine, { type: "todo.updated", sessionID, done, total: todos.length });
    },
    onPermissionAsked(sessionID, title) {
      const machine = ensureMachine(sessionID);
      setActive(sessionID);
      apply(machine, { type: "permission.ask", sessionID, title });
    },
    onPermissionReplied(sessionID) {
      const machine = machines.get(sessionID);
      if (machine !== undefined) {
        apply(machine, { type: "permission.replied", sessionID });
      }
    },
    onCompactingStart(sessionID) {
      const machine = ensureMachine(sessionID);
      setActive(sessionID);
      apply(machine, { type: "compacting.start", sessionID });
    },
    onCompactingEnd(sessionID) {
      const machine = machines.get(sessionID);
      if (machine !== undefined) {
        apply(machine, { type: "compacting.end", sessionID });
      }
    },
    onToolStart(sessionID, tool, filePath) {
      const machine = ensureMachine(sessionID);
      setActive(sessionID);
      apply(machine, { type: "tool.start", sessionID, tool, filePath });
    },
    onToolEnd(sessionID) {
      const machine = machines.get(sessionID);
      if (machine !== undefined) {
        apply(machine, { type: "tool.end", sessionID });
      }
    },
    dispose() {
      clearIdle();
      for (const machine of machines.values()) {
        machine.dispose();
      }
      machines.clear();
      stats.clear();
      activeSessionID = null;
    },
  };
}

/** Create a zeroed token usage record. */
function emptyTokens(): TokenUsage {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
}
