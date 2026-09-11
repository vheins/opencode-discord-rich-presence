# Community opencode Discord Rich Presence Plugins — Raw Research

> Task: `DISC-001` (parent `ROOT-001`).
> Method: read-only inspection of the three repos on their default `main` branch via
> `raw.githubusercontent.com` and GitHub tree pages on **2026-09-11**. No repo was cloned,
> no tests were run, nothing was committed.
> Every claim below cites the file path (and raw URL) it came from. Where a behaviour is
> inferred rather than stated, the inference is flagged explicitly.

Analyzed revisions (from `github_list_branches`, `main` HEAD at time of writing):

| Repo | Language | Stars | Version | `main` SHA |
|---|---|---|---|---|
| `Puri12/opencode-discord-presence` | TypeScript | ~18 | `0.7.2` | `b0af0b908d15a5e3cc17bbc5b50831aa4dec444c` |
| `phoenixak/opencode-discord-rpc` | TypeScript | ~4 | `1.0.1` | `eebd89e9d0997f179af9b8092ec5e7da6a1efdb2` |
| `Khip01/opencode-rich-presence` | JavaScript (ESM) | ~1 | `3.2.0` | `ac03601a8c83914bc6316c0e247ecbb0ec3a258a` |

Raw URL prefix used throughout: `https://raw.githubusercontent.com/<owner>/<repo>/main/<path>`.

---

## 1. Puri12/opencode-discord-presence

- Repo: https://github.com/Puri12/opencode-discord-presence
- Package: `opencode-discord-presence@0.7.2`, MIT, `"type": "module"`.
- Source: https://raw.githubusercontent.com/Puri12/opencode-discord-presence/main/package.json

### 1.1 Entry structure & module layout

`package.json` (`main: dist/index.js`, `types: dist/index.d.ts`, `exports["."] → {types, import}`),
built with `tsc -p tsconfig.build.json`; tests via `bun test`; lint/format via Biome.
Dependency: `@xhayper/discord-rpc ^1.3.4`. Peer: `@opencode-ai/plugin >=0.1.0` (optional).

Layout (README "Architecture" section + tree page
`https://github.com/Puri12/opencode-discord-presence/tree/main/src`):

```
src/
├── index.ts              # default export = OpenCodeDiscordPresence
├── plugin.ts             # hook registration + presence engine
├── config.ts             # config load + defaults
├── types/index.ts        # TypeScript types
├── services/
│   ├── discord-rpc.ts        # hardened RPC lifecycle
│   ├── instance-coordinator.ts   # multi-CLI leader election
│   ├── presence-orchestrator.ts  # busy/idle across sessions
│   └── session-tracker.ts        # main vs sub-agent detection
├── state/presence-state.ts   # PresenceSnapshot + reducer
└── utils/
    ├── activity-rotation.ts  # precedence + rotation engine
    ├── file-label.ts         # path sanitization + truncation
    ├── file-icons.ts         # language → icon mapping
    ├── session-metrics.ts    # session counters + recap
    ├── session-persistence.ts# per-instance metrics persistence
    ├── tool-label.ts         # tool → operation label
    └── particle.ts           # Korean particle handling
```

Plugin export shape: `src/index.ts` does `export default OpenCodeDiscordPresence` where
`OpenCodeDiscordPresence: Plugin` is defined in `src/plugin.ts`
(`src/index.ts`, `src/plugin.ts`).

### 1.2 opencode hooks / events used

From `src/plugin.ts` (returned hook object + side-effect handlers):

- `chat.message` — updates identity (agent/model), marks session busy, records message activity.
- `tool.execute.before` / `tool.execute.after` — capture file path from tool args, map tool→operation label.
- `event` — dispatches:
  - `session.created`, `session.updated` → `tracker.prime(id, parentID)`.
  - `session.status` (`idle`/`busy`) → orchestrator markIdle/markBusy.
  - `file.edited` → file spotlight update.
  - `todo.updated` → mission-board summary.
  - `lsp.client.diagnostics` → logged only (counts unavailable in plugin API v1).
  - `session.idle` → idle state (only when all tracked sessions idle).
  - `session.deleted` → session recap (30 s card) + metrics clear.
- `dispose` → graceful teardown; plus `process.on("SIGINT"/"SIGTERM")` fallback.

### 1.3 Discord transport library + version

`@xhayper/discord-rpc` `^1.3.4` (`import { Client } from "@xhayper/discord-rpc"` in
`src/services/discord-rpc.ts`; `package.json` dependencies).

### 1.4 IPC socket discovery + reconnect handling

Socket discovery is delegated to the `@xhayper/discord-rpc` library — the repo contains no
platform-specific socket-path code (searched `src/services/discord-rpc.ts`; no `discord-ipc`
string). Reconnect is implemented explicitly in `DiscordRPCService`
(`src/services/discord-rpc.ts`):

- Constants: `RECONNECT_DELAY = 5000`, `MAX_RETRIES = 10`, `DEBOUNCE_MS = 100`,
  `MAX_DETAILS_LENGTH = 126`, `MAX_STATE_LENGTH = 126`.
- `scheduleReconnect()` increments `retryCount`, schedules `connect()` after 5 s, bails at
  `MAX_RETRIES`; timers call `.unref?.()`.
- `disconnected` event → `scheduleReconnect()` unless `disconnecting`.
- A monotonic `clientGeneration` counter guards stale `ready`/`disconnected` callbacks from
  older clients ("zombie connected with no client" prevention).
- `connect()` self-heals: resets `retryCount` if at cap, resets `cleared`/`disconnecting`.
- `disconnect()` clears Discord activity before destroying the client, cancels debounce/reconnect
  timers, and nulls presence.
- `setPresence` is debounced (`scheduleUpdate`/`flushPendingUpdate`).
- `shouldLogConnectFailure(retryCount)` logs the connect failure only on the first attempt
  (issue #7 "multi-CLI noise").

### 1.5 Config format + options

File-based, resolved in order (README "Where the plugin reads from"; `src/plugin.ts`
`loadConfigFile`):

1. `<projectRoot>/.discord-presence.json`
2. `~/.discord-presence.json`
3. Environment variables
4. Built-in defaults

Options (`src/config.ts`, `src/types/index.ts`, README config table):

| Option | Type | Default | Notes |
|---|---|---|---|
| `enabled` | boolean | `true` | env `OPENCODE_DISCORD_ENABLED` |
| `applicationId` | string | `1466770544748662819` (`DEFAULT_CLIENT_ID`) | also accepts legacy `discordPresence.applicationId`; env `OPENCODE_DISCORD_CLIENT_ID` |
| `language` | `"en" \| "ko"` | `"en"` | env `OPENCODE_DISCORD_LANGUAGE` |
| `debug` | boolean | `false` | env `OPENCODE_DISCORD_DEBUG` |
| `richPresence.enableFileSpotlight` | boolean | `false` | **off by default for privacy** |
| `richPresence.enableMissionBoard` | boolean | `true` | |
| `richPresence.rotationIntervalSeconds` | number | `20` | clamped 10–60 |
| `richPresence.mainAgentOnly` | boolean | `false` | filters sub-agent sessions |
| `richPresence.diagnostics.errorsOnly` | boolean | `true` | reserved/inactive in v1 |

Per-project config is explicitly supported (project file wins over home file). Note
`opencode.json` is **not** a config source for this plugin (README).

### 1.6 Presence fields shown

From `src/services/discord-rpc.ts` (`setPresence`) and `src/utils/activity-rotation.ts`
(`getActivity`): `details`, `state`, `startTimestamp` (`sessionStart`), `largeImageKey`
(default `opencode-logo`), `largeImageText` (default `OpenCode`), optional `smallImageKey`/
`smallImageText`, and `buttons` = `[{label: "View on GitHub", url: "<repo>"}]`. **No `party`.**

Rotation precedence (`activity-rotation.ts`): recap → diagnostics-error → idle → all-tasks-complete
→ file-spotlight → task-mission-board → diagnostics-warnings → session-stats. Critical states pin;
informational cards rotate every `rotationIntervalSeconds`.

### 1.7 Cross-platform support, multi-session, session stats

- **Cross-platform**: no explicit OS branching in `src/`; relies on `@xhayper/discord-rpc` and
  `node:os`/`node:path`. No Windows-specific code found.
- **Multi-session**: `InstanceCoordinator` (`src/services/instance-coordinator.ts`) does file-based
  leader election across OpenCode CLIs. Instance files live under
  `~/.opencode-discord-presence/instances/<hostname>/<clientId>/<pid>.json`
  (`buildInstancesDir` in `src/plugin.ts`). Winner = highest `lastActivity`, tie-break oldest
  `startedAt` then lowest pid (`peerWins`). Stale records GC'd after `staleThresholdMs` (10 s) with
  a 2-tick grace; atomic temp+rename writes; hostname/clientId segregation. A 1200 ms
  `DEFAULT_OWNER_SETTLE_MS` delay separates handoff from `rpc.connect()`.
  `PresenceOrchestrator` tracks busy session IDs; `SessionTracker` classifies main vs sub via
  `info.parentID` (SDK fallback with negative cache); `mainAgentOnly` drops sub-agent `chat.message`.
- **Session stats**: `SessionMetrics` interface declares `messageCount`, `uniqueFilesTouched`,
  `sessionStartTimestamp`, `activeDurationSeconds`, `lastActivityTimestamp`, `agentSwitches`, and
  optional `tokenUsage?` / `cost?` (`src/state/presence-state.ts`). `session-metrics.ts` populates
  message count, unique files, durations and task context — **but `tokenUsage` and `cost` are never
  assigned anywhere in `src/`** (grep of the fetched sources). So token/cost stats are declared,
  not implemented. Presence only shows prompt count and file count in the session-stats card
  (`formatStatsLine`).

---

## 2. phoenixak/opencode-discord-rpc

- Repo: https://github.com/phoenixak/opencode-discord-rpc
- Package: `opencode-discord-rpc@1.0.1`, MIT, `"type": "module"`.
- Source: https://raw.githubusercontent.com/phoenixak/opencode-discord-rpc/main/package.json

### 2.1 Entry structure & module layout

`package.json` (`main: dist/index.js`, `types: dist/index.d.ts`, `exports["."]`), built with
`tsc`. Dependency `@xhayper/discord-rpc ^1.3.0`. Peer `@opencode-ai/plugin >=1.0.0` (optional).

Layout (tree page `https://github.com/phoenixak/opencode-discord-rpc/tree/main/src`):

```
src/
├── index.ts    # DiscordRPCPlugin: Plugin + default export; hooks
├── discord.ts  # DiscordRPCClient wrapper (auto-reconnect)
└── config.ts   # env-only config
```

Export shape: named `export const DiscordRPCPlugin: Plugin` plus `export default DiscordRPCPlugin`;
also re-exports `getConfig` and `PluginConfig` (`src/index.ts`).

### 2.2 opencode hooks / events used

From `src/index.ts`:

- `chat.message` — detect `input.model.modelID`, set status `thinking`.
- `chat.params` — detect `input.model.id` (alternate model source).
- `tool.execute.before` → status `coding`; `tool.execute.after` → status `thinking`.
- `event`: `session.created` (reset timer, `coding`), `session.status` (`busy`→`coding`,
  `idle`→`waiting`), `session.idle`→`idle`, `session.deleted`→clear presence,
  `message.part.updated`→`thinking`.
- No `dispose` hook; `disconnect()` exists on the client but is not wired to a plugin lifecycle hook.

### 2.3 Discord transport library + version

`@xhayper/discord-rpc` `^1.3.0` (`src/discord.ts`; `package.json`).

### 2.4 IPC socket discovery + reconnect handling

Socket discovery delegated to the library (no explicit socket-path code in `src/`). Reconnect in
`DiscordRPCClient.scheduleReconnect()` (`src/discord.ts`):

- Defaults from `src/config.ts`: `retryInterval = 15000` ms, `maxRetries = 5`.
- On `disconnected` → `scheduleReconnect()`; on connect error → log (silenced for
  `ENOENT`/"Could not connect") then `scheduleReconnect()`.
- `isConnecting` guard prevents concurrent connects; on `ready` restores `currentPresence`.
- No generation counter, no debounce, no explicit clear on socket drop (only `clearPresence()`
  on `session.deleted` and `disconnect()`).
- README states "Auto-reconnects if Discord restarts".

### 2.5 Config format + options

Environment variables only — **no config file, no per-project config** (`src/config.ts`,
README "Configuration"):

| Variable | Default | Meaning |
|---|---|---|
| `OPENCODE_DISCORD_CLIENT_ID` | `1462270555586822206` (`DEFAULT_CLIENT_ID`) | custom app id |
| `OPENCODE_DISCORD_ENABLED` | `"true"` (disabled only if exactly `"false"`) | toggle |
| `OPENCODE_DISCORD_RETRY_INTERVAL` | `15000` | reconnect interval (ms) |
| `OPENCODE_DISCORD_MAX_RETRIES` | `5` | max reconnect attempts |

### 2.6 Presence fields shown

From `DiscordRPCClient.updatePresence()` (`src/discord.ts`): `details` = `Using <model>` (or
`Using OpenCode`), `state` = `Coding...` / `Idle` / `Thinking...` / `Waiting for input...`,
`startTimestamp` = session start, `largeImageKey = "opencode_rp_large_dark_1024"`,
`largeImageText = "OpenCode - AI Coding Assistant"`,
`smallImageKey = "opencode_icon_tight_dark_1024"`, `smallImageText = statusText`, and
`buttons = [{label: "Visit OpenCode.ai", url: "https://opencode.ai"}]`.
**No `party`.** Asset keys are hardcoded (not configurable).

### 2.7 Cross-platform support, multi-session, session stats

- **Cross-platform**: relies entirely on the library; README requires "Discord Desktop App".
  No OS branching in `src/`.
- **Multi-session**: single module-level `rpcClient` singleton and module-level
  `currentModelName`/`currentStatus` — **no per-session or per-instance tracking, no coordination**;
  last event wins (`src/index.ts`).
- **Session stats**: none beyond model name and elapsed timer. README "Privacy" explicitly says it
  does not display project name/path, file names/contents, or conversation content.

---

## 3. Khip01/opencode-rich-presence

- Repo: https://github.com/Khip01/opencode-rich-presence
- Package: `opencode-rich-presence@3.2.0`, MIT, `"type": "module"`, **zero runtime dependencies**.
- Source: https://raw.githubusercontent.com/Khip01/opencode-rich-presence/main/package.json

### 3.1 Entry structure & module layout

`package.json`: `main: ./src/plugin/index.js`, `bin.opencode-rpc: ./bin/opencode-rpc.js`, no
`dependencies`, no build step (raw ESM shipped). Tests are Node harness scripts under `tests/`.

Layout (tree pages under `src/`; ARCHITECTURE.md "Module Structure"):

```
src/
├── shared/
│   ├── paths.js       # cross-platform paths
│   ├── constants.js   # STATE enum, defaults, model limits, templates
│   └── logger.js      # debug + activity log helpers
├── plugin/
│   ├── index.js          # entry (OpencodeRichPresence), event handlers
│   ├── config-resolver.js# discord-config.json + env
│   ├── session-state.js  # per-session token/cost/state
│   ├── template-engine.js# vars, conditionals, render
│   ├── local-presence.js # render + send to daemon
│   ├── daemon-client.js  # local socket client
│   └── daemon-spawner.js # spawns daemon on first firing
├── worker/
│   ├── daemon.mjs        # long-lived subprocess, holds Discord IPC
│   └── discord-ipc.mjs   # inline Discord IPC client
└── cli/                  # install/uninstall/restart/update/info/help/version
```

Export shape: named `export const OpencodeRichPresence = async ({ client, directory }) => {...}`
plus `export default OpencodeRichPresence` (`src/plugin/index.js`).

### 3.2 opencode hooks / events used

From `src/plugin/index.js`:

- `chat.message` — model/agent/mode, prompt count, first-firing daemon spawn, message restore.
- `event` — `session.created`/`session.updated`, `session.deleted`, `session.status`/`session.idle`,
  `message.updated` (cost/tokens), `message.part.updated` (reasoning/text/tool/step-finish),
  `permission.asked`, `permission.replied`.
- `dispose` — clear timers + `stopPresence()`.
- **No `tool.execute.*` hooks.** Instead it polls the SDK every `REFRESH_INTERVAL = 5000` ms
  (`client.session.list` + `client.session.messages`) and restores state on load via
  `client.provider.list` (`src/plugin/index.js`, `src/shared/constants.js`).

### 3.3 Discord transport library + version

**Custom inline IPC client, no third-party library** — `src/worker/discord-ipc.mjs`. The file
header states it replaces `@xhayper/discord-rpc` because that library has a hardcoded 10-second IPC
handshake timeout; this client uses `timeoutMs = 30000`. Frame format
`[opcode u32 LE][length u32 LE][JSON]`; opcodes `0 HANDSHAKE, 1 FRAME, 2 CLOSE, 3 PING, 4 PONG`;
handshake `{v:1, client_id}`; `SET_ACTIVITY` is fire-and-forget. `package.json` has no deps.

### 3.4 IPC socket discovery + reconnect handling

- Discord IPC socket discovery (`getSocketPaths` in `src/worker/discord-ipc.mjs`): candidate temp
  dirs `XDG_RUNTIME_DIR`, `TMPDIR`, `TMP`, `TEMP`, `/tmp`, joined with `discord-ipc-{id}` for ids
  `0,1,2`; skips non-existent paths; Windows named pipes handled via path prefix (per comments).
- Connect timeout 30 s; tracks `lastPongAt` and exposes `isHealthy(maxAgeMs)`; a PING-based health
  check exists but the daemon comment says it was disabled as "too aggressive" — disconnect now
  trusted from socket `close`/`error` and write-callback errors (`_markDisconnected`).
- Daemon reconnect (`src/worker/daemon.mjs`): `INITIAL_RECONNECT_BACKOFF_MS = 5000`,
  `MAX_RECONNECT_BACKOFF_MS = 30000`, ×1.5 growth; `scheduleReconnect()` on Discord IPC death.
- Plugin↔daemon local transport (`src/shared/paths.js`, `src/plugin/daemon-client.js`): Unix socket
  `~/.config/opencode/.opencode-rich-presence.sock`; on `win32` prefixed as `\\.\pipe\<name>`.
  Newline-delimited JSON protocol `hello`/`state`/`goodbye`; daemon replies `ack`/`discord-state`.
- Daemon spawn trigger = first `chat.message` (`ensureDaemonAndConnect`), stale-socket cleanup,
  `EADDRINUSE` listen retry up to 15 s, and the daemon **stays alive** after the last client
  disconnects (only SIGINT/SIGTERM exits it) to avoid Discord App-ID reconnect cooldowns
  (`src/worker/daemon.mjs`, `src/plugin/index.js`).

### 3.5 Config format + options

Global file `~/.config/opencode/discord-config.json` (honours `OPENCODE_CONFIG_DIR`) — **not
per-project** (`src/shared/paths.js`, `src/plugin/config-resolver.js`). Priority:
env > config file > fallback. Fields (README "Customization" + `config/discord-config.example.json`):

| Field | Meaning |
|---|---|
| `discordAppId` | app id; env `DISCORD_APP_ID`; fallback `1512803991300476989` |
| `discordLargeImageKey` | asset key; env `DISCORD_LARGE_IMAGE_KEY`; fallback `opencode-logo-too-opencode-rpc` |
| `discordLargeImageText` | asset text; env `DISCORD_LARGE_IMAGE_TEXT`; default `OpenCode` |
| `currency` | cost symbol (default `$`) |
| `replacements[]` | wildcard `{vars, from, to}` text replacements |
| `presence.details` / `.state` / `.largeImageText` / `.smallImageText` | templates |
| `presence.byState.<State>` | per-state overrides |
| `presence.idle`, `presence.home` | idle/no-session template sets |

Template variables include `{model}`, `{modelCode}`, `{modelName}`, `{modelNameLower}`, `{mode}`,
`{state}`, `{context}`, `{contextCompact}`, `{contextPercent}`, `{contextLimit}`, `{prompts}`,
`{cost}`, `{costCompact}`, `{elapsed}`, `{provider}`; supports `{{#if ...}}...{{else}}...{{/if}}`,
`{var|fallback}` and `replacements` (README "Available Variables"; `src/shared/constants.js`
`VALID_TEMPLATE_VARS`).

### 3.6 Presence fields shown

`renderPresence` in `src/plugin/local-presence.js` returns `details`, `state`, `largeImageKey`,
`largeImageText`, `smallImageText`; `discord-ipc.mjs` adds `timestamps: { start }`. **No `buttons`,
no `party`.** Discord field hard limit 128 chars (`src/shared/constants.js` `MAX_DISCORD_FIELD`;
truncation in `local-presence.js`).

### 3.7 Cross-platform support, multi-session, session stats

- **Cross-platform**: README "Requirements"/"Platform Notes" — Linux + macOS supported, CI on
  Node 20/22/24; Windows requires named-pipe support that "is not part of CI" and is
  "not actively tested". `docs/ARCHITECTURE.md` has a per-OS matrix (config dir, logs, daemon
  socket, Discord IPC). `docs/PLATFORM-NOTES.md` covers Flatpak/Snap Discord detection,
  macOS `open -a Discord`, Windows `wmic`+`taskkill`, WSL paths.
- **Multi-session**: daemon holds per-PID instances (`instances` Map) and picks the global
  most-recently-active instance whose state is not `"Waiting for command"` (falls back to most
  recent overall) — `pickDisplayedInstance`/`pushCurrentPresence` in `src/worker/daemon.mjs`.
  Per-instance state snapshots at `~/.config/opencode/presence-state-pid<pid>.txt`
  (`src/plugin/index.js`). Push throttled to `DISCORD_PUSH_INTERVAL_MS = 4000` with a payload
  fingerprint to dedupe; throttle resets on instance switch.
- **Session stats**: full implementation. `src/plugin/session-state.js` aggregates per assistant
  message: `_cost`, tokens `{input, output, reasoning, cache{read, write}}`, context tokens
  (`_latestContextTokens` = latest input + cache.read), `contextPercent` from `modelLimit`,
  `promptCount`, `startedAt`/`lastActivity`. Message aggregation keys by message id and replaces
  prior values on update (avoids double counting). Model context limits resolved from
  `client.provider.list`, then `opencode.json(c)` `provider.*.models.*.limit.context`, then
  `FALLBACK_MODEL_LIMITS` (`src/plugin/index.js`, `src/shared/constants.js`).

---

## 4. Comparison matrix

Legend: ✅ implemented · ⚠️ partial · ❌ absent.

| Dimension | Puri12/opencode-discord-presence | phoenixak/opencode-discord-rpc | Khip01/opencode-rich-presence |
|---|---|---|---|
| **Language / build** | TS, `tsc` → `dist/`, Biome, bun tests | TS, `tsc` → `dist/` | JS ESM, no build, zero deps |
| **Version** | 0.7.2 | 1.0.1 | 3.2.0 |
| **Entry / export** | `src/index.ts` default `OpenCodeDiscordPresence` | `src/index.ts` named+default `DiscordRPCPlugin` | `src/plugin/index.js` named+default `OpencodeRichPresence` |
| **Module layout** | `services/ state/ types/ utils/` | flat `index.ts discord.ts config.ts` | `shared/ plugin/ worker/ cli/` |
| **Hooks used** | `chat.message`, `tool.execute.before/after`, `event`, `dispose`, SIGINT/SIGTERM | `chat.message`, `chat.params`, `tool.execute.before/after`, `event` (no dispose) | `chat.message`, `event`, `dispose`, + 5 s SDK polling |
| **Transport lib** | `@xhayper/discord-rpc ^1.3.4` | `@xhayper/discord-rpc ^1.3.0` | **custom inline IPC** (`discord-ipc.mjs`), 30 s handshake timeout |
| **IPC socket discovery** | delegated to library | delegated to library | explicit: XDG/TMP dirs + `discord-ipc-{0,1,2}`, Windows pipe |
| **Auto-reconnect** | ✅ 5 s × 10, generation guard, debounce, clear-on-drop, self-heal | ⚠️ 15 s × 5, restore presence, no generation guard | ✅ daemon backoff 5 s→30 s ×1.5, write-error detection |
| **Config format** | `.discord-presence.json` (project + home) + env | env vars only | `~/.config/opencode/discord-config.json` + env |
| **Per-project config** | ✅ (project file wins) | ❌ | ❌ (global only) |
| **Custom app id** | ✅ `applicationId` / env | ✅ `OPENCODE_DISCORD_CLIENT_ID` | ✅ `discordAppId` / `DISCORD_APP_ID` |
| **Custom assets** | ⚠️ fixed keys (`opencode-logo`, `state-*`) not user-configurable | ❌ hardcoded keys | ✅ `discordLargeImageKey` + text |
| **Presence fields** | details, state, startTimestamp, large/small image + text, **buttons** | details, state, startTimestamp, large/small image + text, **buttons** | details, state, startTimestamp, large/small image + text |
| **Buttons / links** | ✅ "View on GitHub" | ✅ "Visit OpenCode.ai" | ❌ |
| **Party** | ❌ | ❌ | ❌ |
| **Idle handling** | ✅ `session.idle` + all-sessions-idle orchestrator | ⚠️ status strings only | ✅ `Waiting` state + idle template set |
| **Privacy controls** | ⚠️ file spotlight opt-in; no hide-cost/model toggle | ✅ never shows path/files/code (README) | ❌ always shows model/context/cost |
| **Cross-platform** | library-managed; no OS-specific code | library-managed; no OS-specific code | explicit Linux/macOS; Windows pipe present but untested |
| **Multi-session** | ✅ file-based leader election, last-active wins, main/sub filter | ❌ single singleton client | ✅ daemon single connection, global most-recent-active |
| **Session stats** | ⚠️ prompts + files + duration; `cost`/`tokenUsage` fields declared but unused | ❌ model + elapsed only | ✅ cost, tokens (in/out/reasoning/cache), context %, prompts, elapsed |
| **Testing** | bun tests + Playwright | none found | Node harness scripts |

---

## 5. Gap list mapped to the 5 target features

### (a) Session stats — model / token / cost
- **Best reference: Khip01.** `src/plugin/session-state.js` (`addOrUpdateMessage`) + `message.updated`
  handler in `src/plugin/index.js` give per-session cost, token breakdown, context %, prompt count,
  elapsed; model limits come from `client.provider.list` → `opencode.json(c)` → fallback table.
- **Puri12** declares `tokenUsage?`/`cost?` on `SessionMetrics` (`src/state/presence-state.ts`) but
  never assigns them; only prompts/files/duration are real.
- **phoenixak** has none.
- **Gap to close for us:** implement message-level cost/token aggregation keyed by message id (delta
  replace, not sum), context-token tracking, model-context-limit resolution, and surface them as a
  rotating "session stats" card. None of the three expose cost privacy toggles.

### (b) Cross-platform IPC + auto-reconnect
- **Khip01** is the only one with explicit socket discovery (`XDG_RUNTIME_DIR`/`TMPDIR`/`TMP`/`TEMP`/
  `/tmp` + `discord-ipc-{0,1,2}`) and a documented Windows named-pipe path, but Windows is untested.
- **Puri12** has the most robust reconnect logic (generation guard, debounce, self-heal, clear on
  drop) but delegates socket discovery to the library.
- **phoenixak** reconnects but with no guard/debounce and a higher interval.
- **Gap to close for us:** combine explicit cross-platform socket-path discovery with Puri12-style
  hardened reconnect (generation counter, backoff cap, stale-socket cleanup, clear-on-disconnect).
  Note the `@xhayper/discord-rpc` hardcoded 10 s handshake timeout that motivated Khip01's custom
  client.

### (c) Privacy / idle + per-project config
- **Puri12** is the only repo with per-project config and an explicit privacy default
  (`enableFileSpotlight: false`) plus `mainAgentOnly` sub-agent filtering.
- **phoenixak** is privacy-conscious by design but env-only.
- **Khip01** has the richest idle templates but global-only config and always-visible cost/context.
- **Gap to close for us:** per-project override file + granular privacy toggles (hide file paths,
  hide cost, hide model) + configurable idle detection; merge Khip01's idle template idea with
  Puri12's project-scoped config precedence.

### (d) Custom app id & assets
- All three support a custom app id. **Puri12** supports custom app id but hardcodes asset keys;
  **Khip01** supports custom app id **and** asset key/text; **phoenixak** hardcodes assets.
- **Gap to close for us:** configurable app id + large/small asset keys + asset text, plus docs for
  the Discord Developer Portal (create app, upload art assets, copy Application ID) — covered by
  Puri12 README and Khip01 `docs/INSTALL.md`.

### (e) Buttons/links + multi-session
- **Puri12** and **phoenixak** implement Discord `buttons`; **Khip01** does not.
- **Puri12** (file-based election) and **Khip01** (daemon) both solve multi-session; **phoenixak**
  does not.
- **Gap to close for us:** configurable buttons/links **and** a multi-session display strategy.
  Decide between Khip01's daemon (one persistent connection, no handoff gap, but a long-lived
  subprocess) and Puri12's file election (lighter, but a handoff settle window and no single
  connection guarantee). Discord allows only one IPC connection per app id, so one of the two is
  mandatory for multi-window correctness.

---

## 6. Lessons learned / reusable patterns

1. **One Discord IPC connection per app id is a hard constraint.** Both serious multi-session
   designs address it: Khip01 with a long-lived daemon that owns the socket and pushes state
   in place, Puri12 with file-based leader election + a 1200 ms handoff settle window
   (`src/worker/daemon.mjs`; `src/services/instance-coordinator.ts`, `src/plugin.ts`).
2. **Fire-and-forget `SET_ACTIVITY` + throttle.** Khip01 throttles to 4 s and dedupes by payload
   fingerprint to respect Discord's 5-updates-per-20-s limit, and re-arms a delayed push so the
   final state always lands (`src/worker/daemon.mjs`).
3. **Custom IPC client when the library's timeout is not configurable.** Khip01 replaced
   `@xhayper/discord-rpc` because of its hardcoded 10 s handshake timeout and uses 30 s
   (`src/worker/discord-ipc.mjs`). Reuse its frame codec (opcode/length/JSON, handshake, PING/PONG).
4. **Generation counters prevent zombie reconnects.** Puri12's `clientGeneration` stops a stale
   `ready` from an old client flipping `connected` back on (`src/services/discord-rpc.ts`).
5. **Debounce presence updates.** Puri12 debounces `setActivity` at 100 ms; phoenixak updates on
   every event with no debounce (`src/services/discord-rpc.ts` vs `src/discord.ts`).
6. **Clear activity on shutdown/disconnect.** Discord does not expire presence; Puri12 clears in
   `disconnect()`, Khip01 clears on last-instance goodbye (`discord-rpc.ts`; `daemon.mjs`).
7. **Session-stat aggregation must be idempotent.** Khip01 keys tokens/cost by message id and
   subtracts the previous value before re-adding on update (`session-state.js`), preventing double
   counting from repeated `message.updated` events.
8. **Model context limits need a 3-tier resolution:** SDK `provider.list` → local
   `opencode.json(c)` provider config → hardcoded fallback table (`src/plugin/index.js`,
   `src/shared/constants.js`).
9. **Main vs sub-agent session detection** via `info.parentID` with an SDK fallback and negative
   cache (Puri12 `SessionTracker`) enables a `mainAgentOnly` privacy/anti-flicker mode.
10. **Privacy-by-default.** Puri12 ships file spotlight off because Discord broadcasts presence to
    anyone viewing the profile; phoenixak documents never exposing paths/code (Puri12 README,
    phoenixak README "Privacy").
11. **Non-blocking startup.** Puri12 fires `connect()` fire-and-forget so OpenCode bootstrap is not
    stalled by the ~10 s IPC timeout when Discord is closed (`startPluginAsync` in `src/plugin.ts`);
    Khip01 spawns the daemon lazily on first `chat.message` rather than on plugin load.
12. **Template engine > hardcoded strings.** Khip01's `{var}`/`{{#if}}`/`{var|fallback}` templates
    with `byState` overrides and `replacements` are far more flexible than Puri12/phoenixak's
    hardcoded presence strings (`src/plugin/template-engine.js`, `src/shared/constants.js`).
13. **`unref()` every timer** so background rotation/reconnect/daemon timers do not keep the
    process alive (Puri12 and Khip01 both do this consistently).
14. **Config precedence `env > project file > home file > fallback`** is the pattern Puri12 uses;
    Khip01 uses `env > global file > fallback`. Per-project is only in Puri12.
15. **Cross-platform path convention:** opencode normalizes to `~/.config/opencode/` on all OSes;
    use `os.homedir()`/`os.tmpdir()`/`path.join()` and `process.platform === "win32"` for named
    pipes (`src/shared/paths.js`, `docs/ARCHITECTURE.md`).

---

## 7. Source index (raw URLs)

Puri12/opencode-discord-presence:
- `package.json` — https://raw.githubusercontent.com/Puri12/opencode-discord-presence/main/package.json
- `README.md` — https://github.com/Puri12/opencode-discord-presence
- `src/index.ts` — https://raw.githubusercontent.com/Puri12/opencode-discord-presence/main/src/index.ts
- `src/plugin.ts` — https://raw.githubusercontent.com/Puri12/opencode-discord-presence/main/src/plugin.ts
- `src/config.ts` — https://raw.githubusercontent.com/Puri12/opencode-discord-presence/main/src/config.ts
- `src/types/index.ts` — https://raw.githubusercontent.com/Puri12/opencode-discord-presence/main/src/types/index.ts
- `src/services/discord-rpc.ts` — https://raw.githubusercontent.com/Puri12/opencode-discord-presence/main/src/services/discord-rpc.ts
- `src/services/instance-coordinator.ts` — https://raw.githubusercontent.com/Puri12/opencode-discord-presence/main/src/services/instance-coordinator.ts
- `src/services/presence-orchestrator.ts` — https://raw.githubusercontent.com/Puri12/opencode-discord-presence/main/src/services/presence-orchestrator.ts
- `src/services/session-tracker.ts` — https://raw.githubusercontent.com/Puri12/opencode-discord-presence/main/src/services/session-tracker.ts
- `src/state/presence-state.ts` — https://raw.githubusercontent.com/Puri12/opencode-discord-presence/main/src/state/presence-state.ts
- `src/utils/activity-rotation.ts` — https://raw.githubusercontent.com/Puri12/opencode-discord-presence/main/src/utils/activity-rotation.ts
- `src/utils/session-metrics.ts` — https://raw.githubusercontent.com/Puri12/opencode-discord-presence/main/src/utils/session-metrics.ts
- `.discord-presence.json` — https://raw.githubusercontent.com/Puri12/opencode-discord-presence/main/.discord-presence.json

phoenixak/opencode-discord-rpc:
- `package.json` — https://raw.githubusercontent.com/phoenixak/opencode-discord-rpc/main/package.json
- `README.md` — https://github.com/phoenixak/opencode-discord-rpc
- `src/index.ts` — https://raw.githubusercontent.com/phoenixak/opencode-discord-rpc/main/src/index.ts
- `src/discord.ts` — https://raw.githubusercontent.com/phoenixak/opencode-discord-rpc/main/src/discord.ts
- `src/config.ts` — https://raw.githubusercontent.com/phoenixak/opencode-discord-rpc/main/src/config.ts

Khip01/opencode-rich-presence:
- `package.json` — https://raw.githubusercontent.com/Khip01/opencode-rich-presence/main/package.json
- `README.md` — https://github.com/Khip01/opencode-rich-presence
- `src/plugin/index.js` — https://raw.githubusercontent.com/Khip01/opencode-rich-presence/main/src/plugin/index.js
- `src/plugin/config-resolver.js` — https://raw.githubusercontent.com/Khip01/opencode-rich-presence/main/src/plugin/config-resolver.js
- `src/plugin/session-state.js` — https://raw.githubusercontent.com/Khip01/opencode-rich-presence/main/src/plugin/session-state.js
- `src/plugin/daemon-client.js` — https://raw.githubusercontent.com/Khip01/opencode-rich-presence/main/src/plugin/daemon-client.js
- `src/plugin/local-presence.js` — https://raw.githubusercontent.com/Khip01/opencode-rich-presence/main/src/plugin/local-presence.js
- `src/worker/daemon.mjs` — https://raw.githubusercontent.com/Khip01/opencode-rich-presence/main/src/worker/daemon.mjs
- `src/worker/discord-ipc.mjs` — https://raw.githubusercontent.com/Khip01/opencode-rich-presence/main/src/worker/discord-ipc.mjs
- `src/shared/paths.js` — https://raw.githubusercontent.com/Khip01/opencode-rich-presence/main/src/shared/paths.js
- `src/shared/constants.js` — https://raw.githubusercontent.com/Khip01/opencode-rich-presence/main/src/shared/constants.js
- `config/discord-config.example.json` — https://raw.githubusercontent.com/Khip01/opencode-rich-presence/main/config/discord-config.example.json
- `docs/ARCHITECTURE.md` — https://raw.githubusercontent.com/Khip01/opencode-rich-presence/main/docs/ARCHITECTURE.md
- `docs/PLATFORM-NOTES.md` — https://raw.githubusercontent.com/Khip01/opencode-rich-presence/main/docs/PLATFORM-NOTES.md
