/**
 * Session state machine — the six-state presence FSM.
 *
 * Each opencode session owns one machine. Events are mapped to a `SessionStateKind`
 * through the typed `TRANSITIONS` table, then rendered to a `PresenceModel` by
 * `buildPresenceModel` (see `./presence-model.ts`). `dispatch` returns `null` when the
 * rendered model is unchanged so callers can skip the transport push
 * (see `docs/ARCHITECTURE.md` §4).
 */
import type {
  ActivityTypeName,
  PresenceButton,
  PresenceModel,
  SessionStateKind,
  SessionStats,
  ToolActivity,
} from "../types";
import { buildPresenceModel } from "./presence-model";

/** Events the state machine understands; mapped from opencode hooks/events. */
export type StateEvent =
  | { type: "session.created"; sessionID: string; title: string; startedAt?: number }
  | { type: "session.updated"; sessionID: string; title?: string }
  | { type: "session.idle"; sessionID: string }
  | { type: "session.error"; sessionID: string; errorName: string }
  | { type: "message.updated"; sessionID: string; stats: SessionStats }
  | {
      type: "tool.start";
      sessionID: string;
      tool: string;
      filePath?: string;
      activity?: ToolActivity;
      /** Set on rotation ticks so phrase pools advance instead of re-selecting. */
      rotate?: boolean;
    }
  | { type: "tool.end"; sessionID: string }
  | { type: "permission.ask"; sessionID: string; title?: string }
  | { type: "permission.replied"; sessionID: string }
  | { type: "todo.updated"; sessionID: string; done: number; total: number }
  | { type: "compacting.start"; sessionID: string }
  | { type: "compacting.end"; sessionID: string }
  | { type: "session.deleted"; sessionID: string }
  | { type: "idle.timeout"; sessionID: string };

/** A single allowed state transition. */
export interface Transition {
  /** States the transition may fire from. */
  from: readonly SessionStateKind[];
  /** Event type that triggers the transition. */
  on: StateEvent["type"];
  /** Resulting state. */
  to: SessionStateKind;
}

/** Typed transition table (verbatim from `docs/ARCHITECTURE.md` §4.2). */
export const TRANSITIONS: readonly Transition[] = [
  { from: ["idle"], on: "message.updated", to: "active" },
  { from: ["active", "idle"], on: "tool.start", to: "tool-running" },
  { from: ["tool-running"], on: "tool.end", to: "active" },
  {
    from: ["active", "idle", "tool-running"],
    on: "permission.ask",
    to: "waiting-permission",
  },
  { from: ["waiting-permission"], on: "permission.replied", to: "idle" },
  { from: ["active", "idle"], on: "compacting.start", to: "compacting" },
  { from: ["compacting"], on: "compacting.end", to: "idle" },
  {
    from: ["active", "tool-running", "waiting-permission", "compacting", "idle"],
    on: "session.error",
    to: "error",
  },
  { from: ["error"], on: "message.updated", to: "active" },
  {
    from: ["active", "tool-running", "waiting-permission", "compacting", "error"],
    on: "session.idle",
    to: "idle",
  },
  { from: ["active", "tool-running"], on: "idle.timeout", to: "idle" },
];

/** Phrase-pool settings surfaced to the presence builder. */
export interface PresencePhraseConfig {
  /** Custom `details` pool; non-empty overrides `detailsTemplate`. */
  details: string[];
  /** Custom `state` pool; non-empty overrides `stateTemplate`. */
  state: string[];
  /** Pool selection order. */
  mode: "random" | "sequential";
  /** Rotation interval in milliseconds; `0` disables rotation. */
  rotateMs: number;
  /** Minimum gap before a new phrase, in milliseconds. */
  cooldownMs: number;
}

/** Presentation toggles surfaced to the presence builder. */
export interface PresenceDisplayConfig {
  /** Append TODO telemetry to `state`. */
  showTodo: boolean;
  /** Append context telemetry to `state`. */
  showContext: boolean;
  /** Use the session title as `details`. */
  showSessionTitle: boolean;
  /** Keep the provider name on MCP activities. */
  showMcpProvider: boolean;
}

/** Config subset required to render a presence model. */
export interface StateMachineConfig {
  /** Large art asset key. */
  largeImageKey: string;
  /** Large art asset hover text. */
  largeImageText: string;
  /** Optional small overlay asset key. */
  smallImageKey?: string;
  /** Optional small overlay hover text. */
  smallImageText?: string;
  /** Template for `details` while active. */
  detailsTemplate: string;
  /** Template for `state` while active. */
  stateTemplate: string;
  /** Idle presentation settings. */
  idle: { enabled: boolean; details: string; state: string };
  /** Which session stats to surface. */
  sessionStats: {
    showModel: boolean;
    showTokens: boolean;
    showCost: boolean;
    showElapsed: boolean;
  };
  /** Privacy toggles that suppress presence fields. */
  privacy: {
    hideProjectPath: boolean;
    hideModel: boolean;
    hideCost: boolean;
    hideFilePaths: boolean;
  };
  /** Static action buttons (max 2). */
  buttons?: PresenceButton[];
  /** Display name of the project/worktree, when available. */
  projectName?: string;
  /** RPC activity type name; omitted falls back to `playing`. */
  activityType?: ActivityTypeName;
  /** Activity `name` override (best-effort). */
  activityName?: string;
  /** Phrase pools; omitted disables phrase overrides. */
  phrases?: PresencePhraseConfig;
  /** Display toggles; omitted keeps the legacy rendering path. */
  presence?: PresenceDisplayConfig;
  /**
   * Selects the current phrase for a pool; injected by the plugin. The optional
   * `rotate` flag advances the pool instead of re-selecting within cooldown.
   */
  phraseSelector?: (target: "details" | "state", rotate?: boolean) => string;
}

/** Input passed to a presence builder. */
export interface PresenceBuildInput {
  /** Current FSM state. */
  state: SessionStateKind;
  /** Latest session stats. */
  stats: SessionStats;
  /** Previously emitted model, used for continuity and dedupe. */
  previous: PresenceModel | null;
  /** Event that triggered the rebuild. */
  event: StateEvent;
  /** Rendering configuration. */
  config: StateMachineConfig;
  /** Latest todo progress, when known. */
  todos?: { done: number; total: number };
  /** Session title, used as `details` when enabled. */
  sessionTitle?: string;
  /** Normalized activity for the running tool, when known. */
  activity?: ToolActivity;
  /** Whether this rebuild is a phrase rotation tick. */
  rotate?: boolean;
}

/** Pure function that renders a presence model from FSM state. */
export type PresenceBuilder = (input: PresenceBuildInput) => PresenceModel;

/** Default presence builder; re-exported for backward compatibility. */
export const buildDefaultPresence: PresenceBuilder = buildPresenceModel;

/** Per-session state machine contract. */
export interface StateMachine {
  /** opencode session identifier. */
  readonly sessionID: string;
  /** Current FSM state. */
  readonly state: SessionStateKind;
  /**
   * Apply an event and return the new model, or `null` when unchanged.
   *
   * @param event Event to apply.
   */
  dispatch(event: StateEvent): PresenceModel | null;
  /** Return the current model, building the initial one on first access. */
  getModel(): PresenceModel;
  /** Release internal references; further dispatches are no-ops. */
  dispose(): void;
}

/** Construction options for `createStateMachine`. */
export interface StateMachineOptions {
  /** opencode session identifier. */
  sessionID: string;
  /** Rendering configuration. */
  config: StateMachineConfig;
  /** Pre-seeded stats; defaults to a zeroed record. */
  initialStats?: SessionStats;
  /** Custom presence builder; defaults to `buildPresenceModel`. */
  buildPresence?: PresenceBuilder;
  /** Clock injection for deterministic tests; defaults to `Date.now`. */
  now?: () => number;
}

/** Create a zeroed stats record for a session. */
function createInitialStats(sessionID: string, timestamp: number): SessionStats {
  return {
    sessionID,
    providerID: "",
    modelID: "",
    mode: "",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    promptCount: 0,
    startedAt: timestamp,
    lastActivityAt: timestamp,
  };
}

/** Apply event-derived updates to the tracked stats. */
function updateStats(stats: SessionStats, event: StateEvent, timestamp: number): SessionStats {
  if (event.type === "session.created") {
    const startedAt =
      event.startedAt !== undefined && event.startedAt > 0 ? event.startedAt : timestamp;
    return { ...createInitialStats(event.sessionID, startedAt), lastActivityAt: timestamp };
  }
  if (event.type === "message.updated") {
    return {
      ...event.stats,
      startedAt: event.stats.startedAt > 0 ? event.stats.startedAt : stats.startedAt,
      lastActivityAt: timestamp,
    };
  }
  return { ...stats, lastActivityAt: timestamp };
}

/** Resolve the next state for an event, or `undefined` when no row matches. */
function nextState(from: SessionStateKind, type: StateEvent["type"]): SessionStateKind | undefined {
  for (const transition of TRANSITIONS) {
    if (transition.on === type && transition.from.includes(from)) {
      return transition.to;
    }
  }
  return undefined;
}

/** Stable fingerprint used to detect no-op model changes. */
function fingerprint(model: PresenceModel): string {
  return JSON.stringify(model);
}

/**
 * Create a per-session state machine.
 *
 * @param options Session id, rendering config and optional injections.
 * @returns A `StateMachine` that emits presence models on dispatch.
 */
export function createStateMachine(options: StateMachineOptions): StateMachine {
  const config = options.config;
  const now = options.now ?? Date.now;
  const builder = options.buildPresence ?? buildPresenceModel;

  let current: SessionStateKind = "idle";
  let stats: SessionStats = options.initialStats ?? createInitialStats(options.sessionID, now());
  let todos: { done: number; total: number } | undefined;
  let sessionTitle = "";
  let model: PresenceModel | null = null;
  let disposed = false;
  let activeTool: { tool: string; filePath?: string; activity?: ToolActivity } | null = null;
  let lastEvent: StateEvent = {
    type: "session.created",
    sessionID: options.sessionID,
    title: "",
  };

  /**
   * Reuse the active tool identity when an intermediate event arrives while
   * `tool-running`, so the rendered model keeps the tool name, file path and activity.
   */
  function effectiveEvent(event: StateEvent): StateEvent {
    if (current !== "tool-running" || event.type === "tool.start" || activeTool === null) {
      return event;
    }
    return {
      type: "tool.start",
      sessionID: options.sessionID,
      tool: activeTool.tool,
      filePath: activeTool.filePath,
      activity: activeTool.activity,
    };
  }

  const build = (event: StateEvent): PresenceModel =>
    builder({
      state: current,
      stats,
      previous: model,
      event: effectiveEvent(event),
      config,
      todos,
      sessionTitle,
      activity: current === "tool-running" && activeTool !== null ? activeTool.activity : undefined,
      rotate: event.type === "tool.start" ? event.rotate : undefined,
    });

  return {
    sessionID: options.sessionID,
    get state(): SessionStateKind {
      return current;
    },
    dispatch(event: StateEvent): PresenceModel | null {
      if (disposed) {
        return null;
      }
      lastEvent = event;
      const timestamp = now();
      stats = updateStats(stats, event, timestamp);
      if (event.type === "session.created") {
        sessionTitle = event.title;
      } else if (event.type === "session.updated" && event.title !== undefined) {
        sessionTitle = event.title;
      }
      if (event.type === "tool.start") {
        activeTool = { tool: event.tool, filePath: event.filePath, activity: event.activity };
      } else if (event.type === "tool.end") {
        activeTool = null;
      }
      if (event.type === "todo.updated") {
        todos = { done: event.done, total: event.total };
      }
      const next = nextState(current, event.type);
      if (next !== undefined) {
        current = next;
      }
      const candidate = build(event);
      if (model !== null && fingerprint(model) === fingerprint(candidate)) {
        return null;
      }
      model = candidate;
      return candidate;
    },
    getModel(): PresenceModel {
      if (model === null) {
        model = build(lastEvent);
      }
      return model;
    },
    dispose(): void {
      disposed = true;
      model = null;
    },
  };
}
