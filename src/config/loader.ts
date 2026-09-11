/**
 * Config loader — discovers, merges and validates configuration sources.
 *
 * Precedence (lowest to highest): global file < project file < env var < runtime
 * `PluginOptions` (see `docs/ARCHITECTURE.md` §5). Objects deep-merge, arrays and
 * scalars replace. Every failure is reported as a warning; load never throws.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./schema";
import { validateConfig } from "./schema";

/** Loads the resolved configuration for a plugin instance. */
export interface ConfigLoader {
  /**
   * Resolve configuration for a working directory.
   *
   * @param cwd Project directory (usually `PluginInput.directory`).
   * @param runtimeOptions Options passed via `opencode.json` plugin tuple.
   * @returns The fully resolved config.
   */
  load(cwd: string, runtimeOptions?: Record<string, unknown>): Promise<ResolvedConfig>;
}

/** Result of a raw load, including non-fatal warnings. */
export interface ConfigLoadResult {
  /** Fully resolved configuration. */
  config: ResolvedConfig;
  /** Non-fatal problems encountered while reading or validating sources. */
  warnings: string[];
}

/** Injectable dependencies for `loadConfig` / `createConfigLoader`. */
export interface ConfigLoaderOptions {
  /** Environment map; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Home directory override; defaults to `os.homedir()`. */
  homeDir?: string;
  /** File reader returning `null` for a missing file; defaults to `node:fs/promises`. */
  readFile?: (path: string) => Promise<string | null>;
  /** Called once per warning when loading via `ConfigLoader.load`. */
  onWarning?: (message: string) => void;
}

const GLOBAL_CONFIG_FILENAME = "discord-presence.json";
const DEFAULT_PROJECT_FILENAME = ".discord-presence.json";

/** Test whether a value is a non-null, non-array object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Test whether an unknown error carries a Node-style `code`. */
function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

/** Extract a log-safe message from an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Default file reader that treats a missing file as `null`. */
async function defaultReadFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/** Read and parse a JSON object file, recording warnings instead of throwing. */
async function readJsonObject(
  path: string,
  read: (path: string) => Promise<string | null>,
  warnings: string[],
): Promise<Record<string, unknown>> {
  let text: string | null;
  try {
    text = await read(path);
  } catch (error) {
    warnings.push(`${path}: ${errorMessage(error)}`);
    return {};
  }
  if (text === null) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) {
      warnings.push(`${path}: expected a JSON object`);
      return {};
    }
    return parsed;
  } catch (error) {
    warnings.push(`${path}: invalid JSON (${errorMessage(error)})`);
    return {};
  }
}

/** Deep-merge two config records; objects merge, arrays and scalars replace. */
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    if (isRecord(current) && isRecord(value)) {
      result[key] = deepMerge(current, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** Read a nested value from a config record using a dotted path. */
function getPath(source: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = source;
  for (const segment of path.split(".")) {
    if (!isRecord(cursor)) {
      return undefined;
    }
    cursor = cursor[segment];
  }
  return cursor;
}

/** Assign a value at a dotted path, creating intermediate objects. */
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".");
  let cursor: Record<string, unknown> = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (segment === undefined) {
      return;
    }
    const next = cursor[segment];
    if (!isRecord(next)) {
      const created: Record<string, unknown> = {};
      cursor[segment] = created;
      cursor = created;
    } else {
      cursor = next;
    }
  }
  const last = segments[segments.length - 1];
  if (last !== undefined) {
    cursor[last] = value;
  }
}

/** Parse a boolean environment value; returns `undefined` when absent/invalid. */
function parseEnvBoolean(
  env: Record<string, string | undefined>,
  name: string,
  warnings: string[],
): boolean | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  warnings.push(`${name}: expected a boolean, got "${raw}"`);
  return undefined;
}

/** Parse a finite number environment value; returns `undefined` when absent/invalid. */
function parseEnvNumber(
  env: Record<string, string | undefined>,
  name: string,
  warnings: string[],
): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    warnings.push(`${name}: expected a number, got "${raw}"`);
    return undefined;
  }
  return parsed;
}

/** Read a non-empty string environment value. */
function readEnvString(env: Record<string, string | undefined>, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  return raw;
}

/** Build the nested config override contributed by `OPENCODE_DISCORD_*` env vars. */
function readEnvOverrides(
  env: Record<string, string | undefined>,
  warnings: string[],
): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  const set = (path: string, value: unknown): void => {
    if (value !== undefined) {
      setPath(overrides, path, value);
    }
  };

  set("enabled", parseEnvBoolean(env, "OPENCODE_DISCORD_ENABLED", warnings));
  set(
    "applicationId",
    readEnvString(env, "OPENCODE_DISCORD_CLIENT_ID") ??
      readEnvString(env, "DISCORD_APP_ID") ??
      readEnvString(env, "DISCORD_APPLICATION_ID"),
  );
  set("debug", parseEnvBoolean(env, "OPENCODE_DISCORD_DEBUG", warnings));
  set("largeImageKey", readEnvString(env, "DISCORD_LARGE_IMAGE_KEY"));
  set("largeImageText", readEnvString(env, "DISCORD_LARGE_IMAGE_TEXT"));
  set("smallImageKey", readEnvString(env, "DISCORD_SMALL_IMAGE_KEY"));
  set("smallImageText", readEnvString(env, "DISCORD_SMALL_IMAGE_TEXT"));
  set("privacy.hideProjectPath", parseEnvBoolean(env, "OPENCODE_DISCORD_HIDE_PROJECT", warnings));
  set("privacy.hideModel", parseEnvBoolean(env, "OPENCODE_DISCORD_HIDE_MODEL", warnings));
  set("privacy.hideCost", parseEnvBoolean(env, "OPENCODE_DISCORD_HIDE_COST", warnings));
  set("privacy.hideFilePaths", parseEnvBoolean(env, "OPENCODE_DISCORD_HIDE_FILES", warnings));
  set("idle.timeoutMs", parseEnvNumber(env, "OPENCODE_DISCORD_IDLE_TIMEOUT", warnings));
  set("reconnect.maxAttempts", parseEnvNumber(env, "OPENCODE_DISCORD_MAX_RETRIES", warnings));

  return overrides;
}

/**
 * Resolve configuration for a working directory, collecting non-fatal warnings.
 *
 * @param cwd Project directory used to locate the per-project config file.
 * @param runtimeOptions Highest-precedence overrides from `PluginOptions`.
 * @param options Injectable env/home/file-reader dependencies.
 * @returns Resolved config plus any warnings encountered.
 */
export async function loadConfig(
  cwd: string,
  runtimeOptions?: Record<string, unknown>,
  options: ConfigLoaderOptions = {},
): Promise<ConfigLoadResult> {
  const warnings: string[] = [];
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const read = options.readFile ?? defaultReadFile;
  const runtime = isRecord(runtimeOptions) ? runtimeOptions : {};

  const configuredDir = env.OPENCODE_CONFIG_DIR;
  const configDir =
    configuredDir !== undefined && configuredDir.trim() !== ""
      ? configuredDir
      : join(home, ".config", "opencode");
  const globalRaw = await readJsonObject(join(configDir, GLOBAL_CONFIG_FILENAME), read, warnings);

  const projectFilename =
    pickString(runtime, "perProject.filename") ??
    pickString(globalRaw, "perProject.filename") ??
    DEFAULT_PROJECT_FILENAME;
  const projectEnabled =
    pickBoolean(runtime, "perProject.enabled") ??
    pickBoolean(globalRaw, "perProject.enabled") ??
    true;
  const projectRoot = cwd.trim() !== "" ? cwd : process.cwd();
  const projectRaw = projectEnabled
    ? await readJsonObject(join(projectRoot, projectFilename), read, warnings)
    : {};

  const envRaw = readEnvOverrides(env, warnings);
  const merged = deepMerge(deepMerge(deepMerge(globalRaw, projectRaw), envRaw), runtime);

  const { config, warnings: validationWarnings } = validateConfig(merged);
  warnings.push(...validationWarnings);

  return { config, warnings };
}

/** Read a nested string value from a config record. */
function pickString(source: Record<string, unknown>, path: string): string | undefined {
  const value = getPath(source, path);
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Read a nested boolean value from a config record. */
function pickBoolean(source: Record<string, unknown>, path: string): boolean | undefined {
  const value = getPath(source, path);
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Create an injectable config loader that reports warnings through `onWarning`.
 *
 * @param options Injectable dependencies plus the warning sink.
 * @returns A `ConfigLoader` suitable for plugin wiring and tests.
 */
export function createConfigLoader(options: ConfigLoaderOptions = {}): ConfigLoader {
  return {
    async load(cwd: string, runtimeOptions?: Record<string, unknown>): Promise<ResolvedConfig> {
      const result = await loadConfig(cwd, runtimeOptions, options);
      if (options.onWarning) {
        for (const warning of result.warnings) {
          options.onWarning(warning);
        }
      }
      return result.config;
    },
  };
}
