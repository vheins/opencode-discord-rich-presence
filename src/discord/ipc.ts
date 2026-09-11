/**
 * Cross-platform Discord IPC socket discovery.
 *
 * Resolves the ordered candidate list Discord desktop clients listen on: Windows named
 * pipes `\\?\pipe\discord-ipc-{n}` and Unix domain sockets under the first non-empty of
 * `XDG_RUNTIME_DIR -> TMPDIR -> TMP -> TEMP -> /tmp`. Every input is injectable so the
 * resolution can be unit tested without a live Discord client (`docs/DISCORD-RPC.md` §2).
 */
import { existsSync } from "node:fs";

/** Highest IPC slot Discord scans (0..9 inclusive). */
export const IPC_MAX_SLOT = 9;

/** Environment variables consulted, in priority order, to locate the Unix socket directory. */
export const UNIX_IPC_DIR_ENV = ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"] as const;

/** One of the environment variables used to locate the Unix socket directory. */
export type UnixIpcDirEnv = (typeof UNIX_IPC_DIR_ENV)[number];

/** Final Unix fallback used when no environment variable is set. */
export const UNIX_IPC_FALLBACK_DIR = "/tmp";

/** Options accepted by the IPC discovery helpers; all fields are injectable for tests. */
export interface IpcDiscoveryOptions {
  /** Override the detected platform; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Override the environment; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Highest slot to scan inclusive; defaults to `IPC_MAX_SLOT` (9). */
  maxSlot?: number;
}

/** Predicate used to probe whether a candidate path exists. */
export type PathExists = (path: string) => boolean;

/**
 * Resolve the Unix IPC directory using the documented environment priority chain.
 *
 * @param env Environment to read; defaults to `process.env`.
 * @returns The first non-empty configured directory, else `/tmp`.
 */
export function resolveUnixIpcDir(env: Record<string, string | undefined> = process.env): string {
  for (const key of UNIX_IPC_DIR_ENV) {
    const value = env[key];
    if (value !== undefined && value !== "") {
      return value;
    }
  }
  return UNIX_IPC_FALLBACK_DIR;
}

/**
 * Build the ordered list of IPC candidate paths for a platform.
 *
 * @param options Platform, environment and slot overrides.
 * @returns Candidate socket paths from slot 0 to the configured maximum.
 */
export function listIpcCandidates(options: IpcDiscoveryOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  const maxSlot = Math.max(0, Math.floor(options.maxSlot ?? IPC_MAX_SLOT));
  const slots = maxSlot + 1;
  if (platform === "win32") {
    return Array.from({ length: slots }, (_, index) => `\\\\?\\pipe\\discord-ipc-${index}`);
  }
  const dir = resolveUnixIpcDir(options.env ?? process.env);
  const separator = dir.endsWith("/") ? "" : "/";
  return Array.from({ length: slots }, (_, index) => `${dir}${separator}discord-ipc-${index}`);
}

/**
 * Discover the first existing Discord IPC socket path.
 *
 * Windows named pipes are not filesystem entries, so probing is skipped there and the
 * first candidate is returned; callers must attempt a real connection to verify it. On
 * Unix the injected `exists` predicate selects the first live candidate.
 *
 * @param options Platform, environment and slot overrides.
 * @param exists Existence probe; defaults to `fs.existsSync`.
 * @returns The first existing candidate, or `null` when none is present.
 */
export function discoverIpcSocket(
  options: IpcDiscoveryOptions = {},
  exists: PathExists = existsSync,
): string | null {
  const candidates = listIpcCandidates(options);
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return candidates[0] ?? null;
  }
  for (const candidate of candidates) {
    if (exists(candidate)) {
      return candidate;
    }
  }
  return null;
}
