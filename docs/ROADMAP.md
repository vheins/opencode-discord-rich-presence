# Roadmap — opencode Discord Rich Presence

> Parent: `ROOT-001` · Depends on: `DISC-001` (`_research/community-plugins.md`), `ARCH-001` (`ARCHITECTURE.md`) · Companion: [`COMMUNITY-ANALYSIS.md`](./COMMUNITY-ANALYSIS.md).
> SCT (Supply-Chain Track): `ARCH-001` → `DOC-003` (this doc) → `SCAF-001..003`. No code ships until `ARCHITECTURE.md` is accepted.

---

## Table of Contents

1. [Overview & Feature→Milestone Map](#1-overview--featuremilestone-map)
2. [Milestone 0 — MVP: Baseline Presence](#2-milestone-0--mvp-baseline-presence)
3. [Milestone 1 — v1: Session Stats + Hardened Transport + Per-Project Config](#3-milestone-1--v1-session-stats--hardened-transport--per-project-config)
4. [Milestone 2 — v2: Privacy/Idle + Custom App & Assets + Buttons + Presence Customization](#4-milestone-2--v2-privacyidle--custom-app--assets--buttons--presence-customization)
5. [Milestone 3 — v3: Multi-Session + Presence Engine](#5-milestone-3--v3-multi-session--presence-engine)
6. [Dependency Graph](#6-dependency-graph)
7. [Exit & Release Criteria](#7-exit--release-criteria)
8. [Risks & Mitigations](#8-risks--mitigations)
9. [References](#9-references)

---

## 1. Overview & Feature→Milestone Map

Phases are strictly sequential — each milestone's acceptance criteria gate the next. Scope is frozen per milestone; anything not listed is explicitly out of scope for that phase.

```
MVP ──► v1 ──► v2 ──► v3
 │       │      │      │
 │       │      │      └─ multi-session (e) + presence engine (f: resolver, telemetry)
 │       │      └──────── privacy/idle + app/assets + buttons + presence customization (c,d,e-partial,f-partial)
 │       └─────────────── session stats + transport hardening + per-project config (a,b,c-partial)
 └─────────────────────── baseline presence (foundation for all 6)
```

### Target features → milestone

| Key | Feature (from `ARCH-001` §5.1) | Ships in | Primary modules | Community source |
|---|---|---|---|---|
| (a) | Session stats — model / token / cost | **v1** (M1) | `core/session-state.ts`, `core/state-machine.ts`, `core/presence-model.ts` | Khip01 `session-state.js` (only complete impl); Puri12 `SessionMetrics` declared-but-empty |
| (b) | Cross-platform IPC + auto-reconnect | **v1** (M1) | `discord/ipc.ts`, `discord/transport.ts`, `discord/client.ts`, `utils/logger.ts` | Puri12 `discord-rpc.ts` (generation guard + debounce) + Khip01 `discord-ipc.mjs` (explicit paths, 30 s handshake, throttle) |
| (c) | Privacy / idle + per-project config | **v1** (per-project) + **v2** (privacy/idle) | `config/*`, `core/state-machine.ts` (`idle`), `core/presence-model.ts` (privacy) | Puri12 per-project + `enableFileSpotlight:false` (privacy-by-default); Khip01 idle templates |
| (d) | Custom app id & assets | **v2** (M2) | `config/schema.ts`, `discord/assets.ts`, `core/presence-model.ts` | Khip01 `discordLargeImageKey/Text` (only configurable assets); all three support custom app id |
| (e) | Buttons / links + multi-session | **v2** (buttons) + **v3** (multi-session) | `config/schema.ts` + `discord/assets.ts` (buttons); `core/multi-session.ts` + `discord/client.ts` (election) | Puri12 + phoenixak buttons; Puri12 file election vs Khip01 daemon (see `COMMUNITY-ANALYSIS.md` §3) |
| (f) | Presence customization — activity type/name, phrase pools, tool-activity resolver, context/TODO telemetry | **v2** (activity type, phrases, identity) + **v3** (resolver, telemetry) | `core/tool-resolver.ts`, `core/presence-model.ts`, `config/schema.ts` | [`PRESENCE-DESIGN.md`](./PRESENCE-DESIGN.md) (design vision) |

For the evidence behind each source, see `COMMUNITY-ANALYSIS.md` §§3–6 and `_research/community-plugins.md` §§1–5.

---

## 2. Milestone 0 — MVP: Baseline Presence

> Goal: a shippable plugin that shows *something* useful on Discord with zero config.

### 2.1 Scope

In:

- Plugin lifecycle: `src/plugin.ts` hook wiring (`event`, `tool.execute.before/after`, `dispose`) per `OPENCODE-PLUGIN-API.md` §3/§6 (pin `193de13a`).
- Minimal FSM: `idle ↔ active ↔ tool-running` (subset of `ARCHITECTURE.md` §4; `waiting-permission`/`compacting`/`error` deferred to v1/v2).
- Minimal presence: `details` (`"Working with {model}"` or `"Idle — ready"`), `state` (`elapsed` only), `startTimestamp`, `largeImageKey/Text` (bundled defaults).
- Single-session transport: `discord/transport.ts` + `discord/ipc.ts` scanning `discord-ipc-0..9`, `discord/client.ts` with basic `connect`/`SET_ACTIVITY`/`clear`/`close`, disconnect → `disconnected` (no backoff tuning yet).
- Config: global file `~/.config/opencode/discord-presence.json` + env `OPENCODE_DISCORD_ENABLED` / `OPENCODE_DISCORD_DEBUG`; `enabled:false` short-circuits.
- Logger: `utils/logger.ts` via `client.app.log`.

Out (explicitly deferred):

- Token/cost/context stats, throttle/dedupe tuning, per-project file, privacy toggles, idle timeout, custom app/assets, buttons, multi-session.

### 2.2 Deliverables

| Deliverable | Path | Notes |
|---|---|---|
| Plugin entry | `src/index.ts`, `src/plugin.ts` | Re-export `Plugin`; thin wiring only |
| Types | `src/types.ts` | `PluginDeps`, `SessionStateKind` (3 states), `PresenceModel` (no buttons) |
| Config (MVP slice) | `src/config/schema.ts`, `src/config/loader.ts` | Zod schema: `enabled`, `debug`, `largeImageKey/Text` only |
| FSM (MVP slice) | `src/core/state-machine.ts` | 3-state `TRANSITIONS` subset; `dispatch → PresenceModel \| null` |
| Presence builder (MVP) | `src/core/presence-model.ts` | Template-free MVP strings; truncation to 128 |
| Transport (MVP) | `src/discord/transport.ts`, `src/discord/ipc.ts`, `src/discord/client.ts` | `Transport` iface + `FrameDecoder` + IPC scan; no backoff/jitter yet |
| Docs | `README.md`, `docs/CONFIGURATION.md` (MVP slice) | Install + enable/disable only |

### 2.3 Acceptance criteria

- [ ] `plugin.ts` registers `event`, `tool.execute.before/after`, `dispose`; `connect()` is fire-and-forget (never blocks opencode bootstrap — `COMMUNITY-ANALYSIS.md` lesson 12).
- [ ] With Discord running, `details`/`state`/`startTimestamp`/`largeImage` appear within 2 s of `session.created`.
- [ ] With Discord closed, plugin stays `disconnected`, logs once at `debug`, opencode remains usable; no unhandled rejection.
- [ ] `OPENCODE_DISCORD_ENABLED=false` disables all hooks and IPC.
- [ ] All new `src/` files ≤ 500 lines (`wc -l`).
- [ ] No secret (token, file content, conversation text) enters presence fields.

### 2.4 Dependencies

- `ARCHITECTURE.md` §§2–3 accepted.
- `OPENCODE-PLUGIN-API.md` pin `193de13a` available (SDK types).
- `DISCORD-RPC.md` §§3–4 (wire format, field caps).

---

## 3. Milestone 1 — v1: Session Stats + Hardened Transport + Per-Project Config

> Goal: the two highest-value gaps vs community plugins — real stats and a transport that survives Discord restarts — plus per-project overrides so teams can ship config with the repo.

### 3.1 Scope

In:

- **(a) Session stats** — `core/session-state.ts` per-`sessionID` `SessionStats` (`cost`, `tokens {input,output,reasoning,cache}`, `contextTokens`/`contextLimit`/`contextPercent`, `promptCount`, `startedAt`/`lastActivityAt`), idempotent by `messageID` (replace-not-sum — `OPENCODE-PLUGIN-API.md` §11.3, Khip01 pattern). Limit chain `provider.list` → `opencode.json(c)` → fallback table. Wired through `sessionStats.showModel/showTokens/showCost/showElapsed` and template vars `{model}` `{provider}` `{cost}` `{tokens}` `{contextPercent}` `{elapsed}`. FSM `active`/`tool-running` `state` shows `"$<cost> · <tokens> tokens"`.
- **(b) Hardened transport** — `discord/ipc.ts` explicit scan `0..9` + `win32` named pipe; `discord/transport.ts` per-connection `FrameDecoder` (coalesced-frame fix — `DISCORD-RPC.md` §3.1); `discord/client.ts` exp backoff `base 1 s → cap 30 s`, `maxAttempts 10`, `jitter 0.2`, generation guard, `handshakeTimeoutMs` configurable (Puri12 + Khip01 lessons 4–5), debounce 100 ms + throttle 4000 ms + fingerprint dedupe + `retry_after` honour, `CLOSE` (opcode 2) → `closed` (no blind reconnect), `clear()` best-effort on `dispose`.
- **(c-partial) Per-project config** — `config/loader.ts` 4-tier precedence `global < project < env < runtime`, deep-merge (objects merge, arrays replace), `perProject.enabled`/`filename` (default `.discord-presence.json`), env `OPENCODE_DISCORD_*` with `DISCORD_APP_ID` alias. Zod validation with subtree fallback.
- FSM additions: `session.error` → `error` state; `permission.ask/replied` and `compacting.start/end` transitions added (still no idle timeout — that is v2).

Out: `privacy.*` toggles, `idle.*` timeout/templates, custom `applicationId`/assets, `buttons`, `multi-session` (all v2/v3).

### 3.2 Deliverables

| Deliverable | Path | Notes |
|---|---|---|
| Session state | `src/core/session-state.ts` | `SessionStats` store + `addOrUpdateMessage` |
| FSM (full minus idle) | `src/core/state-machine.ts` | 6 states minus `idle.timeout` edge; `error` added |
| Presence templates | `src/core/presence-model.ts`, `src/utils/format.ts` | `{var}` renderer + `VALID_TEMPLATE_VARS` allow-list |
| Transport hardening | `src/discord/client.ts`, `src/discord/assets.ts` | Backoff, throttle, nonce table, `validateActivity` |
| Config (v1 slice) | `src/config/schema.ts`, `src/config/loader.ts` | Add `detailsTemplate`/`stateTemplate`, `reconnect.*`, `throttle.*`, `perProject.*`, `sessionStats.*` |
| Docs | `docs/CONFIGURATION.md` (v1), `docs/EXTENDING.md` (scaffold) | Per-project file + stats vars documented |

### 3.3 Acceptance criteria

- [ ] `SessionStats` aggregates by `messageID`; re-sending the same `message.updated` does not double-count `cost`/`tokens` (unit test: send same id twice, assert no drift).
- [ ] `contextPercent` resolves via `provider.list` → `opencode.json(c)` → fallback; when all three miss, `contextPercent` is `undefined` (no crash).
- [ ] IPC reconnect: kill Discord, wait 5 s, restart Discord → presence reappears within `baseMs + jitter` without restart of opencode; generation guard prevents zombie `ready`.
- [ ] Throttle: burst 20 `message.part.updated` in 1 s → at most 1 `SET_ACTIVITY` per 4 s, final state lands (delayed re-arm), deduped payloads skipped (`JSON.stringify` fingerprint).
- [ ] Per-project: `<projectRoot>/.discord-presence.json` overrides `~/.config/opencode/discord-presence.json`; env overrides both; `buttons` array from higher precedence replaces (not merges).
- [ ] `throttle.minIntervalMs` respects Discord `5/20 s` (default 4000 ms) and `retry_after` from server overrides `nextDelay`.
- [ ] All timers `unref()`'d.

### 3.4 Dependencies

- M0 shipped and gated.
- `DISCORD-RPC.md` §§2, 7 (IPC paths, rate-limit, reconnect).
- `_research/community-plugins.md` §§4–5 for gap evidence (Khip01 stats, Puri12 reconnect).

---

## 4. Milestone 2 — v2: Privacy/Idle + Custom App & Assets + Buttons + Presence Customization

> Goal: polish for real-world use — privacy controls, idle UX, branding, and links — all config-only, no new IPC semantics.

### 4.1 Scope

In:

- **(c) Privacy + idle** — `privacy.hideProjectPath`/`hideModel`/`hideCost`/`hideFilePaths` (default `true`) enforced in `presence-model.ts` before truncation; `idle.enabled`/`timeoutMs` (300 s, 10 s..1 h) + `idle.details`/`idle.state` templates; FSM `idle.timeout` edge (`active`/`tool-running` → `idle` after `timeoutMs` with no activity); `file.edited`/`file.watcher.updated` 100 ms debounce for flicker avoidance.
- **(d) Custom app & assets** — `applicationId` (`/^\d{17,20}$/`), `largeImageKey`/`largeImageText`/`smallImageKey`/`smallImageText` with lower-casing and `assets.validate` (`type ∈ {0,2,3,5}`, `mp:`/`https://` URLs); docs for Discord Developer Portal (create app → upload art → copy ID) — pattern from Puri12 README + Khip01 `docs/INSTALL.md`.
- **(e-partial) Buttons** — `buttons[]` max 2, `label 1..32` / `url 1..512` / `https://` only, validated in `assets.ts`; default `[{label:"View on GitHub", url:"https://github.com/vheins/opencode-discord-rich-presence"}]`; `[]` disables.
- **(f) Presence customization** — `activityType` (`playing`/`listening`/`watching`/`competing` → RPC `0/2/3/5`, default `playing`), `activityName` (best-effort top line — `PRESENCE-DESIGN.md` §16.1), `phrases.details`/`phrases.state` pools (non-empty overrides the matching `*Template`; template vars allowed) with `phrases.mode`/`phrases.rotateMs`/`phrases.cooldownMs`, and `presence.showSessionTitle`. Spotify-like recipe in `CONFIGURATION.md` §3f.

Out: `multi-session` (v3), tool-activity resolver + context/TODO telemetry (v3). No daemon, no polling fallback.

### 4.2 Deliverables

| Deliverable | Path | Notes |
|---|---|---|
| Privacy/idle | `src/core/presence-model.ts`, `src/core/state-machine.ts`, `src/config/schema.ts` | `privacy.*`, `idle.*`, `idle.timeout` transition, file-label sanitization |
| Assets/buttons | `src/discord/assets.ts`, `src/config/schema.ts` | Key validation, button caps, URL checks |
| Config (v2 slice) | `src/config/schema.ts` | Add `privacy.*`, `idle.*`, `applicationId`, `large/smallImage*`, `assets.validate`, `buttons`, `activityType`, `activityName`, `phrases.*`, `presence.showSessionTitle` |
| Presence customization | `src/core/presence-model.ts` | Phrase-pool selection/rotation (`phrases.mode`/`rotateMs`/`cooldownMs`), activity type/name in `buildActivity()` |
| Docs | `docs/CONFIGURATION.md` (complete), `README.md` (portal guide) | Privacy matrix + portal steps + button/presence examples |

### 4.3 Acceptance criteria

- [ ] `privacy.hideFilePaths:true` → no file name appears in `details`/`state` even when `tool.execute.before` supplies `filePath` (assert on `presence-model` unit test).
- [ ] `privacy.hideCost:true` → `state` omits `cost`; `hideModel:true` → `details` is `"Working"` (no model).
- [ ] `idle.timeoutMs: 300000` → no activity for 5 min → FSM `idle`, `details` switches to `idle.details`; next `message.updated` → `active` with original `startedAt` preserved.
- [ ] `applicationId` non-empty but not `/^\d{17,20}$/` → `warn` + fall back to bundled `DEFAULT_CLIENT_ID`, no crash.
- [ ] `largeImageKey` with `https://` URL passes validation; key > 32 chars rejected with `warn`.
- [ ] `buttons` with 3 entries rejected (max 2); `http://` URL rejected; valid 1–2 `https://` buttons appear on Discord.
- [ ] `details`/`state`/`large_text`/`small_text` truncated to 128 before send (assert).
- [ ] `activityType: "listening"` sends RPC `type: 2`; `"playing"` → `0`; an invalid value falls back to `playing` with a `warn`.
- [ ] Non-empty `phrases.details`/`phrases.state` overrides the matching `*Template`; `phrases.rotateMs > 0` rotates and `phrases.cooldownMs` gates phrase changes; timers `.unref()`'d.
- [ ] Spotify-like recipe (`CONFIGURATION.md` §3f) renders `Listening to <AppName>` with the `{project}` pool entry expanded.

### 4.4 Dependencies

- M1 shipped.
- `DISCORD-RPC.md` §4.2 (field caps, button limits, asset types).

---

## 5. Milestone 3 — v3: Multi-Session + Presence Engine

> Goal: correct display when multiple opencode instances run concurrently — only one Discord presence at a time — plus the full tool-activity resolver and context/TODO telemetry.

### 5.1 Scope

In:

- **(e) Multi-session** — `core/multi-session.ts` `MultiSessionCoordinator` with two strategies:
  - `leader-election` (default): file-based election under `~/.opencode-discord-presence/instances/<hostname>/<clientId>/<pid>.json` (Puri12 pattern: atomic temp+rename, stale GC 10 s with 2-tick grace, winner = highest `lastActivity` → oldest `startedAt` → lowest pid, `DEFAULT_OWNER_SETTLE_MS` ~1200 ms handoff).
  - `last-wins`: most-recent-active instance wins (Khip01 `pickDisplayedInstance` pattern, no files).
- Single IPC slot guarantee: only `pickActive()` winner pushes via `discord/client.ts`; non-leaders keep local FSM but suppress `setActivity`. On leader exit, elect new leader within `minIntervalMs` (throttle window).
- `MultiSessionCoordinator` events: `register`/`touch`/`remove`/`pickActive`/`onPickChanged` (see `ARCHITECTURE.md` §2.1).
- No long-lived daemon subprocess — election is file-based; `Transport` remains swappable if a daemon is ever needed (rejected in `COMMUNITY-ANALYSIS.md` §7).
- **(f) Tool activity resolver + telemetry** — `core/tool-resolver.ts` normalizes builtin / custom / MCP tools to a `ToolActivity` model (`source`, `provider?`, `tool`, `action`, `target?`, `phrase`). MCP is first-class: provider/tool parsed generically from `mcp__<provider>__<tool>`, with an unknown-provider fallback (`MCP • Running <tool> • <phrase>`) that never drops an event. Context telemetry (`150.4K (57%)`) and TODO progress (`TODO 4/9`) both merge into the single `state` line (`presence.showContext` / `presence.showTodo`); `presence.showMcpProvider` controls the MCP provider label. Event priority resolves concurrent signals as `ERROR > PERMISSION > MCP/TOOL > FILE > THINKING > IDLE` (see `ARCHITECTURE.md` §4.4).

Out: nothing — v3 is the final milestone for the target features. Post-v3 work (if any) is tracked separately.

### 5.2 Deliverables

| Deliverable | Path | Notes |
|---|---|---|
| Coordinator | `src/core/multi-session.ts` | `MultiSessionCoordinator` both strategies |
| Client gating | `src/discord/client.ts` | Gate `setActivity` on `pickActive()`; re-push on `onPickChanged` |
| Plugin wiring | `src/plugin.ts` | `register`/`touch`/`remove` on session lifecycle; cleanup leader file on `dispose` |
| Tool resolver | `src/core/tool-resolver.ts` | Builtin/custom/MCP → `ToolActivity`; generic `mcp__<provider>__<tool>` parse + unknown fallback |
| Presence model (telemetry) | `src/core/presence-model.ts` | Context `150.4K (57%)` + TODO `TODO 4/9` merge into `state`; event priority |
| Tests | `tests/core/multi-session.test.ts` | Election, stale GC, handoff, last-wins |
| Tests | `tests/core/tool-resolver.test.ts` | Builtin/MCP/unknown parse; priority ordering |

### 5.3 Acceptance criteria

- [ ] Two opencode instances with different `sessionID` running concurrently → exactly one Discord presence visible (the leader); the other suppresses `SET_ACTIVITY` (assert via stubbed `Transport`).
- [ ] Leader exits (`dispose`/`SIGINT`) → remaining instance becomes leader and pushes within `throttle.minIntervalMs` + settle (~1200 ms).
- [ ] Stale leader file (no `touch` for > 10 s × 2 ticks) is GC'd; a new leader is elected without manual cleanup.
- [ ] `multiSession.strategy: "last-wins"` → most-recent `touch()` wins regardless of files; no files written.
- [ ] No `SET_ACTIVITY` from a non-leader ever reaches `Transport` (unit test with spy).
- [ ] A builtin tool (`read`/`edit`/`bash`), a custom tool, and an MCP tool (`mcp__<provider>__<tool>`) each resolve to a distinct `ToolActivity`; an unknown MCP provider still renders a generic `MCP • Running <tool>` line (no dropped event).
- [ ] With `presence.showContext:true`, `state` shows `150.4K (57%)`; with `presence.showTodo:true`, `TODO 4/9`; both co-exist on the single `state` line and are omitted when their toggles are `false`.
- [ ] Concurrent `ERROR` + `PERMISSION` + `MCP/TOOL` signals → presence resolves to the highest priority (`ERROR > PERMISSION > MCP/TOOL > FILE > THINKING > IDLE`).

### 5.4 Dependencies

- M2 shipped.
- Puri12 `instance-coordinator.ts` + `presence-orchestrator.ts` as reference (see `COMMUNITY-ANALYSIS.md` §4.1); Khip01 `daemon.mjs` `pickDisplayedInstance` for `last-wins` semantics.
- `ARCHITECTURE.md` §§2, 4.4, 6, 8 (module map, tool activity resolution, transport, failure modes).

---

## 6. Dependency Graph

```
DISC-001 ──► ARCH-001 ──► DOC-003 (this doc) ──► SCAF-001 ──► M0
  │              │                                     │
  │              └───────────► M1 (stats+transport) ◄──┘
  │                                │
  │                                ▼
  │                           M2 (privacy/idle/assets/buttons)
  │                                │
  │                                ▼
   │                           M3 (multi-session + presence engine)
  │
  └─► COMMUNITY-ANALYSIS.md (evidence base for all milestones)
```

`SCAF-001` (tooling + `config`/`core`/`utils`), `SCAF-002` (`discord/`), `SCAF-003` (`plugin.ts` + examples) implement `ARCHITECTURE.md` verbatim — see `ARCHITECTURE.md` §8 footer.

---

## 7. Exit & Release Criteria

Each milestone exits only when **all** its acceptance criteria are checked and the following hold:

- No `any`, no `tsc` errors, `lint` + `format` pass.
- Every `src/` file ≤ 500 lines.
- No unverifiable claims in docs — every comparative claim cites `_research/community-plugins.md` or a raw URL.
- `dispose` clears presence (`activity: null`) best-effort and removes leader file (M3); timers `unref()`'d so opencode can exit.

Version tags:

| Tag | Milestone | Semver |
|---|---|---|
| `v0.1.0` | M0 | Pre-release |
| `v1.0.0` | M1 | First minor with stats+transport |
| `v1.1.0` | M2 | Privacy/idle/assets/buttons |
| `v1.2.0` or `v2.0.0` | M3 | Multi-session + presence engine (breaking only if config shape changes; otherwise `v1.2.0`) |

---

## 8. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `@xhayper/discord-rpc` handshake timeout (hardcoded 10 s) blocks startup | Medium | High | `connect()` fire-and-forget; `handshakeTimeoutMs` configurable; `FrameDecoder` per-connection even when wrapping library (`COMMUNITY-ANALYSIS.md` lessons 3–4) |
| Discord only allows one IPC connection per app id | Certain | High | File-based election (M3) + single-slot gate in `client.ts` (lesson 1); no daemon needed |
| `provider.list` unavailable → no context limit | Medium | Low | 3-tier chain with fallback table; `contextPercent` becomes `undefined`, no crash (lesson 9) |
| `message.updated` double-counts cost/tokens | Medium | Medium | Idempotent replace-not-sum by `messageID` (lesson 8); unit test for same-id re-send |
| Windows named-pipe untested | Medium | Medium | Explicit `win32` branch in `ipc.ts`; carry Khip01 `PLATFORM-NOTES.md` guidance; CI on `win32` when available |
| Rate-limit `5/20 s` exceeded | Low | Medium | Throttle 4 s + debounce 100 ms + fingerprint dedupe + `retry_after` honour (lesson 2) |
| Presence never expires on Discord | Certain | Low | `clear()` on `dispose`/SIGINT and on detected drop (lesson 7); document as best-effort |

---

## 9. References

- [`PRESENCE-DESIGN.md`](./PRESENCE-DESIGN.md) — presence vision: identity, tool activity resolver, MCP, phrase pools, telemetry, event priority (task `DOC-004`)
- [`COMMUNITY-ANALYSIS.md`](./COMMUNITY-ANALYSIS.md) — comparison matrix, lessons, per-feature adoptions (task `DISC-001` synthesis)
- [`_research/community-plugins.md`](./_research/community-plugins.md) — raw research, source index with raw URLs (task `DISC-001`)
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — module map, FSM, config schema, transport, extension points, failure modes (task `ARCH-001`)
- [`OPENCODE-PLUGIN-API.md`](./OPENCODE-PLUGIN-API.md) — plugin API pin `193de13a` (§3 hooks, §6 `event`, §11 `message.updated`, §12 `message.part.updated`)
- [`DISCORD-RPC.md`](./DISCORD-RPC.md) — wire format (§3), field caps (§4.2), IPC paths (§2), rate-limit & reconnect (§7)
