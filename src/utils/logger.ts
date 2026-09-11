/**
 * Logger — leveled, redacting wrapper around opencode's `client.app.log`.
 *
 * The transport (sink) is injected so the logger is fully mockable in tests; the
 * client adapter is the only place that knows about `client.app.log`.
 */
import type { PluginDeps } from "../types";

/** Supported log levels, ordered from least to most severe. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** A structured log entry handed to a `LogSink`. */
export interface LogEntry {
  /** Service name shown in opencode logs. */
  service: string;
  /** Severity of the entry. */
  level: LogLevel;
  /** Human-readable message (already redacted). */
  message: string;
  /** Optional structured metadata (already redacted). */
  extra?: Record<string, unknown>;
}

/** Destination for log entries; injected so tests can capture output. */
export interface LogSink {
  /** Write a single entry. May be synchronous or asynchronous. */
  log(entry: LogEntry): void | Promise<void>;
}

/** Public logger surface consumed by the rest of the plugin. */
export interface Logger {
  /** Log at `debug` level. */
  debug(message: string, extra?: Record<string, unknown>): Promise<void>;
  /** Log at `info` level. */
  info(message: string, extra?: Record<string, unknown>): Promise<void>;
  /** Log at `warn` level. */
  warn(message: string, extra?: Record<string, unknown>): Promise<void>;
  /** Log at `error` level. */
  error(message: string, extra?: Record<string, unknown>): Promise<void>;
}

/** Options controlling service name, level filtering and redaction. */
export interface LoggerOptions {
  /** Service name recorded on every entry; defaults to `"discord-rich-presence"`. */
  service?: string;
  /** Minimum level to emit; defaults to `"info"`. */
  level?: LogLevel;
  /** Extra object-key substrings treated as secret; defaults to `DEFAULT_REDACT_KEYS`. */
  redactKeys?: string[];
  /** Maximum object depth before values are truncated; defaults to `6`. */
  maxDepth?: number;
}

/** Numeric ordering used to filter entries below the configured level. */
export const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** Replacement text for any value classified as a secret. */
export const REDACTED = "[REDACTED]";

/** Object-key substrings treated as secret by default. */
const DEFAULT_REDACT_KEYS: string[] = [
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "api_key",
  "authorization",
  "credential",
  "cookie",
  "private_key",
  "access_key",
  "refresh_token",
  "client_secret",
  "auth_token",
];

/** Value patterns that look like credentials regardless of their key. */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,40}\b/g,
];

/** Test whether a value is a non-null, non-array object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Test whether an object key looks like it carries a secret. */
function isSecretKey(key: string, redactKeys: string[]): boolean {
  const normalized = key.toLowerCase();
  return redactKeys.some((candidate) => normalized.includes(candidate));
}

/** Replace credential-looking substrings inside a string. */
function redactString(value: string): string {
  let result = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

/** Recursively redact a value, guarding against cycles and excessive depth. */
function redactValue(
  value: unknown,
  redactKeys: string[],
  maxDepth: number,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (depth > maxDepth) {
    return "[Truncated]";
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, redactKeys, maxDepth, seen, depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = isSecretKey(key, redactKeys)
      ? REDACTED
      : redactValue(item, redactKeys, maxDepth, seen, depth + 1);
  }
  return result;
}

/**
 * Recursively redact secrets from an arbitrary value.
 *
 * @param value Value to sanitize (object, array, string or scalar).
 * @param options Optional key list and depth limit overrides.
 * @returns A sanitized deep copy; primitives are returned unchanged except strings.
 */
export function redactSecrets(value: unknown, options: LoggerOptions = {}): unknown {
  return redactValue(
    value,
    options.redactKeys ?? DEFAULT_REDACT_KEYS,
    options.maxDepth ?? 6,
    new WeakSet<object>(),
    0,
  );
}

/** Redact an optional structured metadata record. */
function redactRecord(
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (extra === undefined) {
    return undefined;
  }
  const redacted = redactSecrets(extra);
  return isRecord(redacted) ? redacted : {};
}

/**
 * Create a leveled, redacting logger over an injected sink.
 *
 * @param sink Destination for entries (real client adapter or a test double).
 * @param options Service name, minimum level and redaction overrides.
 * @returns A logger whose methods never throw and are safe to fire-and-forget.
 */
export function createLogger(sink: LogSink, options: LoggerOptions = {}): Logger {
  const service = options.service ?? "discord-rich-presence";
  const minLevel = options.level ?? "info";

  const emit = async (
    level: LogLevel,
    message: string,
    extra?: Record<string, unknown>,
  ): Promise<void> => {
    if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[minLevel]) {
      return;
    }
    try {
      await sink.log({
        service,
        level,
        message: redactString(message),
        extra: redactRecord(extra),
      });
    } catch {
      // Logging must never break the plugin.
    }
  };

  return {
    debug: (message, extra) => emit("debug", message, extra),
    info: (message, extra) => emit("info", message, extra),
    warn: (message, extra) => emit("warn", message, extra),
    error: (message, extra) => emit("error", message, extra),
  };
}

/**
 * Adapt the opencode plugin client to a `LogSink`.
 *
 * @param client Plugin client exposing `client.app.log`.
 * @returns A sink that forwards entries to opencode and swallows failures.
 */
export function createClientLogSink(client: PluginDeps["client"]): LogSink {
  return {
    async log(entry: LogEntry): Promise<void> {
      try {
        await client.app.log({
          body: {
            service: entry.service,
            level: entry.level,
            message: entry.message,
            extra: entry.extra,
          },
        });
      } catch {
        // `client.app.log` is fire-and-forget safe (ARCHITECTURE.md §8).
      }
    },
  };
}
