# Configuration — opencode Discord Rich Presence

> Source of truth: [`ARCHITECTURE.md §5`](./ARCHITECTURE.md#5-config-schema) (45 options).
> Related: [`DISCORD-RPC.md`](./DISCORD-RPC.md) (wire/IPC), [`ARCHITECTURE.md §6`](./ARCHITECTURE.md#6-transport-abstraction) (transport), [`PRESENCE-DESIGN.md`](./PRESENCE-DESIGN.md) (presence-engine vision).

---

## Table of Contents

1. [Quick start](#1-quick-start)
2. [Precedence & resolution](#2-precedence--resolution)
3. [Feature sections](#3-feature-sections)
4. [Full reference (all 45 options)](#4-full-reference-all-45-options)
5. [Option details by group](#5-option-details-by-group)
6. [Example configs](#6-example-configs)
7. [Validation & troubleshooting](#7-validation--troubleshooting)

---

## 1. Quick start

The plugin requires no config — defaults are usable. Create either config layer:

**Project file** — `<projectRoot>/.discord-presence.json`:

```json
{
  "applicationId": "1234567890123456789",
  "largeImageKey": "opencode",
  "detailsTemplate": "Working with {model}"
}
```

**Runtime (`opencode.json`)** — highest precedence:

```json
{
  "plugin": [
    ["@vheins/opencode-discord-rich-presence", { "debug": true, "privacy": { "hideFilePaths": true } }]
  ]
}
```

Env vars override files; runtime overrides env. See §2.

---

## 2. Precedence & resolution

**Lowest → highest:** `global file < project file < env var < runtime PluginOptions`.

| Priority | Source | Location / form |
|---|---|---|
| 1 (lowest) | Global file | `~/.config/opencode/discord-presence.json` (honours `OPENCODE_CONFIG_DIR`) |
| 2 | Project file | `<projectRoot>/.discord-presence.json` or `perProject.filename` |
| 3 | Env vars | `OPENCODE_DISCORD_*` / `DISCORD_*` (see §4 table) |
| 4 (highest) | Runtime | `opencode.json` → `plugin: [["@vheins/opencode-discord-rich-presence", { … }]]` tuple second element |

**Merge rule** — objects deep-merge, **arrays replace**, scalars replace.
That means a higher layer's `buttons` replaces the lower layer's entirely (no concat).

**Loader:** `src/config/loader.ts` (`ConfigLoader.load(cwd, runtimeOptions)`),
schema in `src/config/schema.ts` (zod). On parse failure the plugin logs `warn`
and falls back to defaults for that subtree — never crashes load.

### Resolution examples

**Example A — env overrides file:**

```jsonc
// ~/.config/opencode/discord-presence.json
{ "idle": { "timeoutMs": 300000 }, "privacy": { "hideCost": false } }
```

```bash
export OPENCODE_DISCORD_HIDE_COST=1   # → privacy.hideCost = true
export OPENCODE_DISCORD_IDLE_TIMEOUT=60000  # → idle.timeoutMs = 60000
```

Result: `idle.timeoutMs = 60000` (env wins), `privacy.hideCost = true` (env wins).

**Example B — runtime overrides everything:**

```jsonc
// opencode.json
{ "plugin": [["@vheins/opencode-discord-rich-presence", { "enabled": false }]] }
```

```bash
export OPENCODE_DISCORD_ENABLED=true  # would enable, but runtime says false
```

Result: `enabled = false` (runtime wins). Plugin registers no hooks, makes no IPC connection.

**Example C — per-project extension of global defaults:**

```jsonc
// Global: { "largeImageKey": "opencode", "buttons": [{ "label": "Docs", "url": "https://example.com" }] }
// Project .discord-presence.json: { "privacy": { "hideProjectPath": true } }
```

Result: `largeImageKey = "opencode"` (inherited from global), `privacy.hideProjectPath = true` (project overlay),
`buttons` unchanged (no project `buttons` → global value kept).

---

## 3. Feature sections

### 3a. Session stats — model / tokens / cost / elapsed

| Option | What it shows |
|---|---|
| `sessionStats.showModel` | Model/provider in `details` (`{model}`) |
| `sessionStats.showTokens` | Token counts in `state` (`{tokens}`) |
| `sessionStats.showCost` | Dollar cost in `state` (`{cost}`) |
| `sessionStats.showElapsed` | `timestamps.start` elapsed timer |
| `privacy.hideModel` / `privacy.hideCost` | Hard overrides — strip even if `sessionStats.*` is true |
| `detailsTemplate` / `stateTemplate` | Control the rendered text; vars `{model}` `{provider}` `{project}` `{file}` `{elapsed}` `{done}` `{total}` `{contextPercent}` |

`SessionStats` is built in `src/core/session-tracker.ts` (idempotent by `messageID`,
replace-not-sum per `OPENCODE-PLUGIN-API.md §11.3`) and rendered in
`src/core/presence-model.ts`.

### 3b. Cross-platform IPC + reconnect

Discord IPC discovery is automatic — no config needed for path.
See `src/discord/ipc.ts` + `DISCORD-RPC.md §2`:

- Windows: `\\?\pipe\discord-ipc-{0..9}`
- Unix: `$XDG_RUNTIME_DIR` → `$TMPDIR` → `$TMP` → `$TEMP` → `/tmp` + `/discord-ipc-{n}`, scan `0..9`.

Reconnect is owned by `src/discord/reconnect.ts` (§6.2):

| Option | Effect |
|---|---|
| `reconnect.enabled` | Auto-retry on drop |
| `reconnect.baseMs` / `reconnect.capMs` | Exponential backoff window |
| `reconnect.maxAttempts` | After N failures → `closed` (needs next user event to re-arm) |
| `reconnect.jitterRatio` | ± randomisation |
| `reconnect.handshakeTimeoutMs` | How long to wait for `READY` before treating as failure |
| `throttle.debounceMs` / `throttle.minIntervalMs` | Rate-limit to ≤ 5 `SET_ACTIVITY`/20 s (enforced 4 s min gap + dedupe) |

### 3c. Privacy / idle / per-project

| Group | Options | Effect |
|---|---|---|
| Privacy | `privacy.hideProjectPath` `hideModel` `hideCost` `hideFilePaths` | Strip sensitive fields from `details`/`state`; `hideFilePaths` is `true` by default |
| Idle | `idle.enabled` `idle.timeoutMs` `idle.details` `idle.state` | Distinct presence after inactivity; `idle.timeoutMs` clamped 10 s..1 h |
| Per-project | `perProject.enabled` `perProject.filename` | Look for `<projectRoot>/<filename>` and merge on top of global |

All privacy decisions live in `src/core/presence-model.ts`.

### 3d. Custom Discord app & assets

| Option | Effect |
|---|---|
| `applicationId` | Discord Application ID (`/^\d{17,20}$/`). Empty → bundled `DEFAULT_CLIENT_ID` |
| `largeImageKey` / `largeImageText` | Large thumbnail key (lower-cased) or `mp:`/`https://` URL + hover text |
| `smallImageKey` / `smallImageText` | Overlay icon (omit = no overlay) + hover text |
| `assets.validate` | Validate keys, URLs, types, button count before sending |

Keys are lower-cased per `DISCORD-RPC.md §5`; validation in `src/discord/presence.ts`.
Asset slot empty on miss — rest of presence still displays.

### 3e. Buttons & multi-session

| Option | Effect |
|---|---|
| `buttons` | Up to 2 `{ label 1..32, url 1..512 https:// }`; `[]` = none. Only visible to *other* users |
| `multiSession.strategy` | `leader-election` (file-based, stale GC 10 s, settle ~1200 ms) or `last-wins` — see `src/core/session-tracker.ts` |

Only the picked session pushes `SET_ACTIVITY` (single Discord IPC slot).

### 3f. Presence engine

The engine turns opencode events into a Discord activity. The **Tool Activity Resolver** maps the active tool to human-readable text — generic labels (`Thinking`, `Working`) are forbidden. Three sources normalize to one model:

| Source | Example | Normalized |
|---|---|---|
| Builtin | `read`, `edit`, `write`, `bash`, `grep`, `glob`, `lsp`, `patch`, `todo`, `task` | `Reading auth.service.ts` |
| Custom | user-defined or plugin tool | tool name + action |
| MCP (first-class) | `mcp__github__search_code` | `GitHub • Searching repository` |

The unified `ToolActivity` model is `{ source, provider?, tool, action, target?, phrase }`.

MCP is parsed generically as `mcp__<provider>__<tool>`; unknown providers/tools fall back to `MCP • Running <tool> • <phrase>` — no engine change per server. Rendering is `<Activity> • <Phrase>`; phrases come from `phrases.details`/`phrases.state` (non-empty overrides the matching `*Template`; template vars such as `{project}` are expanded), selected per `phrases.mode`, rotated per `phrases.rotateMs`, and gated by `phrases.cooldownMs`.

**Telemetry** — context `150.4K (57%)` (`presence.showContext`) and TODO `TODO 4/9` (`presence.showTodo`) both merge into `state`, because Discord renders only two text lines (`details` + `state`) — `PRESENCE-DESIGN.md` §16.2. `presence.showSessionTitle` puts the session title in `details`; `presence.showMcpProvider` keeps the provider name on MCP activities. **Event priority**: `ERROR > PERMISSION > MCP/TOOL > FILE > THINKING > IDLE`. `activityType` defaults to `playing`; `listening` is the Spotify-like option (RPC `type` 2).

### 3g. Vision-key reconciliation

`PRESENCE-DESIGN.md §15` uses vision JSON keys. Canonical option names (new options included) are:

| Vision key | Canonical option | Status |
|---|---|---|
| `identity.name` | `activityName` | new — best-effort (`PRESENCE-DESIGN.md` §16.1) |
| `identity.type` | `activityType` | new — `Playing` → `playing` |
| `identity.largeImage` / `largeText` | `largeImageKey` / `largeImageText` | existing (reconciled) |
| `presence.showSessionTitle` / `showContext` / `showTodo` / `showMcpProvider` | same name | new |
| `presence.showTimestamp` | `sessionStats.showElapsed` | existing (reconciled) |
| `presence.showModel` | `sessionStats.showModel` | existing |
| `presence.showAgent` | `smallImageText` tooltip | existing (metadata — `PRESENCE-DESIGN.md` §10) |
| `presence.showProject` | `{project}` in templates + `privacy.hideProjectPath` | existing |
| `presence.randomPhrases` | non-empty `phrases.details` / `phrases.state` | new |
| `behavior.updateDebounceMs` | `throttle.debounceMs` | existing (reconciled) |
| `behavior.idleTimeoutMs` | `idle.timeoutMs` | existing (reconciled) |
| `behavior.phraseCooldownMs` | `phrases.cooldownMs` | new |

**Spotify-style recipe** (`activityType: "listening"` + optional `activityName` + `phrases.details` using `{project}`):

```json
{ "activityType": "listening", "activityName": "Spotify",
  "phrases": { "details": ["{project}"], "state": ["Deep focus", "In the zone", "Shipping code"],
    "mode": "random", "rotateMs": 30000, "cooldownMs": 5000 } }
```

The top line renders `Listening to <AppName>`; `activityName` is best-effort (`PRESENCE-DESIGN.md` §16.1).

---

## 4. Full reference (all 45 options)

| # | Option | Type | Default | Env var | Description |
|---|---|---|---|---|---|
| 1 | `enabled` | `boolean` | `true` | `OPENCODE_DISCORD_ENABLED` (`"false"` disables) | Master toggle. `false` → no hooks, no connect. |
| 2 | `applicationId` | `string` | `""` → bundled `DEFAULT_CLIENT_ID` | `OPENCODE_DISCORD_CLIENT_ID` / `DISCORD_APP_ID` | Discord Application ID (`/^\d{17,20}$/`). |
| 3 | `debug` | `boolean` | `false` | `OPENCODE_DISCORD_DEBUG` | Verbose `client.app.log` (`level:"debug"`). |
| 4 | `largeImageKey` | `string` | `"opencode"` | `DISCORD_LARGE_IMAGE_KEY` | Art Asset key (lower-cased) or `mp:`/`https://` URL. 1..32 chars. |
| 5 | `largeImageText` | `string` | `"opencode"` | `DISCORD_LARGE_IMAGE_TEXT` | Hover text for large image. 1..128. |
| 6 | `smallImageKey` | `string \| undefined` | `undefined` | `DISCORD_SMALL_IMAGE_KEY` | Overlay icon key. Omit = no overlay. |
| 7 | `smallImageText` | `string \| undefined` | `undefined` | `DISCORD_SMALL_IMAGE_TEXT` | Hover text for small image. |
| 8 | `detailsTemplate` | `string` | `"Working with {model}"` | — | `details` template. Vars: `{model}` `{provider}` `{project}` `{file}` `{elapsed}`. |
| 9 | `stateTemplate` | `string` | `"{cost} · {tokens} tokens"` | — | `state` template. Same vars + `{done}` `{total}` `{contextPercent}`. |
| 10 | `activityType` | `"playing" \| "listening" \| "watching" \| "competing"` | `"playing"` | `OPENCODE_DISCORD_ACTIVITY_TYPE` | Activity `type` → RPC `0/2/3/5`. `1`/`4` invalid. `listening` = Spotify-like. |
| 11 | `activityName` | `string \| undefined` | `undefined` | `OPENCODE_DISCORD_ACTIVITY_NAME` | Activity `name` override, best-effort (`PRESENCE-DESIGN.md` §16.1). ≤128. |
| 12 | `phrases.details` | `string[]` | `[]` | — | `details` pool; non-empty overrides `detailsTemplate`. Template vars allowed. |
| 13 | `phrases.state` | `string[]` | `[]` | — | `state` pool; non-empty overrides `stateTemplate`. Template vars allowed. |
| 14 | `phrases.mode` | `"random" \| "sequential"` | `"random"` | — | Pool selection order. |
| 15 | `phrases.rotateMs` | `number` | `0` | `OPENCODE_DISCORD_ROTATE_MS` | `0` = once per transition; `>0` rotates (clamped 5000..3600000), timer `.unref()`. |
| 16 | `phrases.cooldownMs` | `number` | `5000` | — | Min gap before a new phrase (`PRESENCE-DESIGN.md` §15). |
| 17 | `privacy.hideProjectPath` | `boolean` | `false` | `OPENCODE_DISCORD_HIDE_PROJECT` | Omit project/directory from `details`. |
| 18 | `privacy.hideModel` | `boolean` | `false` | `OPENCODE_DISCORD_HIDE_MODEL` | Omit model; `details` → `"Working"`. |
| 19 | `privacy.hideCost` | `boolean` | `false` | `OPENCODE_DISCORD_HIDE_COST` | Omit cost from `state`. |
| 20 | `privacy.hideFilePaths` | `boolean` | `true` | `OPENCODE_DISCORD_HIDE_FILES` | Default on — no file names in presence. |
| 21 | `idle.enabled` | `boolean` | `true` | — | Idle shows distinct text vs last `active`. |
| 22 | `idle.timeoutMs` | `number` | `300000` (5 min) | `OPENCODE_DISCORD_IDLE_TIMEOUT` | Force `idle` after no activity. Clamped 10 s..1 h. |
| 23 | `idle.details` | `string` | `"Idle — ready"` | — | `details` when `idle`. |
| 24 | `idle.state` | `string` | `"{cost} · {tokens} tokens"` | — | `state` when `idle`. |
| 25 | `reconnect.enabled` | `boolean` | `true` | — | Auto-reconnect on IPC drop. |
| 26 | `reconnect.baseMs` | `number` | `1000` | — | First retry delay. |
| 27 | `reconnect.capMs` | `number` | `30000` | — | Max backoff. |
| 28 | `reconnect.maxAttempts` | `number` | `10` | `OPENCODE_DISCORD_MAX_RETRIES` | → `closed` after this many failures. |
| 29 | `reconnect.jitterRatio` | `number` | `0.2` | — | ±20% jitter. |
| 30 | `reconnect.handshakeTimeoutMs` | `number` | `10000` | — | Await `READY` timeout. |
| 31 | `throttle.debounceMs` | `number` | `100` | — | Coalesce window before `SET_ACTIVITY`. |
| 32 | `throttle.minIntervalMs` | `number` | `4000` | — | Min gap between sends (5/20 s → 4 s). |
| 33 | `assets.validate` | `boolean` | `true` | — | Validate `type ∈ {0,2,3,5}`, buttons ≤2, key/URL. |
| 34 | `buttons` | `Array<{label,url}>` | `[{label:"View on GitHub",url:"https://github.com/vheins/opencode-discord-rich-presence"}]` | — | Max 2. Label 1..32, url 1..512 `https://`. `[]` = none. |
| 35 | `multiSession.strategy` | `"leader-election" \| "last-wins"` | `"leader-election"` | — | Display pick when multiple instances run. |
| 36 | `sessionStats.showModel` | `boolean` | `true` | — | Include model (respects `hideModel`). |
| 37 | `sessionStats.showTokens` | `boolean` | `true` | — | Include token counts. |
| 38 | `sessionStats.showCost` | `boolean` | `true` | — | Include cost (respects `hideCost`). |
| 39 | `sessionStats.showElapsed` | `boolean` | `true` | — | Include `timestamps.start` timer. |
| 40 | `presence.showTodo` | `boolean` | `true` | — | Append `TODO 4/9` to `state` (`PRESENCE-DESIGN.md` §9). |
| 41 | `presence.showContext` | `boolean` | `true` | — | Append `150.4K (57%)` to `state` (`PRESENCE-DESIGN.md` §8). |
| 42 | `presence.showSessionTitle` | `boolean` | `true` | — | Use the session title as `details`. |
| 43 | `presence.showMcpProvider` | `boolean` | `true` | — | Show the MCP provider name on MCP activities. |
| 44 | `perProject.enabled` | `boolean` | `true` | — | Look for project-level file. |
| 45 | `perProject.filename` | `string` | `".discord-presence.json"` | — | Filename in `project.directory` / `worktree`. |

Every row traces to `ARCHITECTURE.md §5.1`. Count = **45**.

---

## 5. Option details by group

### `enabled` / `debug` / `applicationId`

| Option | Effect | Example |
|---|---|---|
| `enabled` | `false` short-circuits `src/plugin.ts` before any hook registration. | `{ "enabled": false }` or `OPENCODE_DISCORD_ENABLED=false` |
| `debug` | Routes every state/transport transition through `src/utils/logger.ts` → `client.app.log` at `debug` level. | `{ "debug": true }` |
| `applicationId` | Validated `/^\d{17,20}$/` when non-empty; sent as `client_id` in the `HANDSHAKE` (opcode 0). Empty `""` falls back to the bundled `DEFAULT_CLIENT_ID` (`1466770544748662819`), so zero config works. Create your own at https://discord.com/developers/applications. | `{ "applicationId": "1234567890123456789" }` |

### `largeImageKey` / `largeImageText` / `smallImageKey` / `smallImageText`

Lower-cased before send (`src/discord/presence.ts`). Accepts Art Asset key (1..32), `mp:` media-proxy id, or `https://` URL.
Text fields capped at 128 (historical `discord_rpc.h` limit — enforced by `assets.validate`).

```json
{ "largeImageKey": "opencode", "largeImageText": "opencode — AI editor", "smallImageKey": "editing", "smallImageText": "Editing" }
```

### `detailsTemplate` / `stateTemplate`

Mustache-style vars expanded in `src/core/presence-model.ts`:

- `detailsTemplate` vars: `{model}` `{provider}` `{project}` `{file}` `{elapsed}`
- `stateTemplate` adds: `{cost}` `{tokens}` `{done}` `{total}` `{contextPercent}`

Privacy filters run *after* template expansion — hidden vars are replaced with `""` and trimmed.

```json
{ "detailsTemplate": "Working with {model} on {project}", "stateTemplate": "{cost} · {tokens} tokens · {elapsed}" }
```

### `privacy.*`

Applied in `src/core/presence-model.ts` after template rendering:

| Option | Effect on presence |
|---|---|
| `hideProjectPath` | `{project}` and directory segments stripped from `details`. |
| `hideModel` | `{model}` → `""`; `details` falls back to `"Working"`. Overrides `sessionStats.showModel`. |
| `hideCost` | `{cost}` stripped from `state`. Overrides `sessionStats.showCost`. |
| `hideFilePaths` | `{file}` suppressed even when `tool.start` carries `filePath`. Default `true`. |

### `idle.*`

FSM transition `active/tool-running → idle` via `idle.timeout` event in `src/core/state-machine.ts`.

| Option | Effect | Example |
|---|---|---|
| `idle.enabled` | `false` → stay on last `active` presence forever. | `{ "idle": { "enabled": false } }` |
| `idle.timeoutMs` | Inactivity gate; clamped 10 s..1 h by `src/config/schema.ts`. | `{ "idle": { "timeoutMs": 60000 } }` |
| `idle.details` / `idle.state` | Text shown in `idle`; same template vars + privacy. | `{ "idle": { "details": "Idle — ready", "state": "{cost} · {tokens} tokens" } }` |

### `reconnect.*` + `throttle.*`

`reconnect.*` consumed by `src/discord/reconnect.ts`; `throttle.*` by
`src/core/presence-scheduler.ts`. See `ARCHITECTURE.md §6.2–6.3`.

| Option | Default | Effect | Example |
|---|---|---|---|
| `reconnect.baseMs` | `1000` | `nextDelay(0)` | `{ "reconnect": { "baseMs": 500 } }` |
| `reconnect.capMs` | `30000` | Max backoff | `{ "reconnect": { "capMs": 15000 } }` |
| `reconnect.maxAttempts` | `10` | → `closed` after N | `{ "reconnect": { "maxAttempts": 5 } }` |
| `reconnect.jitterRatio` | `0.2` | `exp ± 20%` | `{ "reconnect": { "jitterRatio": 0.3 } }` |
| `reconnect.handshakeTimeoutMs` | `10000` | `READY` wait | `{ "reconnect": { "handshakeTimeoutMs": 5000 } }` |
| `throttle.debounceMs` | `100` | Coalesce bursts | `{ "throttle": { "debounceMs": 200 } }` |
| `throttle.minIntervalMs` | `4000` | Throttle to ≤5/20 s | `{ "throttle": { "minIntervalMs": 5000 } }` |

### `assets.validate` / `buttons` / `multiSession.*` / `sessionStats.*` / `perProject.*`

| Option | Effect | Example |
|---|---|---|
| `assets.validate` | When `true` (default), `src/discord/presence.ts` rejects invalid types/buttons/keys and `src/core/presence-scheduler.ts` drops the update with `warn`. Set `false` to skip (not recommended). | `{ "assets": { "validate": false } }` |
| `buttons` | Array **replaces** on merge; max 2; `label` 1..32, `url` 1..512 `https://`. | `{ "buttons": [{ "label": "View Repo", "url": "https://github.com/…" }] }` |
| `multiSession.strategy` | `leader-election` = file lock + stale GC; `last-wins` = newest `touch()` wins. | `{ "multiSession": { "strategy": "last-wins" } }` |
| `sessionStats.*` | Toggle model/tokens/cost/elapsed independently (privacy still wins). | `{ "sessionStats": { "showCost": false } }` |
| `perProject.*` | `enabled:false` ignores project file entirely; `filename` customises lookup. | `{ "perProject": { "filename": ".presence.json" } }` |

### `activityType` / `activityName` / `phrases.*` / `presence.*`

| Option | Effect | Example |
|---|---|---|
| `activityType` | RPC activity verb. `playing`→0 (default), `listening`→2 (Spotify-like), `watching`→3, `competing`→5. `1`/`4` are rejected by `assets.validate`. | `{ "activityType": "listening" }` |
| `activityName` | Best-effort Activity `name` override (≤128). Discord renders `<Verb> <AppName>` where `AppName` is the registered app name — `PRESENCE-DESIGN.md` §16.1. | `{ "activityName": "Spotify" }` |
| `phrases.details` / `phrases.state` | Non-empty pool replaces the matching `*Template` for that line; entries may use template vars (`{project}`, `{model}`, …). | `{ "phrases": { "state": ["Deep focus"] } }` |
| `phrases.mode` / `phrases.rotateMs` / `phrases.cooldownMs` | Pool order; `0` = once per transition, `>0` rotates (clamped 5000..3600000, `.unref()`); cooldown is the min gap before a new phrase. | `{ "phrases": { "mode": "sequential", "rotateMs": 30000 } }` |
| `presence.show*` | `showTodo`/`showContext` append `TODO 4/9` / `150.4K (57%)` to `state`; `showSessionTitle` sets `details`; `showMcpProvider` keeps the MCP provider name. | `{ "presence": { "showTodo": false } }` |

---

## 6. Example configs

All examples are copy-pasteable and validate against `src/config/schema.ts`.

### Minimal — use defaults, just set app id

`~/.config/opencode/discord-presence.json`:

```json
{
  "applicationId": "1234567890123456789"
}
```

### Full — every knob set explicitly

`~/.config/opencode/discord-presence.json`:

```json
{
  "enabled": true,
  "debug": false,
  "applicationId": "1234567890123456789",
  "largeImageKey": "opencode",
  "largeImageText": "opencode — AI editor",
  "smallImageKey": "editing",
  "smallImageText": "Editing",
  "detailsTemplate": "Working with {model} on {project}",
  "stateTemplate": "{cost} · {tokens} tokens · {elapsed}",
  "activityType": "playing",
  "activityName": "opencode",
  "phrases": { "details": [], "state": [], "mode": "random", "rotateMs": 0, "cooldownMs": 5000 },
  "privacy": {
    "hideProjectPath": false,
    "hideModel": false,
    "hideCost": false,
    "hideFilePaths": true
  },
  "idle": {
    "enabled": true,
    "timeoutMs": 300000,
    "details": "Idle — ready",
    "state": "{cost} · {tokens} tokens"
  },
  "reconnect": {
    "enabled": true,
    "baseMs": 1000,
    "capMs": 30000,
    "maxAttempts": 10,
    "jitterRatio": 0.2,
    "handshakeTimeoutMs": 10000
  },
  "throttle": {
    "debounceMs": 100,
    "minIntervalMs": 4000
  },
  "assets": {
    "validate": true
  },
  "buttons": [{ "label": "View on GitHub", "url": "https://github.com/vheins/opencode-discord-rich-presence" }],
  "multiSession": {
    "strategy": "leader-election"
  },
  "sessionStats": {
    "showModel": true,
    "showTokens": true,
    "showCost": true,
    "showElapsed": true
  },
  "presence": { "showTodo": true, "showContext": true, "showSessionTitle": true, "showMcpProvider": true },
  "perProject": {
    "enabled": true,
    "filename": ".discord-presence.json"
  }
}
```

### Privacy-focused — hide sensitive fields

```json
{
  "applicationId": "1234567890123456789",
  "privacy": {
    "hideProjectPath": true,
    "hideModel": true,
    "hideCost": true,
    "hideFilePaths": true
  },
  "detailsTemplate": "Working",
  "stateTemplate": "In opencode",
  "buttons": []
}
```

### Per-project — override global for one repo

`~/my-private-repo/.discord-presence.json`:

```json
{
  "privacy": {
    "hideProjectPath": true,
    "hideFilePaths": true
  },
  "largeImageKey": "private-project",
  "largeImageText": "Private workspace",
  "buttons": []
}
```

Global keeps `largeImageKey: "opencode"` and buttons; this project overlays privacy + asset.

---

## 7. Validation & troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Presence never appears | `enabled:false` or Discord not running | Check `enabled`, start Discord; `debug:true` logs `disconnected → scheduleReconnect` |
| `warn: invalid applicationId` | `applicationId` not `/^\d{17,20}$/` | Use the numeric ID from the Developer Portal (decimal string) |
| `warn: invalid activity` dropped | `largeImageKey` >32, `buttons` >2, non-`https` URL | Set `assets.validate:true` (default) and fix the flagged field |
| Stale presence after quit | `clear()` is best-effort; Discord never expires presence | Expected — `dispose` sends `activity:null`; card clears on next overwrite or Discord restart |
| Config change ignored | Edited file but higher layer wins | Check precedence: runtime > env > project > global. Arrays **replace**. |
| Idle never triggers | `idle.enabled:false` or `timeoutMs` >1 h clamped | Set `idle.enabled:true` and a smaller `timeoutMs` |

Validate manually:

```bash
node -e "import('./src/config/schema.ts').then(m=>console.log(m))" # or run zod parse in a script
OPENCODE_DISCORD_DEBUG=1 opencode  # verbose logs
```

---

*45 options. Schema: `src/config/schema.ts`. Loader: `src/config/loader.ts`. Presence rendering: `src/core/presence-model.ts`. Transport: `src/core/presence-scheduler.ts` + `src/discord/reconnect.ts` + `src/discord/transport.ts` + `src/discord/ipc.ts`.*
