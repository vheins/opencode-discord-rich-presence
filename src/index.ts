/**
 * Package entry point — exposes the opencode Discord Rich Presence plugin.
 *
 * The default export uses opencode's v1 plugin module shape (`{ server }`) so the
 * loader registers exactly one plugin instance. opencode's legacy detection path
 * treats *every* exported function as a plugin, which would double-register the
 * plugin (two IPC connections); the v1 shape short-circuits that path.
 * See `docs/OPENCODE-PLUGIN-API.md` §2.2 and `packages/opencode/src/plugin/index.ts`.
 */
import { createDiscordPresencePlugin } from "./plugin";

export { buildDiscordPresenceHooks, type DiscordPresenceRuntime } from "./plugin";

/** opencode v1 plugin module: a single `server` plugin function. */
export default { server: createDiscordPresencePlugin };
