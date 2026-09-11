/**
 * Presence model — renders the Discord presence from FSM state, tool activity and telemetry.
 *
 * Maps the configured `activityType` to the RPC subset `0/2/3/5` (never `1`/`4`), selects and
 * rotates personality phrases with a `.unref()`-ed timer, and merges context/TODO telemetry
 * into `state` because Discord renders only two text lines (`docs/PRESENCE-DESIGN.md` §16.2).
 */
import {
  type ClearTimeoutFn,
  type SetTimeoutFn,
  type TimeoutHandle,
  unrefTimer,
} from "../discord/transport";
import type {
  ActivityTypeName,
  PresenceModel,
  RpcActivityType,
  TokenUsage,
  ToolActivity,
} from "../types";
import type { PresenceBuildInput, StateEvent, StateMachineConfig } from "./state-machine";

/** Mapping from human-readable activity type to the RPC numeric type. */
const ACTIVITY_TYPE_RPC: Record<ActivityTypeName, RpcActivityType> = {
  playing: 0,
  listening: 2,
  watching: 3,
  competing: 5,
};

/** Configuration pool name used by `StateMachineConfig.phraseSelector`. */
export type PhraseTarget = "details" | "state";

/** Options for a repeating, `.unref()`-ed phrase rotation timer. */
export interface RotationTimerOptions {
  /** Interval in milliseconds; `<= 0` disables rotation. */
  rotateMs: number;
  /** Callback invoked on every rotation tick. */
  onTick: () => void;
  /** Timeout scheduler injection; defaults to the global `setTimeout`. */
  setTimeoutFn?: SetTimeoutFn;
  /** Timeout cancellation injection; defaults to the global `clearTimeout`. */
  clearTimeoutFn?: ClearTimeoutFn;
}

/** Repeating rotation timer that never keeps the process alive. */
export interface RotationTimer {
  /** Start rotating; no-op when `rotateMs <= 0` or already running. */
  start(): void;
  /** Stop rotating and cancel the pending tick. */
  stop(): void;
  /** Stop and release the timer permanently. */
  dispose(): void;
}

/**
 * Map a human-readable activity type to its RPC numeric value.
 *
 * @param name Activity type name from configuration.
 * @returns The RPC type (`0`, `2`, `3` or `5`).
 */
export function activityTypeToRpc(name: ActivityTypeName): RpcActivityType {
  return ACTIVITY_TYPE_RPC[name];
}

/**
 * Create a repeating rotation timer whose handle is always `.unref()`-ed.
 *
 * @param options Interval, tick callback and injectable timer functions.
 * @returns A `RotationTimer` with idempotent `start`/`stop`/`dispose`.
 */
export function createRotationTimer(options: RotationTimerOptions): RotationTimer {
  const schedule = options.setTimeoutFn ?? setTimeout;
  const cancel = options.clearTimeoutFn ?? clearTimeout;
  let handle: TimeoutHandle | null = null;
  let running = false;

  /** Cancel the pending tick, if any. */
  function clear(): void {
    if (handle !== null) {
      cancel(handle);
      handle = null;
    }
  }

  /** Schedule the next tick. */
  function arm(): void {
    handle = schedule(tick, options.rotateMs);
    unrefTimer(handle);
  }

  /** Run one tick and reschedule while still running. */
  function tick(): void {
    handle = null;
    if (!running) {
      return;
    }
    options.onTick();
    if (running) {
      arm();
    }
  }

  return {
    start(): void {
      if (options.rotateMs <= 0 || running) {
        return;
      }
      running = true;
      arm();
    },
    stop(): void {
      running = false;
      clear();
    },
    dispose(): void {
      running = false;
      clear();
    },
  };
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

/** Format a token count with `K`/`M` suffixes. */
export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}K`;
  }
  return String(count);
}

/**
 * Format context telemetry as `150.4K (57%)`.
 *
 * @param used Context tokens currently used; `undefined`/`0` omits the segment.
 * @param limit Model context window; when unknown only the used count is shown.
 * @returns The telemetry segment, or an empty string when unavailable.
 */
export function formatContextTelemetry(used?: number, limit?: number): string {
  if (used === undefined || used <= 0) {
    return "";
  }
  const formatted = formatTokenCount(used);
  if (limit === undefined || limit <= 0) {
    return formatted;
  }
  return `${formatted} (${Math.round((used / limit) * 100)}%)`;
}

/**
 * Format TODO telemetry as `TODO 4/9`.
 *
 * @param done Completed item count.
 * @param total Total item count; `<= 0` omits the segment.
 * @returns The telemetry segment, or an empty string when unavailable.
 */
export function formatTodoTelemetry(done: number, total: number): string {
  if (total <= 0) {
    return "";
  }
  return `TODO ${done}/${total}`;
}

/**
 * Merge telemetry segments into a base `state` line.
 *
 * @param base Base state text (may be empty).
 * @param segments Telemetry segments to append.
 * @returns The merged line, or `undefined` when both are empty.
 */
export function mergeTelemetry(
  base: string | undefined,
  segments: readonly string[],
): string | undefined {
  const parts = segments.filter((segment) => segment !== "");
  const head = base ?? "";
  if (parts.length === 0) {
    return head === "" ? undefined : head;
  }
  return head === "" ? parts.join(" • ") : `${head} • ${parts.join(" • ")}`;
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
  const tokens = config.sessionStats.showTokens ? formatTokenCount(tokenTotal(stats.tokens)) : "";
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

/** Resolve the effective template for a pool, preferring the configured phrase. */
function resolveTemplate(
  input: PresenceBuildInput,
  target: PhraseTarget,
  fallback: string,
): string {
  const phrases =
    target === "details" ? input.config.phrases?.details : input.config.phrases?.state;
  if (phrases !== undefined && phrases.length > 0 && input.config.phraseSelector !== undefined) {
    const selected = input.config.phraseSelector(target, input.rotate);
    if (selected !== "") {
      return selected;
    }
  }
  return fallback;
}

/** Resolve the `details` line for a state. */
function resolveDetails(input: PresenceBuildInput, modern: boolean): string {
  const { state, event, config, previous } = input;
  const vars = buildTemplateVars(input);
  const template = resolveTemplate(input, "details", config.detailsTemplate);
  switch (state) {
    case "idle":
      return config.idle.enabled
        ? config.idle.details
        : (previous?.details ?? renderTemplate(template, vars));
    case "active":
      return modern && showSessionTitle(input)
        ? (input.sessionTitle ?? "")
        : renderTemplate(template, vars);
    case "tool-running": {
      if (modern && showSessionTitle(input)) {
        return input.sessionTitle ?? "";
      }
      const tool = toolName(event) ?? "tool";
      const file = config.privacy.hideFilePaths ? undefined : toolFilePath(event);
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

/** Whether the session title should be surfaced as `details`. */
function showSessionTitle(input: PresenceBuildInput): boolean {
  const enabled = input.config.presence?.showSessionTitle ?? false;
  return enabled && input.sessionTitle !== undefined && input.sessionTitle !== "";
}

/** Render a tool activity as `<Action> [target] • <Phrase>`. */
function renderActivity(activity: ToolActivity, config: StateMachineConfig): string {
  if (activity.source === "mcp") {
    const showProvider = config.presence?.showMcpProvider ?? true;
    const head = showProvider && activity.provider !== undefined ? `${activity.provider} • ` : "";
    return activity.phrase === ""
      ? `${head}${activity.action}`
      : `${head}${activity.action} • ${activity.phrase}`;
  }
  const target = config.privacy.hideFilePaths ? undefined : activity.target;
  const action =
    target !== undefined && target !== "" ? `${activity.action} ${target}` : activity.action;
  return activity.phrase === "" ? action : `${action} • ${activity.phrase}`;
}

/** Build the telemetry segments for the current state. */
function telemetrySegments(input: PresenceBuildInput, modern: boolean): string[] {
  if (!modern) {
    return [];
  }
  const presence = input.config.presence;
  const segments: string[] = [];
  if (presence?.showContext) {
    const context = formatContextTelemetry(input.stats.contextTokens, input.stats.contextLimit);
    if (context !== "") {
      segments.push(context);
    }
  }
  if (presence?.showTodo && input.todos !== undefined) {
    const todo = formatTodoTelemetry(input.todos.done, input.todos.total);
    if (todo !== "") {
      segments.push(todo);
    }
  }
  return segments;
}

/** Resolve the `state` line for a state. */
function resolveSecondary(input: PresenceBuildInput, modern: boolean): string | undefined {
  const { state, event, config, previous } = input;
  const vars = buildTemplateVars(input);
  const template = resolveTemplate(input, "state", config.stateTemplate);
  switch (state) {
    case "idle": {
      const base = config.idle.enabled
        ? renderTemplate(config.idle.state, vars)
        : (previous?.state ?? renderTemplate(template, vars));
      return modern ? mergeTelemetry(base, telemetrySegments(input, modern)) : base;
    }
    case "active":
      return modern
        ? mergeTelemetry(renderTemplate(template, vars), telemetrySegments(input, modern))
        : renderTemplate(template, vars);
    case "tool-running": {
      if (!modern) {
        return previous?.state ?? renderTemplate(template, vars);
      }
      const base =
        input.activity !== undefined
          ? renderActivity(input.activity, config)
          : renderTemplate(template, vars);
      return mergeTelemetry(base, telemetrySegments(input, modern));
    }
    case "waiting-permission":
      return modern
        ? mergeTelemetry(
            permissionTitle(event) ?? "Permission required",
            telemetrySegments(input, modern),
          )
        : (permissionTitle(event) ?? "Permission required");
    case "compacting":
      return modern
        ? mergeTelemetry("Summarizing session", telemetrySegments(input, modern))
        : "Summarizing session";
    case "error":
      return modern
        ? mergeTelemetry(errorName(event) ?? "Unknown error", telemetrySegments(input, modern))
        : (errorName(event) ?? "Unknown error");
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
      return input.activity !== undefined ? input.activity.action : toolName(event);
    case "waiting-permission":
      return "Permission required";
    case "compacting":
      return "Compacting";
    case "error":
      return errorName(event);
  }
}

/**
 * Build a Discord presence model from FSM state, stats and optional activity/telemetry.
 *
 * @param input Current state, stats, event, rendering config and optional telemetry.
 * @returns A Discord-facing presence model.
 */
export function buildPresenceModel(input: PresenceBuildInput): PresenceModel {
  const { stats, config } = input;
  const modern = config.presence !== undefined;
  const model: PresenceModel = {
    details: truncate(resolveDetails(input, modern), 128),
    largeImageKey: config.largeImageKey,
    largeImageText: config.largeImageText,
  };

  const secondary = resolveSecondary(input, modern);
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
  if (config.activityType !== undefined) {
    model.activityType = activityTypeToRpc(config.activityType);
  }
  if (config.activityName !== undefined && config.activityName !== "") {
    model.activityName = config.activityName;
  }
  return model;
}
