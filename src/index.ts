/**
 * Package entry point — re-exports the opencode Discord Rich Presence plugin.
 *
 * Kept free of logic; all wiring lives in `plugin.ts` (docs/ARCHITECTURE.md §2).
 */
export {
  buildDiscordPresenceHooks,
  createDiscordPresencePlugin,
  createDiscordPresencePlugin as default,
  type DiscordPresenceRuntime,
} from "./plugin";
