/**
 * Plugin wiring — maps opencode hooks and events onto session tracking and Discord presence.
 *
 * Composition root: loads config, builds a redacting logger, owns the reconnect transport
 * plus the presence scheduler and session tracker, and returns the hook object opencode
 * registers. A missing Discord client never crashes the plugin — the failure is logged once
 * and retried by the reconnect FSM (docs/ARCHITECTURE.md §3, §6, §8).
 */
import { basename } from "node:path";
import type { Hooks, Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import type { Event, Permission } from "@opencode-ai/sdk";
import { type ConfigLoaderOptions, createConfigLoader } from "./config/loader";
import { DEFAULT_CLIENT_ID, type ResolvedConfig } from "./config/schema";
import { createPresenceScheduler, type PresenceScheduler } from "./core/presence-scheduler";
import {
  createSessionTracker,
  type PresenceSignal,
  type SessionTracker,
} from "./core/session-tracker";
import type { StateMachineConfig } from "./core/state-machine";
import {
  createToolActivityResolver,
  type ToolActivityInput,
  type ToolActivityResolver,
} from "./core/tool-activity-resolver";
import { createReconnectController, type ReconnectController } from "./discord/reconnect";
import {
  type ClearTimeoutFn,
  createTransport,
  type SetTimeoutFn,
  type Transport,
} from "./discord/transport";
import { createClientLogSink, createLogger } from "./utils/logger";

/** Injectable runtime dependencies, primarily for tests and custom transports. */
export interface DiscordPresenceRuntime {
  /** Override the transport factory; defaults to the real Discord IPC transport. */
  createTransport?: () => Transport;
  /** Clock injection; defaults to `Date.now`. */
  now?: () => number;
  /** Timeout scheduler injection; defaults to the global `setTimeout`. */
  setTimeoutFn?: SetTimeoutFn;
  /** Timeout cancellation injection; defaults to the global `clearTimeout`. */
  clearTimeoutFn?: ClearTimeoutFn;
  /** Config loader injection points (env, home directory, file reader, warnings). */
  configLoaderOptions?: ConfigLoaderOptions;
}

/** opencode plugin factory — composition root for the Discord Rich Presence plugin. */
export const createDiscordPresencePlugin: Plugin = async (input, options) =>
  buildDiscordPresenceHooks(input, options, {});

/**
 * Build the opencode hook object for a plugin instance.
 *
 * @param input opencode plugin context (client, project, directory, worktree).
 * @param options Runtime overrides from the `opencode.json` plugin tuple.
 * @param runtime Injectable dependencies for tests and custom transports.
 * @returns The hooks object registered with opencode (empty when disabled).
 */
export async function buildDiscordPresenceHooks(
  input: PluginInput,
  options: PluginOptions = {},
  runtime: DiscordPresenceRuntime = {},
): Promise<Hooks> {
  const now = runtime.now ?? Date.now;
  const scheduleTimeout = runtime.setTimeoutFn ?? setTimeout;
  const cancelTimeout = runtime.clearTimeoutFn ?? clearTimeout;

  const sink = createClientLogSink(input.client);
  const baseLogger = createLogger(sink, { level: "info" });
  const loader = createConfigLoader({
    ...runtime.configLoaderOptions,
    onWarning: (message) => {
      void baseLogger.warn(`config: ${message}`);
    },
  });

  let config: ResolvedConfig;
  try {
    config = await loader.load(input.directory, options);
  } catch (error) {
    await baseLogger.error("failed to load Discord Rich Presence configuration", {
      error: errorMessage(error),
    });
    return {};
  }
  const logger = config.debug ? createLogger(sink, { level: "debug" }) : baseLogger;

  if (!config.enabled) {
    await logger.info("Discord Rich Presence disabled by configuration");
    return {};
  }

  const clientId = config.applicationId === "" ? DEFAULT_CLIENT_ID : config.applicationId;
  if (config.applicationId === "") {
    await logger.debug("Discord applicationId not set; using bundled default", {
      clientId,
    });
  }

  const resolver: ToolActivityResolver = createToolActivityResolver({
    mode: config.phrases.mode,
    cooldownMs: config.phrases.cooldownMs,
    privacy: { hideFilePaths: config.privacy.hideFilePaths },
    now,
  });

  /** Select (or advance) a phrase from a configured pool. */
  const phraseSelector = (target: "details" | "state", rotate = false): string => {
    const pool = target === "details" ? config.phrases.details : config.phrases.state;
    if (pool.length === 0) {
      return "";
    }
    const key = `config:${target}`;
    return rotate ? resolver.rotatePool(pool, key) : resolver.selectPool(pool, key);
  };

  const modelContextLimits = new Map<string, number>();
  const configApi = input.client.config;
  if (typeof configApi?.providers === "function") {
    try {
      const result = await configApi.providers();
      const data = result.data;
      if (data !== undefined) {
        for (const provider of data.providers) {
          for (const model of Object.values(provider.models)) {
            const limit = model.limit.context;
            if (typeof limit === "number" && limit > 0) {
              modelContextLimits.set(`${provider.id}/${model.id}`, limit);
            }
          }
        }
      }
    } catch (error) {
      await logger.debug("failed to load model context limits", { error: errorMessage(error) });
    }
  }

  const machineConfig: StateMachineConfig = {
    largeImageKey: config.largeImageKey,
    largeImageText: config.largeImageText,
    smallImageKey: config.smallImageKey,
    smallImageText: config.smallImageText,
    detailsTemplate: config.detailsTemplate,
    stateTemplate: config.stateTemplate,
    idle: {
      enabled: config.idle.enabled,
      details: config.idle.details,
      state: config.idle.state,
    },
    sessionStats: config.sessionStats,
    privacy: config.privacy,
    buttons: config.buttons,
    projectName: projectName(input),
    activityType: config.activityType,
    activityName: config.activityName,
    phrases: {
      details: config.phrases.details,
      state: config.phrases.state,
      mode: config.phrases.mode,
      rotateMs: config.phrases.rotateMs,
      cooldownMs: config.phrases.cooldownMs,
    },
    presence: {
      showTodo: config.presence.showTodo,
      showContext: config.presence.showContext,
      showSessionTitle: config.presence.showSessionTitle,
      showMcpProvider: config.presence.showMcpProvider,
    },
    phraseSelector,
  };

  const transportFactory: () => Transport =
    runtime.createTransport ??
    (() =>
      createTransport({
        clientId,
        handshakeTimeoutMs: config.reconnect.handshakeTimeoutMs,
      }));

  const controller: ReconnectController = createReconnectController({
    createTransport: transportFactory,
    enabled: config.reconnect.enabled,
    baseMs: config.reconnect.baseMs,
    capMs: config.reconnect.capMs,
    maxAttempts: config.reconnect.maxAttempts,
    jitterRatio: config.reconnect.jitterRatio,
    connectTimeoutMs: config.reconnect.handshakeTimeoutMs,
    setTimeoutFn: scheduleTimeout,
    clearTimeoutFn: cancelTimeout,
  });

  let connectFailureLogged = false;
  controller.on("ready", () => {
    connectFailureLogged = false;
    void logger.info("Discord IPC connected");
  });
  controller.on("error", (error) => {
    if (connectFailureLogged) {
      void logger.debug("Discord reconnect attempt failed", { error: errorMessage(error) });
      return;
    }
    connectFailureLogged = true;
    void logger.warn("Discord IPC unavailable; presence updates will retry in the background", {
      error: errorMessage(error),
    });
  });
  controller.on("closed", (reason) => {
    void logger.warn("Discord transport closed; reconnection gave up", {
      reason: errorMessage(reason),
    });
  });

  const scheduler: PresenceScheduler = createPresenceScheduler({
    debounceMs: config.throttle.debounceMs,
    minIntervalMs: config.throttle.minIntervalMs,
    validate: config.assets.validate,
    now,
    setTimeoutFn: scheduleTimeout,
    clearTimeoutFn: cancelTimeout,
    send: (activity, nonce) => controller.send(activity, nonce),
    onError: (error) => {
      void logger.debug("presence send failed; will retry", { error: errorMessage(error) });
    },
  });

  const tracker: SessionTracker = createSessionTracker({
    config: machineConfig,
    idle: { enabled: config.idle.enabled, timeoutMs: config.idle.timeoutMs },
    now,
    setTimeoutFn: scheduleTimeout,
    clearTimeoutFn: cancelTimeout,
    resolveActivity: (activityInput: ToolActivityInput) => resolver.resolve(activityInput),
    rotateActivity: (activityInput: ToolActivityInput) => resolver.rotate(activityInput),
    rotateMs: config.phrases.rotateMs,
    contextLimit: (providerID, modelID) => modelContextLimits.get(`${providerID}/${modelID}`),
    onModel: (model) => scheduler.schedule(model),
    onClear: () => scheduler.schedule(null),
  });

  function handleEvent(event: Event): void {
    switch (event.type) {
      case "session.created": {
        const info = event.properties.info;
        tracker.onSessionCreated(info.id, info.title, info.time.created);
        break;
      }
      case "session.updated": {
        const info = event.properties.info;
        tracker.onSessionUpdated(info.id, info.title);
        break;
      }
      case "session.idle": {
        tracker.onSessionIdle(event.properties.sessionID);
        break;
      }
      case "session.error": {
        const sessionID = event.properties.sessionID;
        if (sessionID !== undefined) {
          tracker.onSessionError(sessionID, event.properties.error?.name ?? "UnknownError");
        }
        break;
      }
      case "session.deleted": {
        tracker.onSessionDeleted(event.properties.info.id);
        break;
      }
      case "message.updated": {
        tracker.onMessageUpdated(event.properties.info);
        break;
      }
      case "message.part.updated": {
        const part = event.properties.part;
        const signal = partSignal(part.type);
        if (signal !== undefined) {
          tracker.onMessagePart(part.sessionID, signal);
        }
        break;
      }
      case "todo.updated": {
        tracker.onTodoUpdated(event.properties.sessionID, event.properties.todos);
        break;
      }
      case "permission.updated": {
        const permission = event.properties;
        tracker.onPermissionAsked(permission.sessionID, permission.title);
        break;
      }
      case "permission.replied": {
        tracker.onPermissionReplied(event.properties.sessionID);
        break;
      }
      case "session.compacted": {
        tracker.onCompactingEnd(event.properties.sessionID);
        break;
      }
      default:
        break;
    }
  }

  let shutdownPromise: Promise<void> | null = null;

  async function performShutdown(): Promise<void> {
    process.removeListener("beforeExit", onBeforeExit);
    scheduler.dispose();
    tracker.dispose();
    if (controller.state === "ready") {
      try {
        await controller.send(null, `shutdown-${now()}`);
      } catch (error) {
        await logger.debug("failed to clear presence on shutdown", { error: errorMessage(error) });
      }
    }
    await controller.stop();
    await logger.info("Discord Rich Presence stopped");
  }

  function shutdown(): Promise<void> {
    if (shutdownPromise === null) {
      shutdownPromise = performShutdown();
    }
    return shutdownPromise;
  }

  function onBeforeExit(): void {
    void shutdown();
  }

  const hooks: Hooks = {
    event: async ({ event }) => {
      try {
        handleEvent(event);
      } catch (error) {
        await logger.debug("failed to handle opencode event", { error: errorMessage(error) });
      }
    },
    "tool.execute.before": async (hookInput, hookOutput) => {
      tracker.onToolStart(hookInput.sessionID, hookInput.tool, extractFilePath(hookOutput.args));
    },
    "tool.execute.after": async (hookInput) => {
      tracker.onToolEnd(hookInput.sessionID);
    },
    "permission.ask": async (permission: Permission) => {
      tracker.onPermissionAsked(permission.sessionID, permission.title);
    },
    "experimental.session.compacting": async (hookInput) => {
      tracker.onCompactingStart(hookInput.sessionID);
    },
    dispose: async () => {
      await shutdown();
    },
  };

  process.once("beforeExit", onBeforeExit);
  controller.start();
  await logger.info("Discord Rich Presence started", {
    reconnect: config.reconnect.enabled,
  });
  return hooks;
}

/** Extract a file path from tool arguments when a conventional key is present. */
function extractFilePath(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) {
    return undefined;
  }
  const record = args as Record<string, unknown>;
  for (const key of ["filePath", "file_path", "path", "file"]) {
    const value = record[key];
    if (typeof value === "string" && value !== "") {
      return value;
    }
  }
  return undefined;
}

/**
 * Map a streaming message-part type to a presence signal.
 *
 * Text/step parts are intentionally ignored; the priority gate in the session
 * tracker keeps higher-signal states from being overwritten (`PRESENCE-DESIGN.md` §12).
 *
 * @param type Message-part discriminant.
 * @returns The matching signal, or `undefined` for low-signal parts.
 */
function partSignal(type: string): PresenceSignal | undefined {
  switch (type) {
    case "tool":
      return "tool";
    case "file":
      return "file";
    case "reasoning":
      return "thinking";
    default:
      return undefined;
  }
}

/** Derive a human-readable project name from the opencode worktree or directory. */
function projectName(input: PluginInput): string {
  const source = input.worktree !== "" ? input.worktree : input.directory;
  return basename(source) || source;
}

/** Normalize an unknown thrown value into a log-safe message string. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error === undefined || error === null) {
    return "unknown error";
  }
  return String(error);
}
