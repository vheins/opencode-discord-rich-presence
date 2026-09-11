/**
 * Shared domain types for the opencode Discord Rich Presence plugin.
 *
 * Boundary contracts consumed by config, core and (later) the Discord transport.
 * Mirrors the boundary interfaces in `docs/ARCHITECTURE.md` §2.1.
 */
import type { PluginInput as SdkPluginInput } from "@opencode-ai/plugin";

/**
 * Narrowed plugin context passed into every module.
 *
 * Only the fields the plugin actually uses are kept so modules stay testable.
 */
export type PluginDeps = Pick<SdkPluginInput, "client" | "project" | "directory" | "worktree">;

/** Token accounting shape as exposed by the opencode root SDK. */
export interface TokenUsage {
  /** Prompt tokens consumed. */
  input: number;
  /** Completion tokens produced. */
  output: number;
  /** Reasoning tokens produced. */
  reasoning: number;
  /** Prompt cache read/write counters. */
  cache: { read: number; write: number };
}

/** Aggregated per-session statistics used to render presence text. */
export interface SessionStats {
  /** opencode session identifier. */
  sessionID: string;
  /** Active provider identifier, e.g. `"anthropic"`. */
  providerID: string;
  /** Active model identifier, e.g. `"claude-sonnet-4"`. */
  modelID: string;
  /** Active agent mode, e.g. `"build"`. */
  mode: string;
  /** Accumulated cost in USD for the tracked message. */
  cost: number;
  /** Latest token snapshot for the session. */
  tokens: TokenUsage;
  /** Number of user prompts observed in the session. */
  promptCount: number;
  /** Epoch milliseconds when the session was first observed. */
  startedAt: number;
  /** Epoch milliseconds of the most recent observed activity. */
  lastActivityAt: number;
  /** Current context token usage, when known. */
  contextTokens?: number;
  /** Model context window size, when known. */
  contextLimit?: number;
}

/** A Discord Rich Presence button (max 2, `https://` only). */
export interface PresenceButton {
  /** Button label, 1..32 characters. */
  label: string;
  /** Destination URL, 1..512 characters, must start with `https://`. */
  url: string;
}

/** RPC activity types accepted by Discord (`0/2/3/5`; `1` and `4` are invalid). */
export type RpcActivityType = 0 | 2 | 3 | 5;

/** Human-readable activity type names mapped onto `RpcActivityType`. */
export type ActivityTypeName = "playing" | "listening" | "watching" | "competing";

/** Normalized representation of the tool the agent is currently running. */
export interface ToolActivity {
  /** Where the tool came from. */
  source: "builtin" | "custom" | "mcp";
  /** Provider label for MCP tools, e.g. `"GitHub"`. */
  provider?: string;
  /** Raw tool identifier (provider prefix stripped for MCP). */
  tool: string;
  /** Human-readable action, e.g. `"Reading"`. */
  action: string;
  /** Optional action target, e.g. a file name. */
  target?: string;
  /** Personality phrase appended after ` • `. */
  phrase: string;
}

/** Discord party block, used for TODO progress (`(4 of 9)`). */
export interface PresenceParty {
  /** Party identifier. */
  id?: string;
  /** `[current, max]` member counts. */
  size?: [number, number];
}

/** Discord-facing presence payload produced by the state machine. */
export interface PresenceModel {
  /** Primary activity line. */
  details: string;
  /** Secondary activity line. */
  state?: string;
  /** Activity start time in epoch seconds (RPC uses seconds). */
  startTimestamp?: number;
  /** Large art asset key. */
  largeImageKey: string;
  /** Large art asset hover text. */
  largeImageText: string;
  /** Small overlay asset key. */
  smallImageKey?: string;
  /** Small overlay asset hover text. */
  smallImageText?: string;
  /** Up to two action buttons. */
  buttons?: PresenceButton[];
  /** Discord `instance` flag. */
  instance?: boolean;
  /** RPC activity type (`0/2/3/5`); defaults to `0` when omitted. */
  activityType?: RpcActivityType;
  /** Activity `name` override, best-effort (`docs/PRESENCE-DESIGN.md` §16.1). */
  activityName?: string;
  /** Optional party block (TODO progress). */
  party?: PresenceParty;
}

/** The six lifecycle states a session can occupy. */
export type SessionStateKind =
  | "idle"
  | "active"
  | "tool-running"
  | "waiting-permission"
  | "compacting"
  | "error";
