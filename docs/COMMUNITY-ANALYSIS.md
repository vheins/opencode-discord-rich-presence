# Community Analysis — opencode Discord Presence Plugins

> Parent: `ROOT-001` · Source task: `DISC-001` · Design target: [`ARCHITECTURE.md`](./ARCHITECTURE.md) · Raw research: [`_research/community-plugins.md`](./_research/community-plugins.md).
> All comparative claims cite the raw research or the source file/URL they came from. No claim is inferred without flagging it.

---

## Table of Contents

1. [Scope & Method](#1-scope--method)
2. [Sources](#2-sources)
3. [Comparison Matrix](#3-comparison-matrix)
4. [Per-Plugin Notes](#4-per-plugin-notes)
5. [Lessons Learned](#5-lessons-learned)
6. [Improvements Adopted per Target Feature](#6-improvements-adopted-per-target-feature)
7. [What We Intentionally Don't Adopt](#7-what-we-intentionally-dont-adopt)
8. [References](#8-references)

---

## 1. Scope & Method

This doc synthesizes `docs/_research/community-plugins.md` (task `DISC-001`, produced 2026-09-11 by read-only inspection of the three repos on their `main` branch at the SHAs in §2). Every row in §3 traces to a section of that research file or to a raw URL listed in §8. Where a behaviour is inferred rather than stated, the inference is flagged as such.

Our design column ("This plugin") reflects `docs/ARCHITECTURE.md` (task `ARCH-001`). It is included so gaps are actionable, not just descriptive. The roadmap that consumes this analysis is [`ROADMAP.md`](./ROADMAP.md).

The 5 target features this project must deliver (from `ARCH-001` §5.1) are:

| Key | Feature |
|---|---|
| (a) | Session stats — model / token / cost |
| (b) | Cross-platform IPC + auto-reconnect |
| (c) | Privacy / idle + per-project config |
| (d) | Custom app id & assets |
| (e) | Buttons / links + multi-session |

---

## 2. Sources

Analyzed revisions (pinned at research time; `main` HEAD 2026-09-11):

| Repo | Language | Stars | Version | `main` SHA | Package |
|---|---|---|---|---|---|
| [Puri12/opencode-discord-presence](https://github.com/Puri12/opencode-discord-presence) | TypeScript | ~18 | `0.7.2` | `b0af0b908d15a5e3cc17bbc5b50831aa4dec444c` | `opencode-discord-presence@0.7.2` |
| [phoenixak/opencode-discord-rpc](https://github.com/phoenixak/opencode-discord-rpc) | TypeScript | ~4 | `1.0.1` | `eebd89e9d0997f179af9b8092ec5e7da6a1efdb2` | `opencode-discord-rpc@1.0.1` |
| [Khip01/opencode-rich-presence](https://github.com/Khip01/opencode-rich-presence) | JavaScript (ESM) | ~1 | `3.2.0` | `ac03601a8c83914bc6316c0e247ecbb0ec3a258a` | `opencode-rich-presence@3.2.0` |

> Star counts are approximate at time of writing and are not load-bearing. SHAs are the `main` tip returned by `github_list_branches` during `DISC-001`.

Raw URL prefix for all cited files: `https://raw.githubusercontent.com/<owner>/<repo>/main/<path>`. Full source index in §8.

---

## 3. Comparison Matrix

Legend: ✅ implemented · ⚠️ partial / declared-but-incomplete · ❌ absent · — not applicable.

| Dimension | Puri12 `opencode-discord-presence` | phoenixak `opencode-discord-rpc` | Khip01 `opencode-rich-presence` | This plugin (`ARCHITECTURE.md`) |
|---|---|---|---|---|
| **Language / build** | TS, `tsc` → `dist/`, Biome, `bun test` | TS, `tsc` → `dist/` | JS ESM, no build, zero deps | **TS strict**, `tsc` → `dist/`, Biome/lint, `bun`/`node` tests |
| **Transport lib** | `@xhayper/discord-rpc ^1.3.4` (`src/services/discord-rpc.ts`) | `@xhayper/discord-rpc ^1.3.0` (`src/discord.ts`) | Custom inline IPC `src/worker/discord-ipc.mjs` (30 s handshake) | **Abstract `Transport` iface** (`discord/transport.ts`) — library swappable, per-connection `FrameDecoder` (fixes coalesced-frame bug — `DISCORD-RPC.md` §3.1) |
| **IPC socket discovery** | Delegated to library (no path code) | Delegated to library | Explicit: `XDG_RUNTIME_DIR`/`TMPDIR`/`TMP`/`TEMP`/`/tmp` + `discord-ipc-{0..2}`, Windows `\\.\pipe\` | **Explicit** (`discord/ipc.ts`): scan `0..9`, `XDG_RUNTIME_DIR`/`TMPDIR`/`TEMP`/`/tmp`, Windows named pipe + Unix socket; probe via `net.connect` |
| **Auto-reconnect** | ✅ 5 s × 10, `clientGeneration` guard, 100 ms debounce, self-heal, clear-on-drop | ⚠️ 15 s × 5, `isConnecting` guard, no generation/debounce | ✅ Daemon backoff 5 s → 30 s ×1.5, write-error detection, keep-alive daemon | **Hardened**: exp backoff `base 1 s → cap 30 s`, `maxAttempts 10`, `jitter 0.2`, generation guard, `handshakeTimeoutMs` configurable (adopts Puri12 guard + Khip01 backoff) |
| **Config format** | `.discord-presence.json` (project + home) + env | Env vars only | `~/.config/opencode/discord-config.json` + env (global only) | **4-tier**: `global file < project file < env < runtime `PluginOptions`` (`config/schema.ts`, zod); deep-merge objects, arrays replace |
| **Per-project config** | ✅ project file wins | ❌ | ❌ | ✅ `perProject.enabled` + `perProject.filename` (default `.discord-presence.json`) |
| **Custom app id** | ✅ `applicationId` / `OPENCODE_DISCORD_CLIENT_ID` | ✅ `OPENCODE_DISCORD_CLIENT_ID` | ✅ `discordAppId` / `DISCORD_APP_ID` | ✅ `applicationId` / `OPENCODE_DISCORD_CLIENT_ID` or `DISCORD_APP_ID`; validated `/^\d{17,20}$/` |
| **Custom assets** | ⚠️ fixed keys (`opencode-logo`, `state-*`), not user-configurable | ❌ hardcoded keys | ✅ `discordLargeImageKey` + text | ✅ `largeImageKey`/`largeImageText`/`smallImageKey`/`smallImageText`; lower-cased, `assets.validate`, supports `mp:`/`https://` |
| **Presence fields** | `details`, `state`, `startTimestamp`, `large/smallImageKey/Text`, **buttons** | `details`, `state`, `startTimestamp`, `large/smallImageKey/Text`, **buttons** | `details`, `state`, `startTimestamp`, `large/smallImageKey/Text` | `details`, `state`, `startTimestamp`, `large/smallImageKey/Text`, **buttons** (max 2, `https://` only) — see `ARCHITECTURE.md` §4.3 |
| **Buttons / links** | ✅ "View on GitHub" | ✅ "Visit OpenCode.ai" | ❌ | ✅ configurable `buttons[]` (default 1 GitHub link; `[]` = none) |
| **Party / `instance`** | ❌ | ❌ | ❌ | ❌ party; `instance` flag available on `PresenceModel` for future use |
| **Idle handling** | ✅ `session.idle` + all-sessions-idle orchestrator | ⚠️ status strings only | ✅ `Waiting` state + idle template set | ✅ FSM `idle` state + `idle.timeoutMs` (300 s default, 10 s..1 h) + `idle.details`/`idle.state` templates |
| **Privacy controls** | ⚠️ file spotlight opt-in (`enableFileSpotlight: false` by default) | ✅ never shows path/code (by design) | ❌ always shows model/context/cost | ✅ `privacy.*` — `hideProjectPath`, `hideModel`, `hideCost`, `hideFilePaths` (default `true`) |
| **Cross-platform** | Library-managed, no OS branching | Library-managed | Explicit Linux/macOS; Windows pipe present but untested (README) | **Explicit**: `os.homedir()`/`os.tmpdir()`/`path.join()`, `win32` pipe, Flatpak/Snap notes carried from Khip01 |
| **Multi-session** | ✅ file-based leader election (`~/.opencode-discord-presence/instances/…`, stale GC 10 s, settle 1200 ms) | ❌ singleton `rpcClient`, last event wins | ✅ daemon single connection, `pickDisplayedInstance` = most-recent-active | ✅ `core/multi-session.ts` `MultiSessionCoordinator` — `leader-election` (default) or `last-wins`; file-based election, stale GC, handoff settle |
| **Session stats** | ⚠️ prompts + files + duration; `tokenUsage`/`cost` declared but never assigned | ❌ model + elapsed only | ✅ cost, tokens (in/out/reasoning/cache), context %, prompts, elapsed; idempotent by message id | ✅ `SessionStats` per `sessionID`, idempotent by `messageID` (replace-not-sum); `sessionStats.*` toggles; limits via `provider.list` → `opencode.json(c)` → fallback |
| **Testing** | `bun test` + Playwright | None found | Node harness scripts | `vitest`/`bun test` per module; harness covers transport + FSM (see `ROADMAP.md`) |

Source for every cell: `community-plugins.md` §§1–4 and the raw URLs in §8. "This plugin" column: `ARCHITECTURE.md` §§2, 5, 6.

---

## 4. Per-Plugin Notes

### 4.1 Puri12/opencode-discord-presence — most complete, best reconnect & multi-session election

Strengths: richest module split (`services/`, `state/`, `utils/`); only per-project config; strongest reconnect (generation counter, 100 ms debounce, 5 s × 10, self-heal); file-based leader election with stale GC and 1200 ms handoff settle; rotation engine with precedence pinning; `mainAgentOnly` sub-agent filtering.

Weakness for our goals: asset keys not user-configurable; `tokenUsage`/`cost` on `SessionMetrics` declared but never populated (grep of `src/` shows no assignments — `community-plugins.md` §1.7); privacy limited to file spotlight toggle.

Source: `src/services/discord-rpc.ts`, `src/services/instance-coordinator.ts`, `src/state/presence-state.ts`, `src/utils/activity-rotation.ts` (see §8).

### 4.2 phoenixak/opencode-discord-rpc — minimal reference

Strengths: smallest surface (3 files), clear status strings (`Coding…`/`Thinking…`/`Waiting…`), privacy by omission (never shows paths/code).

Weakness for our goals: env-only config (no file, no per-project); singleton `rpcClient` — no multi-session coordination; no debounce/generation guard; reconnect is 15 s × 5 with no clear-on-drop; asset keys hardcoded; no session stats beyond model + elapsed; no `dispose` wiring.

Source: `src/index.ts`, `src/discord.ts`, `src/config.ts`.

### 4.3 Khip01/opencode-rich-presence — richest stats & templates, heaviest runtime

Strengths: only complete session-stats implementation (cost, token breakdown, context %, idempotent by message id — `src/plugin/session-state.js`); only configurable asset key/text; only template engine (`{var}`/`{{#if}}`/`{var|fallback}` + `byState` + `replacements`); explicit cross-platform IPC paths and daemon socket; throttle (4 s) + fingerprint dedupe; model-limit 3-tier resolution (`provider.list` → `opencode.json(c)` → fallback table).

Weakness for our goals: no buttons; global-only config; always-visible cost/context (no hide toggles); daemon is a long-lived subprocess that survives last-client disconnect (intentional to avoid Discord reconnect cooldowns, but heavier than file election); Windows untested; polling fallback (`REFRESH_INTERVAL 5000 ms`) instead of `tool.execute.*` hooks.

Source: `src/plugin/session-state.js`, `src/plugin/template-engine.js`, `src/worker/discord-ipc.mjs`, `src/worker/daemon.mjs`, `src/shared/paths.js` (see §8).

---

## 5. Lessons Learned

Distilled from `community-plugins.md` §6 (15 lessons) — each cites the repo it came from.

1. **One IPC connection per app id is a hard constraint.** Both serious multi-session designs address it explicitly: Khip01 daemon owns the single socket; Puri12 elects a single leader file. Our `MultiSessionCoordinator` must do one of the two — Discord enforces it.
2. **Throttle + fingerprint dedupe is mandatory.** Discord limits `5 SET_ACTIVITY / 20 s` (`DISCORD-RPC.md` §7.3). Khip01 throttles to 4 s and skips identical payloads; the final state must still land via a delayed re-arm.
3. **Replace the library's frame codec if it mishandles coalesced frames.** `DISCORD-RPC.md` §3.1 documents two library bugs (split and coalesced frames). Khip01 ships a custom decoder; we ship a per-connection `FrameDecoder` on `Transport` even when wrapping the library.
4. **Custom IPC client when the library's handshake timeout is not configurable.** Khip01 replaced `@xhayper/discord-rpc` because its 10 s handshake timeout is hardcoded and uses 30 s in `discord-ipc.mjs`. We make `handshakeTimeoutMs` configurable (default 10 s).
5. **Generation counters prevent zombie reconnects.** Puri12 `clientGeneration` stops a stale `ready` from a previous client flipping `connected` back on. We carry this verbatim.
6. **Debounce presence pushes.** Puri12 debounces `setActivity` at 100 ms; phoenixak has none and jitters on every event. Bursty `message.part.updated` must be coalesced (pin `193de13a` §12 says ≤ 0.5 Hz).
7. **Clear activity on shutdown/disconnect — Discord never expires it.** Puri12 clears in `disconnect()`; Khip01 clears on last-instance goodbye. We do `clear()` (`activity: null`) in `dispose`/SIGINT and on detected drop.
8. **Session-stat aggregation must be idempotent by message id.** Khip01 subtracts the prior value before re-adding on `message.updated`; summing would double-count. We follow replace-not-sum (`OPENCODE-PLUGIN-API.md` §11.3).
9. **Model context limits need 3-tier resolution.** Khip01: SDK `provider.list` → `opencode.json(c)` → hardcoded fallback table. We adopt the same chain for `contextPercent`.
10. **Main vs sub-agent filtering via `info.parentID`.** Puri12 `SessionTracker` with negative cache and `mainAgentOnly` prevents sub-agent flicker. We expose it via `privacy`/`sessionStats` rather than a separate flag, but the detection pattern is reused.
11. **Privacy by default.** Puri12 ships file spotlight off; phoenixak documents never exposing paths/code. We default `hideFilePaths: true`.
12. **Non-blocking startup.** Puri12 `startPluginAsync` fires `connect()` fire-and-forget; Khip01 spawns the daemon lazily on first `chat.message`. We never block opencode bootstrap on IPC (10–30 s timeout must be async).
13. **Template engine beats hardcoded strings.** Khip01 `{var}`/`{{#if}}`/`byState`/`replacements` is more extensible than Puri12/phoenixak hardcoded strings. We adopt `{model}`/`{provider}`/`{project}`/`{file}`/`{elapsed}`/`{cost}`/`{tokens}`/`{contextPercent}`/`{done}`/`{total}` via `detailsTemplate`/`stateTemplate`.
14. **Precedence `global < project < env < runtime` and `unref()` every timer.** Puri12 uses `env > project > home`; Khip01 `env > global`. We canonicalize to 4 tiers and `unref()` reconnect/idle/throttle timers so background work never keeps opencode alive.
15. **Cross-platform path convention is `os.homedir()`/`os.tmpdir()`/`path.join()` with `win32` named-pipe branch.** Khip01 `src/shared/paths.js` is the reference; opencode normalizes config under `~/.config/opencode/` on all OSes.

---

## 6. Improvements Adopted per Target Feature

Each subsection: gap from §3 → what we adopt in `ARCHITECTURE.md` → where it lands on the roadmap.

### (a) Session stats — model / token / cost

- **Gap:** Khip01 is the only complete impl; Puri12 declares `cost`/`tokenUsage` but never assigns; phoenixak has none (`community-plugins.md` §5a).
- **We adopt:**
  - `core/session-state.ts` — per-`sessionID` `SessionStats`, keyed by `messageID`, delta-replace on `message.updated` (lesson 8).
  - Token breakdown `{ input, output, reasoning, cache:{read,write} }`, `cost`, `contextTokens`/`contextLimit`/`contextPercent`, `promptCount`, `startedAt`/`lastActivityAt` (`ARCHITECTURE.md` §2.1).
  - Limit resolution chain `provider.list` → `opencode.json(c)` → fallback table (lesson 9).
  - `sessionStats.*` toggles (`showModel`/`showTokens`/`showCost`/`showElapsed`) wired through `privacy.hideModel`/`hideCost` and template vars.
  - FSM `session-state.ts` surfaces stats in `state` (`"$<cost> · <tokens> tokens"`); `presence-model.ts` renders via `detailsTemplate`/`stateTemplate`.
- **Roadmap:** **v1** (see `ROADMAP.md` M1).

### (b) Cross-platform IPC + auto-reconnect

- **Gap:** Khip01 alone has explicit socket discovery but Windows untested; Puri12 has the best reconnect but delegates discovery (`community-plugins.md` §5b).
- **We adopt:**
  - `discord/ipc.ts` — explicit discovery scanning `discord-ipc-{0..9}` across `XDG_RUNTIME_DIR`/`TMPDIR`/`TEMP`/`/tmp`, `win32` `\\?\pipe\` branch, `net.connect` probe.
  - `discord/transport.ts` — `Transport` iface + per-connection `FrameDecoder` (lesson 3), wire `LE u32 opcode + len + JSON`, `MaxRpcFrameSize 64 KiB`.
  - `discord/client.ts` — exp backoff `baseMs 1000 → capMs 30000`, `maxAttempts 10`, `jitterRatio 0.2`, generation guard, `handshakeTimeoutMs` configurable (default 10 s, Khip01 uses 30 s), debounce 100 ms + throttle 4 s + fingerprint dedupe, `retry_after` honoured, `CLOSE` (opcode 2) → `closed` without blind reconnect.
  - `utils/logger.ts` via `client.app.log` for `debug` first-failure vs `warn` after cap (Puri12 `shouldLogConnectFailure` pattern).
- **Roadmap:** **v1** (M1). MVP ships a single-session transport without the full backoff tuning; hardened reconnect lands in v1.

### (c) Privacy / idle + per-project config

- **Gap:** Only Puri12 has per-project config and a privacy default (`enableFileSpotlight: false`); Khip01 has the richest idle templates but global-only and always-visible cost (`community-plugins.md` §5c).
- **We adopt:**
  - `config/schema.ts` + `config/loader.ts` — zod schema, 4-tier precedence, deep-merge (objects merge, arrays replace), `perProject.enabled`/`filename`, env `OPENCODE_DISCORD_*` with `DISCORD_APP_ID` alias.
  - `privacy.*` — `hideProjectPath`, `hideModel`, `hideCost`, `hideFilePaths` (default `true`) — enforced in `presence-model.ts` before truncation.
  - `idle.*` — `enabled`, `timeoutMs` (300 s, clamped 10 s..1 h), `idle.details`/`idle.state` templates; FSM `idle` state entered via `session.idle`/`idle.timeout`/`tool.end`, with `presence-model.ts` switching templates.
  - `mainAgentOnly`-equivalent via `SessionTracker` `parentID` check (lesson 10) — sub-agent sessions optionally excluded from display.
- **Roadmap:** **`perProject` in v1**, **`privacy.*` + `idle.*` in v2** (see `ROADMAP.md` — split so v1 can ship project overrides early while privacy/idle UI is polished in v2).

### (d) Custom app id & assets

- **Gap:** All three support custom app id; only Khip01 supports custom asset key/text; Puri12 hardcodes keys, phoenixak hardcodes both (`community-plugins.md` §5d).
- **We adopt:**
  - `applicationId` (`/^\d{17,20}$/`, env `OPENCODE_DISCORD_CLIENT_ID`/`DISCORD_APP_ID`) + `largeImageKey`/`largeImageText`/`smallImageKey`/`smallImageText` in `config/schema.ts`.
  - `discord/assets.ts` — lower-casing, `type ∈ {0,2,3,5}` validation, `mp:`/`https://` URL support, button/asset caps (`details`/`state`/`large_text`/`small_text` ≤ 128, keys ≤ 32, buttons ≤ 2, `https://` only — `DISCORD-RPC.md` §4.2).
  - Docs for Discord Developer Portal (create app → upload art assets → copy Application ID) — to be added in `CONFIGURATION.md` (task `DOC-002`), pattern taken from Puri12 README and Khip01 `docs/INSTALL.md`.
- **Roadmap:** **v2** (M2).

### (e) Buttons / links + multi-session

- **Gap:** Puri12 + phoenixak have buttons, Khip01 does not; Puri12 (file election) and Khip01 (daemon) both solve multi-session, phoenixak does not; Discord allows only one IPC connection per app id so one strategy is mandatory (`community-plugins.md` §5e).
- **We adopt:**
  - `buttons[]` — `Array<{label: string, url: string}>`, max 2, validated in `assets.ts`; default single "View on GitHub" link; `[]` disables.
  - `core/multi-session.ts` — `MultiSessionCoordinator` with two strategies: `leader-election` (default, file-based election under `~/.opencode-discord-presence/instances/…`, stale GC 10 s, settle ~1200 ms — Puri12 pattern) and `last-wins` (Khip01-style most-recent-active). Only the leader pushes via `discord/client.ts`; others keep local FSM.
  - `Transport` single-slot guarantee: `multi-session.ts` `pickActive()` gates `client.ts` `setActivity`; `presence-model.ts` never pushes from a non-leader.
- **Roadmap:** **Buttons in v2**, **multi-session in v3** (see `ROADMAP.md` — buttons are config-only and ship earlier; election is the most complex and ships last).

---

## 7. What We Intentionally Don't Adopt

| Rejected / deferred | Why |
|---|---|
| Khip01 long-lived daemon subprocess | Heavier lifecycle (survives last-client disconnect, `EADDRINUSE` retry, manual `taskkill`/`wmic` on Windows). We prefer file-based election for v3 and keep `Transport` swappable if a daemon is ever needed. |
| Khip01 5 s SDK polling (`client.session.list` + `client.session.messages`) | We use `tool.execute.before/after` + `event` hooks directly (Puri12 pattern) and debounce `file.edited` at 100 ms; polling is a fallback only if the SDK is unavailable. |
| phoenixak env-only config | Too coarse for teams; per-project file is required (lesson 14). |
| Hardcoded asset keys / hardcoded presence strings | Replaced by configurable `largeImageKey/Text` and `detailsTemplate`/`stateTemplate` (lesson 13). |
| Periodic PING health check as reconnect trigger | Khip01 disabled it as "too aggressive"; we trust socket `close`/`error`/write errors and expose `isHealthy(maxAgeMs)` only for diagnostics. |
| `party` presence | None of the three implement it; Discord docs mark it as invite/party-specific — out of scope for a coding presence. |
| Blocking `connect()` on plugin load | All three avoid it (Puri12 fire-and-forget, Khip01 lazy spawn). We do the same — `plugin.ts` `connect()` is async and never stalls bootstrap. |

---

## 8. References

### Analyzed revisions (raw URLs)

**Puri12/opencode-discord-presence** (`b0af0b90`):

- `package.json` — https://raw.githubusercontent.com/Puri12/opencode-discord-presence/main/package.json
- `src/index.ts` — https://raw.githubusercontent.com/Puri12/opencode-discord-presence/main/src/index.ts
- `src/plugin.ts` — https://raw.githubusercontent.com/Puri12/opencode-discord-presence/main/src/plugin.ts
- `src/config.ts` — https://raw.githubusercontent.com/Puri12/opencode-discord-presence/main/src/config.ts
- `src/services/discord-rpc.ts` — https://raw.githubusercontent.com/Puri12/opencode-discord-presence/main/src/services/discord-rpc.ts
- `src/services/instance-coordinator.ts` — https://raw.githubusercontent.com/Puri12/opencode-discord-presence/main/src/services/instance-coordinator.ts
- `src/services/presence-orchestrator.ts` — https://raw.githubusercontent.com/Puri12/opencode-discord-presence/main/src/services/presence-orchestrator.ts
- `src/services/session-tracker.ts` — https://raw.githubusercontent.com/Puri12/opencode-discord-presence/main/src/services/session-tracker.ts
- `src/state/presence-state.ts` — https://raw.githubusercontent.com/Puri12/opencode-discord-presence/main/src/state/presence-state.ts
- `src/utils/activity-rotation.ts` — https://raw.githubusercontent.com/Puri12/opencode-discord-presence/main/src/utils/activity-rotation.ts

**phoenixak/opencode-discord-rpc** (`eebd89e9`):

- `package.json` — https://raw.githubusercontent.com/phoenixak/opencode-discord-rpc/main/package.json
- `src/index.ts` — https://raw.githubusercontent.com/phoenixak/opencode-discord-rpc/main/src/index.ts
- `src/discord.ts` — https://raw.githubusercontent.com/phoenixak/opencode-discord-rpc/main/src/discord.ts
- `src/config.ts` — https://raw.githubusercontent.com/phoenixak/opencode-discord-rpc/main/src/config.ts

**Khip01/opencode-rich-presence** (`ac03601a`):

- `package.json` — https://raw.githubusercontent.com/Khip01/opencode-rich-presence/main/package.json
- `src/plugin/index.js` — https://raw.githubusercontent.com/Khip01/opencode-rich-presence/main/src/plugin/index.js
- `src/plugin/session-state.js` — https://raw.githubusercontent.com/Khip01/opencode-rich-presence/main/src/plugin/session-state.js
- `src/plugin/template-engine.js` — https://raw.githubusercontent.com/Khip01/opencode-rich-presence/main/src/plugin/template-engine.js
- `src/worker/discord-ipc.mjs` — https://raw.githubusercontent.com/Khip01/opencode-rich-presence/main/src/worker/discord-ipc.mjs
- `src/worker/daemon.mjs` — https://raw.githubusercontent.com/Khip01/opencode-rich-presence/main/src/worker/daemon.mjs
- `src/shared/paths.js` — https://raw.githubusercontent.com/Khip01/opencode-rich-presence/main/src/shared/paths.js
- `src/shared/constants.js` — https://raw.githubusercontent.com/Khip01/opencode-rich-presence/main/src/shared/constants.js
- `config/discord-config.example.json` — https://raw.githubusercontent.com/Khip01/opencode-rich-presence/main/config/discord-config.example.json

### Our docs

- [`_research/community-plugins.md`](./_research/community-plugins.md) — raw research (task `DISC-001`)
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — our modular architecture (task `ARCH-001`)
- [`OPENCODE-PLUGIN-API.md`](./OPENCODE-PLUGIN-API.md) — opencode plugin API pin `193de13a`
- [`DISCORD-RPC.md`](./DISCORD-RPC.md) — Discord RPC wire + rate-limit reference
- [`ROADMAP.md`](./ROADMAP.md) — phased delivery plan that consumes this analysis
