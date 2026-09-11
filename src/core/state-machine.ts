/**
 * Session state machine — the six-state presence FSM.
 *
 * Each opencode session owns one machine. Events are mapped to a `SessionStateKind`
 * through the typed `TRANSITIONS` table, then rendered to a `PresenceModel`. `dispatch`
 * returns `null` when the rendered model is unchanged so callers can skip the transport
 * push (see `docs/ARCHITECTURE.md` §4).
 */
import type {
  PresenceButton,
  PresenceModel,
  SessionStateKind,
  SessionStats,
  TokenUsage,
} from "../types";

/** Events the state machine understands; mapped from opencode hooks/events. */
export type StateEvent =
  | { type: "session.created"; sessionID: string; title: string; startedAt?: number }
  | { type: "session.idle"; sessionID: string }
  | { type: "session.error"; sessionID: string; errorName: string }
  | { type: "message.updated"; sessionID: string; stats: SessionStats }
  | { type: "tool.start"; sessionID: string; tool: string; filePath?: string }
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
}

/** Pure function that renders a presence model from FSM state. */
export type PresenceBuilder = (input: PresenceBuildInput) => PresenceModel;

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
  /** Custom presence builder; defaults to `buildDefaultPresence`. */
  buildPresence?: PresenceBuilder;
  /** Clock injection for deterministic tests; defaults to `Date.now`. */
  now?: () => number;
}

/** Render a template string, replacing known `{var}` placeholders. */
function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : value;
  });
}

/** Clamp a string to a maximum length using a single ellipsis. */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** Format a USD cost for display. */
function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

/** Sum the token buckets used for display. */
function tokenTotal(tokens: TokenUsage): number {
  return tokens.input + tokens.output + tokens.reasoning;
}

/** Format a token count with k/M suffixes. */
function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}k`;
  }
  return String(count);
}

/** Format an elapsed duration as `Xh YYm`, `Ym Zs` or `Zs`. */
function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

/** Extract the tool name from a `tool.start` event. */
function toolName(event: StateEvent): string | undefined {
  return event.type === "tool.start" ? event.tool : undefined;
}

/** Extract the file path from a `tool.start` event. */
function toolFilePath(event: StateEvent): string | undefined {
  return event.type === "tool.start" ? event.filePath : undefined;
}

/** Extract the permission title from a `permission.ask` event. */
function permissionTitle(event: StateEvent): string | undefined {
  return event.type === "permission.ask" ? event.title : undefined;
}

/** Extract the error name from a `session.error` event. */
function errorName(event: StateEvent): string | undefined {
  return event.type === "session.error" ? event.errorName : undefined;
}

/** Build the template variable map for the current state. */
function buildTemplateVars(input: PresenceBuildInput): Record<string, string> {
  const { stats, event, config, todos } = input;
  const model = config.sessionStats.showModel && !config.privacy.hideModel ? stats.modelID : "";
  const provider = config.privacy.hideModel ? "" : stats.providerID;
  const project = config.privacy.hideProjectPath ? "" : (config.projectName ?? "");
  const file = config.privacy.hideFilePaths ? "" : (toolFilePath(event) ?? "");
  const elapsed = config.sessionStats.showElapsed
    ? formatDuration(stats.lastActivityAt - stats.startedAt)
    : "";
  const cost =
    config.sessionStats.showCost && !config.privacy.hideCost ? formatCost(stats.cost) : "";
  const tokens = config.sessionStats.showTokens ? formatTokens(tokenTotal(stats.tokens)) : "";
  const contextPercent =
    stats.contextTokens !== undefined && stats.contextLimit !== undefined && stats.contextLimit > 0
      ? `${Math.round((stats.contextTokens / stats.contextLimit) * 100)}%`
      : "";
  return {
    model,
    provider,
    project,
    file,
    elapsed,
    cost,
    tokens,
    done: todos ? String(todos.done) : "",
    total: todos ? String(todos.total) : "",
    contextPercent,
  };
}

/** Resolve the primary `details` line for a state. */
function resolveDetails(input: PresenceBuildInput): string {
  const { state, event, config, previous } = input;
  const vars = buildTemplateVars(input);
  switch (state) {
    case "idle":
      return config.idle.enabled
        ? config.idle.details
        : (previous?.details ?? renderTemplate(config.detailsTemplate, vars));
    case "active":
      return renderTemplate(config.detailsTemplate, vars);
    case "tool-running": {
      const tool = toolName(event) ?? "tool";
      const file = config.privacy.hideFilePaths ? "" : toolFilePath(event);
      return file !== undefined && file !== "" ? `Running ${tool} · ${file}` : `Running ${tool}`;
    }
    case "waiting-permission":
      return "Waiting for approval";
    case "compacting":
      return "Compacting context…";
    case "error":
      return "Error";
  }
}

/** Resolve the secondary `state` line for a state. */
function resolveSecondary(input: PresenceBuildInput): string | undefined {
  const { state, event, config, previous } = input;
  const vars = buildTemplateVars(input);
  switch (state) {
    case "idle":
      return config.idle.enabled
        ? renderTemplate(config.idle.state, vars)
        : (previous?.state ?? renderTemplate(config.stateTemplate, vars));
    case "active":
      return renderTemplate(config.stateTemplate, vars);
    case "tool-running":
      return previous?.state ?? renderTemplate(config.stateTemplate, vars);
    case "waiting-permission":
      return permissionTitle(event) ?? "Permission required";
    case "compacting":
      return "Summarizing session";
    case "error":
      return errorName(event) ?? "Unknown error";
  }
}

/** Resolve the small overlay hover text for a state. */
function resolveSmallText(input: PresenceBuildInput): string | undefined {
  const { state, event, config } = input;
  switch (state) {
    case "idle":
      return config.smallImageText;
    case "active":
      return "Thinking…";
    case "tool-running":
      return toolName(event);
    case "waiting-permission":
      return "Permission required";
    case "compacting":
      return "Compacting";
    case "error":
      return errorName(event);
  }
}

/**
 * Default presence builder implementing the per-state field mapping.
 *
 * @param input Current state, stats, event and rendering config.
 * @returns A Discord-facing presence model.
 */
export function buildDefaultPresence(input: PresenceBuildInput): PresenceModel {
  const { stats, config } = input;
  const model: PresenceModel = {
    details: truncate(resolveDetails(input), 128),
    largeImageKey: config.largeImageKey,
    largeImageText: config.largeImageText,
  };

  const secondary = resolveSecondary(input);
  if (secondary !== undefined && secondary !== "") {
    model.state = truncate(secondary, 128);
  }
  if (config.sessionStats.showElapsed) {
    model.startTimestamp = Math.floor(stats.startedAt / 1_000);
  }
  if (config.smallImageKey !== undefined) {
    model.smallImageKey = config.smallImageKey;
  }
  const smallText = resolveSmallText(input);
  if (smallText !== undefined && smallText !== "") {
    model.smallImageText = truncate(smallText, 128);
  }
  if (config.buttons !== undefined && config.buttons.length > 0) {
    model.buttons = config.buttons;
  }
  return model;
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
  const builder = options.buildPresence ?? buildDefaultPresence;

  let current: SessionStateKind = "idle";
  let stats: SessionStats = options.initialStats ?? createInitialStats(options.sessionID, now());
  let todos: { done: number; total: number } | undefined;
  let model: PresenceModel | null = null;
  let disposed = false;
  let activeTool: { tool: string; filePath?: string } | null = null;
  let lastEvent: StateEvent = {
    type: "session.created",
    sessionID: options.sessionID,
    title: "",
  };

  /**
   * Reuse the active tool identity when an intermediate event arrives while
   * `tool-running`, so the rendered model keeps the tool name and file path.
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
      if (event.type === "tool.start") {
        activeTool = { tool: event.tool, filePath: event.filePath };
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
