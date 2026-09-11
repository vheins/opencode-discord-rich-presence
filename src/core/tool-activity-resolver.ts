/**
 * Tool activity resolver — normalizes built-in, custom and MCP tools to `ToolActivity`.
 *
 * Built-in tools map to a fixed action plus a personality phrase pool; custom tools fall
 * back to a generic `Running <tool>` action; MCP tools are parsed generically from
 * `mcp__<provider>__<tool>` so unknown servers need no engine change. Phrase selection
 * (`random`/`sequential`) and the cooldown gate live here (`docs/PRESENCE-DESIGN.md` §§5–7).
 */
import type { ToolActivity } from "../types";

/** Built-in personality phrase categories (`docs/PRESENCE-DESIGN.md` §7). */
export type PhrasePool = "reading" | "coding" | "terminal" | "searching" | "documentation" | "mcp";

/** Phrase selection order. */
export type PhraseMode = "random" | "sequential";

/** Seed phrase pools; user pools override the matching template (see `presence-model.ts`). */
export const PHRASE_POOLS: Record<PhrasePool, readonly string[]> = {
  reading: [
    "Tracing the code",
    "Reading between the lines",
    "Following the dependency trail",
    "Exploring the implementation",
  ],
  coding: [
    "Shaping the code",
    "Sculpting the architecture",
    "Making the changes",
    "Building the next piece",
    "Turning ideas into code",
  ],
  terminal: [
    "Let the terminal cook",
    "Command line sorcery",
    "Executing the plan",
    "Talking to the shell",
  ],
  searching: [
    "Following the trail",
    "Connecting the dots",
    "Looking for the missing piece",
    "Exploring the codebase",
  ],
  documentation: [
    "Looking beyond the code",
    "Consulting the archives",
    "Searching for answers",
    "Checking the documentation",
  ],
  mcp: [
    "Connecting external systems",
    "Talking to the tools",
    "Bridging the gap",
    "Calling in reinforcements",
    "Working across the stack",
  ],
};

/** Fixed phrase used when an MCP provider/tool cannot be classified. */
export const MCP_FALLBACK_PHRASE = "Connecting the dots";

/** Prefix that marks an MCP tool name. */
const MCP_PREFIX = "mcp__";

/**
 * Target classification used for privacy.
 *
 * `file` targets are shown unless `hideFilePaths` is set; `command` targets are
 * additionally suppressed so raw shell commands never reach the presence model.
 */
type TargetKind = "file" | "command";

/** Built-in tool metadata: action verb, phrase pool and whether it carries a target. */
interface BuiltinTool {
  /** Human-readable action verb. */
  action: string;
  /** Personality phrase pool. */
  pool: PhrasePool;
  /** Whether the tool's target should be appended to the action. */
  target: boolean;
  /** Target classification; defaults to `file`. */
  targetKind?: TargetKind;
}

/** Built-in tool table (`docs/PRESENCE-DESIGN.md` §5.2). */
const BUILTIN_TOOLS: Record<string, BuiltinTool> = {
  read: { action: "Reading", pool: "reading", target: true },
  edit: { action: "Editing", pool: "coding", target: true },
  write: { action: "Writing", pool: "coding", target: true },
  bash: { action: "Running", pool: "terminal", target: true, targetKind: "command" },
  grep: { action: "Searching", pool: "searching", target: true },
  glob: { action: "Exploring", pool: "searching", target: true },
  lsp: { action: "Analyzing", pool: "searching", target: false },
  patch: { action: "Applying", pool: "coding", target: true },
  todo: { action: "Updating TODO", pool: "documentation", target: false },
  task: { action: "Delegating task", pool: "documentation", target: false },
};

/** Known MCP provider labels; unknown providers are title-cased generically. */
const MCP_PROVIDER_LABELS: Record<string, string> = {
  github: "GitHub",
  playwright: "Playwright",
  postgres: "Postgres",
  postgresql: "Postgres",
};

/** Known MCP tool actions; unknown tools fall back to `Running <tool>`. */
const MCP_TOOL_ACTIONS: Record<string, string> = {
  search_code: "Searching repository",
  create_pull_request: "Creating pull request",
  browser_navigate: "Opening browser",
  query: "Querying database",
};

/** Input describing the tool that just started. */
export interface ToolActivityInput {
  /** Raw tool name as reported by opencode. */
  tool: string;
  /** Optional file path argument (built-in file tools). */
  filePath?: string;
  /** Optional explicit target (bash command, grep pattern). */
  target?: string;
}

/** Construction options for `createToolActivityResolver`. */
export interface ToolActivityResolverOptions {
  /** Phrase selection order. */
  mode: PhraseMode;
  /** Minimum gap before a new phrase is selected, in milliseconds. */
  cooldownMs: number;
  /** Privacy toggles; when `hideFilePaths` is set, command targets are suppressed. */
  privacy?: { hideFilePaths: boolean };
  /** Clock injection; defaults to `Date.now`. */
  now?: () => number;
  /** Random source injection; defaults to `Math.random`. */
  random?: () => number;
}

/** Stateful resolver that selects phrases with a cooldown gate. */
export interface ToolActivityResolver {
  /** Resolve a tool to an activity, honoring the phrase cooldown. */
  resolve(input: ToolActivityInput): ToolActivity;
  /** Resolve a tool to an activity, forcing the next phrase (rotation tick). */
  rotate(input: ToolActivityInput): ToolActivity;
  /** Select a phrase from a config pool, honoring the cooldown. */
  selectPool(phrases: readonly string[], key: string): string;
  /** Select the next phrase from a config pool, bypassing the cooldown. */
  rotatePool(phrases: readonly string[], key: string): string;
}

/** Humanize a snake/kebab tool name into spaced words. */
function humanize(value: string): string {
  return value.replace(/[_-]+/g, " ").trim();
}

/** Title-case a provider identifier. */
function titleCase(value: string): string {
  const spaced = humanize(value);
  if (spaced === "") {
    return value;
  }
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Parse `mcp__<provider>__<tool>` into its parts, or `null` when malformed. */
function parseMcpTool(tool: string): { provider: string; tool: string } | null {
  if (!tool.startsWith(MCP_PREFIX)) {
    return null;
  }
  const rest = tool.slice(MCP_PREFIX.length);
  const separator = rest.indexOf("__");
  if (separator <= 0 || separator + 2 >= rest.length) {
    return null;
  }
  const provider = rest.slice(0, separator);
  const name = rest.slice(separator + 2);
  return { provider, tool: name };
}

/**
 * Select a phrase from a pool.
 *
 * @param phrases Pool to select from.
 * @param mode Selection order.
 * @param index Sequential cursor.
 * @param random Random source for `random` mode.
 * @returns The chosen phrase plus the next sequential cursor.
 */
export function selectPhrase(
  phrases: readonly string[],
  mode: PhraseMode,
  index: number,
  random: () => number = Math.random,
): { phrase: string; index: number } {
  const first = phrases[0];
  if (first === undefined) {
    return { phrase: "", index: 0 };
  }
  if (mode === "random") {
    const chosen = Math.floor(random() * phrases.length);
    return { phrase: phrases[chosen] ?? first, index };
  }
  const safe = ((index % phrases.length) + phrases.length) % phrases.length;
  return { phrase: phrases[safe] ?? first, index: (safe + 1) % phrases.length };
}

/** Return the personality pool for a tool name. */
export function phrasePoolForTool(tool: string): PhrasePool {
  const builtin = BUILTIN_TOOLS[tool];
  if (builtin !== undefined) {
    return builtin.pool;
  }
  if (parseMcpTool(tool) !== null || tool.startsWith(MCP_PREFIX)) {
    return "mcp";
  }
  return "coding";
}

/** Apply privacy rules to a target, dropping non-file commands when hidden. */
function sanitizeTarget(
  target: string | undefined,
  kind: TargetKind,
  hideFilePaths: boolean,
): string | undefined {
  if (target === undefined || target === "") {
    return undefined;
  }
  if (hideFilePaths && kind === "command") {
    return undefined;
  }
  return target;
}

/** Build the activity for a built-in tool. */
function resolveBuiltin(
  input: ToolActivityInput,
  builtin: BuiltinTool,
  phrase: string,
  hideFilePaths: boolean,
): ToolActivity {
  const raw = builtin.target ? (input.target ?? input.filePath) : undefined;
  const target = builtin.target
    ? sanitizeTarget(raw, builtin.targetKind ?? "file", hideFilePaths)
    : undefined;
  return {
    source: "builtin",
    tool: input.tool,
    action: builtin.action,
    target,
    phrase,
  };
}

/** Build the activity for an MCP tool, including the unknown-provider fallback. */
function resolveMcp(input: ToolActivityInput, phrase: string): ToolActivity {
  const parsed = parseMcpTool(input.tool);
  if (parsed === null) {
    return {
      source: "mcp",
      provider: "MCP",
      tool: input.tool,
      action: `Running ${humanize(input.tool) || input.tool}`,
      phrase: MCP_FALLBACK_PHRASE,
    };
  }
  const providerLabel =
    MCP_PROVIDER_LABELS[parsed.provider.toLowerCase()] ?? titleCase(parsed.provider);
  const action = MCP_TOOL_ACTIONS[parsed.tool];
  if (action === undefined) {
    return {
      source: "mcp",
      provider: "MCP",
      tool: parsed.tool,
      action: `Running ${parsed.tool}`,
      phrase: MCP_FALLBACK_PHRASE,
    };
  }
  return {
    source: "mcp",
    provider: providerLabel,
    tool: parsed.tool,
    action,
    phrase,
  };
}

/**
 * Create a stateful tool activity resolver.
 *
 * @param options Phrase mode, cooldown, privacy and injectable clock/random sources.
 * @returns A resolver with cooldown-aware `resolve` and forcing `rotate`.
 */
export function createToolActivityResolver(
  options: ToolActivityResolverOptions,
): ToolActivityResolver {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const hideFilePaths = options.privacy?.hideFilePaths ?? false;
  const indices = new Map<string, number>();
  const phrasesByKey = new Map<string, { phrase: string; at: number }>();

  /** Pick the next phrase for a key/pool, honoring that key's cooldown unless forced. */
  function pick(phrases: readonly string[], key: string, force: boolean): string {
    if (phrases.length === 0) {
      return "";
    }
    const entry = phrasesByKey.get(key);
    if (!force && entry !== undefined && now() - entry.at < options.cooldownMs) {
      return entry.phrase;
    }
    const cursor = indices.get(key) ?? 0;
    const selected = selectPhrase(phrases, options.mode, cursor, random);
    indices.set(key, selected.index);
    phrasesByKey.set(key, { phrase: selected.phrase, at: now() });
    return selected.phrase;
  }

  /** Resolve a tool with a pool-specific phrase key. */
  function resolveWith(input: ToolActivityInput, force: boolean): ToolActivity {
    const parsed = parseMcpTool(input.tool);
    if (parsed !== null) {
      const key = `mcp:${parsed.provider}:${parsed.tool}`;
      return resolveMcp(input, pick(PHRASE_POOLS.mcp, key, force));
    }
    if (input.tool.startsWith(MCP_PREFIX)) {
      return resolveMcp(input, MCP_FALLBACK_PHRASE);
    }
    const builtin = BUILTIN_TOOLS[input.tool];
    if (builtin !== undefined) {
      const key = `builtin:${builtin.pool}:${input.tool}`;
      return resolveBuiltin(
        input,
        builtin,
        pick(PHRASE_POOLS[builtin.pool], key, force),
        hideFilePaths,
      );
    }
    const key = `custom:${input.tool}`;
    return {
      source: "custom",
      tool: input.tool,
      action: `Running ${input.tool}`,
      target: sanitizeTarget(input.target ?? input.filePath, "command", hideFilePaths),
      phrase: pick(PHRASE_POOLS.coding, key, force),
    };
  }

  return {
    resolve(input) {
      return resolveWith(input, false);
    },
    rotate(input) {
      return resolveWith(input, true);
    },
    selectPool(phrases, key) {
      return pick(phrases, key, false);
    },
    rotatePool(phrases, key) {
      return pick(phrases, key, true);
    },
  };
}
