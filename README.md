# opencode Discord Rich Presence

[![npm version](https://img.shields.io/npm/v/@vheins/opencode-discord-rich-presence.svg)](https://www.npmjs.com/package/@vheins/opencode-discord-rich-presence)
[![npm downloads](https://img.shields.io/npm/dm/@vheins/opencode-discord-rich-presence.svg)](https://www.npmjs.com/package/@vheins/opencode-discord-rich-presence)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Discord RPC](https://img.shields.io/badge/Discord-Rich%20Presence-5865F2.svg)](https://discord.com/developers/docs/rich-presence/overview)

> Discord Rich Presence plugin for [opencode](https://opencode.ai) — show what you're working on in real time.

Displays your active opencode session on Discord: current model, token usage, cost, elapsed time, tool activity, and project context. Built as a native opencode plugin (`@opencode-ai/plugin`) with cross-platform IPC, automatic reconnect, and privacy-aware rendering.

## What it does

The plugin runs inside opencode's plugin host. It listens to the opencode event bus (`session.*`, `message.updated`, `tool.execute.*`, `permission.ask`, `todo.updated`, `file.edited`, etc.), maintains a per-session state machine, and pushes a Discord `SET_ACTIVITY` frame over the local IPC socket. No external daemon, no polling.

```
opencode events → state machine → presence model → Discord IPC
```

Architecture and protocol details: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/DISCORD-RPC.md`](docs/DISCORD-RPC.md)

## Features

Six target feature groups — all represented in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §5 and [`docs/ROADMAP.md`](docs/ROADMAP.md):

| # | Feature | What you get |
|---|---|---|
| (a) | **Session stats** | Live model / provider, token counts (`input`/`output`/`reasoning`/`cache`), dollar cost, elapsed timer, and `contextPercent`. Template vars `{model}` `{provider}` `{cost}` `{tokens}` `{elapsed}` `{contextPercent}` `{done}` `{total}`. See [`docs/OPENCODE-PLUGIN-API.md`](docs/OPENCODE-PLUGIN-API.md) §11. |
| (b) | **Cross-platform IPC + reconnect** | Auto-discovers `discord-ipc-0..9` on Windows (`\\?\pipe\discord-ipc-{n}`) and Unix (`$XDG_RUNTIME_DIR`/`$TMPDIR`/`/tmp`). Per-connection `FrameDecoder`, exponential backoff (`base 1 s → cap 30 s`, jitter `0.2`, `maxAttempts 10`), handshake timeout, debounce `100 ms` + throttle `4000 ms` + `retry_after` honour. |
| (c) | **Privacy / idle + per-project config** | `privacy.*` (`hideProjectPath`, `hideModel`, `hideCost`, `hideFilePaths` default `true`), `idle.*` (`enabled`, `timeoutMs` `10 s..1 h`, `details`/`state` templates), and `perProject.*` (project file overlays global; precedence `global < project < env < runtime`). |
| (d) | **Custom app id & assets** | `applicationId` (`/^\d{17,20}$/` → `client_id` in handshake), `largeImageKey`/`largeImageText` + `smallImageKey`/`smallImageText` (lower-cased, `mp:`/`https://` or Art Asset key), validated by `src/discord/presence.ts`. |
| (e) | **Buttons / links + multi-session** | `buttons[]` — up to 2 `https://` links (`label 1..32`, `url 1..512`). `multiSession.strategy` — `leader-election` (file-based, stale GC 10 s, settle ~1200 ms) or `last-wins`; only the elected session pushes to Discord's single IPC slot. |
| (f) | **Presence customization + presence engine** | `activityType` (`playing`/`listening`/`watching`/`competing`), `activityName`, random `phrases.*` pools (with `cooldownMs`), tool-activity resolver (builtin/custom/MCP with unknown fallback), context `150.4K (57%)` + `TODO 4/9` telemetry, and `presence.show*` toggles. See [`docs/PRESENCE-DESIGN.md`](docs/PRESENCE-DESIGN.md). |

## Install from npm

Published on npm: <https://www.npmjs.com/package/@vheins/opencode-discord-rich-presence>.

```bash
bun add @vheins/opencode-discord-rich-presence
# or: npm install @vheins/opencode-discord-rich-presence
```

Then register it in your opencode config:

```jsonc
// ~/.config/opencode/opencode.json  (global)  or  ./opencode.json  (project)
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@vheins/opencode-discord-rich-presence",
    // with options (highest precedence — see Configuration):
    ["@vheins/opencode-discord-rich-presence", { "debug": true, "privacy": { "hideFilePaths": true } }]
  ]
}
```

The package ships compiled ESM (`dist/`, with `dist/index.d.ts` types) plus the original
TypeScript source (`src/`). See [Install](#install) below for the local-file alternative.

## Install

Requires opencode ≥ `1.x` (plugin host at `opencode.ai/docs/plugins`) and a running Discord desktop client. Loading rules are verified against [`docs/OPENCODE-PLUGIN-API.md`](docs/OPENCODE-PLUGIN-API.md) §2 (pin `193de13a`).

### Option A — Local plugin directory (no npm publish needed)

Drop a built file into either plugin directory. opencode loads every `*.js`/`*.ts` file in these locations automatically:

| Scope | Directory |
|---|---|
| Global | `~/.config/opencode/plugins/` |
| Project | `.opencode/plugins/` |

```bash
# global — available in every project
mkdir -p ~/.config/opencode/plugins
cp ./src/index.ts ~/.config/opencode/plugins/discord-presence.ts
# or copy a built artifact if you bundle

# project — only for this repo
mkdir -p .opencode/plugins
cp ./src/index.ts .opencode/plugins/discord-presence.ts
```

If the plugin file imports npm packages, add a `package.json` inside the config directory and opencode will run `bun install` at startup before loading it (see `OPENCODE-PLUGIN-API.md` §2.1).

### Option B — npm package via `opencode.json`

```bash
bun add @vheins/opencode-discord-rich-presence
# or: npm install @vheins/opencode-discord-rich-presence
```

Then register it in your opencode config:

```jsonc
// ~/.config/opencode/opencode.json  (global)  or  ./opencode.json  (project)
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@vheins/opencode-discord-rich-presence",
    // with options (highest precedence — see Configuration):
    ["@vheins/opencode-discord-rich-presence", { "debug": true, "privacy": { "hideFilePaths": true } }]
  ]
}
```

`plugin` entries accept `string` or `[string, PluginOptions]` — the second element is forwarded as the plugin's `options` argument and wins over files and env vars. Duplicate npm packages with the same name+version are loaded once; a local file and an npm package with similar names are both loaded. See `OPENCODE-PLUGIN-API.md` §2.2 for full load order.

## Quickstart

1. **Create a Discord application** (for a custom presence — optional):
   Go to <https://discord.com/developers/applications> → **New Application** → copy the **Application ID** (a `17–20` digit decimal string) → **Rich Presence → Art Assets** to upload icons (keys like `opencode`, `editing`).

   > `DISCORD_APPLICATION_ID` note: the plugin's `applicationId` option is the same as the Discord Application ID / Client ID. You can provide it via config, env var `OPENCODE_DISCORD_CLIENT_ID` or `DISCORD_APP_ID`, or `opencode.json` runtime options. An empty string falls back to the bundled `DEFAULT_CLIENT_ID` so the plugin works with zero config. If you want your own name, icon, and Art Assets, create an app and set its ID.

2. **Minimal config** — `~/.config/opencode/discord-presence.json`:

   ```json
   {
     "applicationId": "1234567890123456789"
   }
   ```

   All other values have safe defaults (see [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md)). No config at all is also valid — the plugin runs with built-in defaults.

3. **Start opencode** — presence appears within ~2 s of `session.created`. If Discord is not running, the plugin stays in `disconnected` and reconnects automatically when Discord starts.

Minimal template override:

```jsonc
{
  "applicationId": "1234567890123456789",
  "detailsTemplate": "Working with {model} on {project}",
  "stateTemplate": "{cost} · {tokens} tokens · {elapsed}",
  "privacy": { "hideFilePaths": true }
}
```

See [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) for all 45 options, precedence rules, and env var mappings.

## Docs index

| Doc | What it covers |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Module map, data flow, FSM (6 states), 45-option config schema, transport/reconnect/rate-limit, extension points, failure modes |
| [`docs/OPENCODE-PLUGIN-API.md`](docs/OPENCODE-PLUGIN-API.md) | Authoritative plugin lifecycle, `PluginInput`/`Hooks`, 32 `Event` variants, `tool` helper, logging, compaction (pin `193de13a`) |
| [`docs/DISCORD-RPC.md`](docs/DISCORD-RPC.md) | Discord IPC wire format, opcodes, field caps, rate limits |
| [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) | Full 45-option reference, precedence `global < project < env < runtime`, examples, troubleshooting |
| [`docs/PRESENCE-DESIGN.md`](docs/PRESENCE-DESIGN.md) | Presence vision: identity, tool activity resolver, MCP, phrase pools, context/TODO telemetry, event priority, Discord constraints |
| [`docs/EXTENDING.md`](docs/EXTENDING.md) | How to add presence fields, events, config options, or swap the transport |
| [`docs/COMMUNITY-ANALYSIS.md`](docs/COMMUNITY-ANALYSIS.md) | Gap matrix vs 3 community plugins (Puri12, phoenixak, Khip01) |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | MVP → v1 → v2 → v3 milestones mapping the 6 target features |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | Prerequisites, repo layout, scripts, local harness, debugging, publishing, contributing |
| [`docs/_research/community-plugins.md`](docs/_research/community-plugins.md) | Raw research notes and source index |

## Development

```bash
bun install
bun run typecheck   # tsc --noEmit
bun run lint        # biome check .
bun run format      # biome format --write .
bun test            # bun test
bun run build       # tsc -p tsconfig.build.json → dist/ (ESM + .d.ts + source maps)
```

See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) for the full workflow — prerequisites, repo layout, local plugin harness, debugging, and publishing.

## License

MIT — see `LICENSE`.
