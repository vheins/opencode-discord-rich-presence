/**
 * Config schema — the 45 documented options with defaults and validation.
 *
 * Uses zod to parse the merged config (see `docs/ARCHITECTURE.md` §5). Validation is
 * per top-level section: a malformed subtree is replaced with defaults and reported as
 * a warning, so a bad config never crashes plugin load.
 */
import { z } from "zod";
import type { PresenceButton } from "../types";

/** Result of validating a raw merged config object. */
export interface ConfigValidationResult {
  /** Fully resolved config; every field has a value. */
  config: ResolvedConfig;
  /** Human-readable messages for sections that fell back to defaults. */
  warnings: string[];
}

/** Minimal structural view of a zod schema used for per-section validation. */
interface ValidationSchema {
  safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: unknown };
  parse(value: unknown): unknown;
}

/** Minimum phrase rotation interval in milliseconds (rate-limit friendly). */
const PHRASE_ROTATE_MIN_MS = 5_000;

/** Maximum phrase rotation interval in milliseconds (1 hour). */
const PHRASE_ROTATE_MAX_MS = 3_600_000;

const DEFAULT_BUTTONS: PresenceButton[] = [
  {
    label: "View on GitHub",
    url: "https://github.com/vheins/opencode-discord-rich-presence",
  },
];

/**
 * Bundled Discord application id used when `applicationId` is left empty.
 *
 * The value comes from the primary reference plugin (`docs/_research/community-plugins.md`
 * §1.5) so the documented zero-config path has a working RPC identity. Set `applicationId`
 * to override it with your own app for a custom name, icon and Art Assets.
 */
export const DEFAULT_CLIENT_ID = "1466770544748662819";

/** Discord Application ID: empty string (use bundled default) or 17..20 digits. */
const applicationIdSchema = z
  .string()
  .refine((value) => value === "" || /^\d{17,20}$/.test(value), {
    message: "must be empty or a 17..20 digit Discord application id",
  })
  .default("");

/** A single presence button; labels are short and URLs must be HTTPS. */
const buttonSchema = z.object({
  label: z.string().min(1).max(32),
  url: z
    .string()
    .min(1)
    .max(512)
    .refine((value) => value.startsWith("https://"), {
      message: "must start with https://",
    }),
});

/** Top-level config sections, reused for schema inference and per-section validation. */
const sections = {
  enabled: z.boolean().default(true),
  applicationId: applicationIdSchema,
  debug: z.boolean().default(false),
  largeImageKey: z.string().min(1).max(32).default("opencode"),
  largeImageText: z.string().min(1).max(128).default("opencode"),
  smallImageKey: z.string().min(1).max(32).optional(),
  smallImageText: z.string().min(1).max(128).optional(),
  detailsTemplate: z.string().default("Working with {model}"),
  stateTemplate: z.string().default("{cost} · {tokens} tokens"),
  activityType: z.enum(["playing", "listening", "watching", "competing"]).default("playing"),
  activityName: z.string().min(1).max(128).optional(),
  privacy: z
    .object({
      hideProjectPath: z.boolean().default(false),
      hideModel: z.boolean().default(false),
      hideCost: z.boolean().default(false),
      hideFilePaths: z.boolean().default(true),
    })
    .default(() => ({
      hideProjectPath: false,
      hideModel: false,
      hideCost: false,
      hideFilePaths: true,
    })),
  idle: z
    .object({
      enabled: z.boolean().default(true),
      timeoutMs: z
        .number()
        .int()
        .default(300_000)
        .transform((value) => Math.min(3_600_000, Math.max(10_000, value))),
      details: z.string().default("Idle — ready"),
      state: z.string().default("{cost} · {tokens} tokens"),
    })
    .default(() => ({
      enabled: true,
      timeoutMs: 300_000,
      details: "Idle — ready",
      state: "{cost} · {tokens} tokens",
    })),
  reconnect: z
    .object({
      enabled: z.boolean().default(true),
      baseMs: z.number().int().min(1).default(1_000),
      capMs: z.number().int().min(1).default(30_000),
      maxAttempts: z.number().int().min(0).default(10),
      jitterRatio: z.number().min(0).max(1).default(0.2),
      handshakeTimeoutMs: z.number().int().min(1).default(10_000),
    })
    .default(() => ({
      enabled: true,
      baseMs: 1_000,
      capMs: 30_000,
      maxAttempts: 10,
      jitterRatio: 0.2,
      handshakeTimeoutMs: 10_000,
    })),
  throttle: z
    .object({
      debounceMs: z.number().int().min(0).default(100),
      minIntervalMs: z.number().int().min(0).default(4_000),
    })
    .default(() => ({ debounceMs: 100, minIntervalMs: 4_000 })),
  assets: z
    .object({
      validate: z.boolean().default(true),
    })
    .default(() => ({ validate: true })),
  buttons: z
    .array(buttonSchema)
    .max(2)
    .default(() => DEFAULT_BUTTONS.map((button) => ({ ...button }))),
  multiSession: z
    .object({
      strategy: z.enum(["leader-election", "last-wins"]).default("leader-election"),
    })
    .default(() => ({ strategy: "leader-election" as const })),
  sessionStats: z
    .object({
      showModel: z.boolean().default(true),
      showTokens: z.boolean().default(true),
      showCost: z.boolean().default(true),
      showElapsed: z.boolean().default(true),
    })
    .default(() => ({
      showModel: true,
      showTokens: true,
      showCost: true,
      showElapsed: true,
    })),
  phrases: z
    .object({
      details: z.array(z.string().min(1).max(128)).default([]),
      state: z.array(z.string().min(1).max(128)).default([]),
      mode: z.enum(["random", "sequential"]).default("random"),
      rotateMs: z
        .number()
        .int()
        .default(0)
        .transform((value) =>
          value <= 0 ? 0 : Math.min(PHRASE_ROTATE_MAX_MS, Math.max(PHRASE_ROTATE_MIN_MS, value)),
        ),
      cooldownMs: z.number().int().min(0).default(5_000),
    })
    .default(() => ({
      details: [],
      state: [],
      mode: "random" as const,
      rotateMs: 0,
      cooldownMs: 5_000,
    })),
  presence: z
    .object({
      showTodo: z.boolean().default(true),
      showContext: z.boolean().default(true),
      showSessionTitle: z.boolean().default(true),
      showMcpProvider: z.boolean().default(true),
    })
    .default(() => ({
      showTodo: true,
      showContext: true,
      showSessionTitle: true,
      showMcpProvider: true,
    })),
  perProject: z
    .object({
      enabled: z.boolean().default(true),
      filename: z.string().min(1).default(".discord-presence.json"),
    })
    .default(() => ({ enabled: true, filename: ".discord-presence.json" })),
} as const;

/** Full config schema; the source of truth for `ResolvedConfig`. */
export const configSchema = z.object(sections);

/** Fully resolved configuration with every documented option populated. */
export type ResolvedConfig = z.infer<typeof configSchema>;

/** Ordered list of top-level section keys, used by `validateConfig`. */
const SECTION_KEYS = Object.keys(sections) as Array<keyof typeof sections>;

/** Return a fresh copy of the fully defaulted configuration. */
export function getDefaultConfig(): ResolvedConfig {
  return validateConfig({}).config;
}

/** Test whether a value is a non-null, non-array object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Render a zod parse error into a compact, log-safe message. */
function formatZodError(error: unknown): string {
  if (isRecord(error) && Array.isArray(error.issues)) {
    const parts = error.issues.map((issue) => {
      if (!isRecord(issue)) {
        return "invalid value";
      }
      const path = Array.isArray(issue.path) ? issue.path.join(".") : "";
      const message = typeof issue.message === "string" ? issue.message : "invalid value";
      return path.length > 0 ? `${path}: ${message}` : message;
    });
    if (parts.length > 0) {
      return parts.join("; ");
    }
  }
  return "invalid value";
}

/**
 * Validate a merged config object, falling back to defaults per section.
 *
 * Never throws: each top-level section is parsed independently so a single bad
 * subtree cannot discard the rest of a valid configuration.
 *
 * @param raw Merged config object from files, environment and runtime options.
 * @returns The resolved config plus warnings for any section that was reset.
 */
export function validateConfig(raw: unknown): ConfigValidationResult {
  const warnings: string[] = [];
  let input: Record<string, unknown> = {};
  if (isRecord(raw)) {
    input = raw;
  } else if (raw !== undefined) {
    warnings.push("config root must be an object; using defaults");
  }

  const resolved: Record<string, unknown> = {};
  for (const key of SECTION_KEYS) {
    const schema = sections[key] as unknown as ValidationSchema;
    const result = schema.safeParse(input[key]);
    if (result.success) {
      resolved[key] = result.data;
    } else {
      resolved[key] = schema.parse(undefined);
      warnings.push(`${key}: ${formatZodError(result.error)}`);
    }
  }

  return { config: resolved as ResolvedConfig, warnings };
}
