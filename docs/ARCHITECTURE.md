# Architecture — opencode Discord Rich Presence

> Parent: `ROOT-001` · Depends on: `DISC-002` · Consumed by: `SCAF-001..003`, `DOC-002`.
> Sources: [`OPENCODE-PLUGIN-API.md`](./OPENCODE-PLUGIN-API.md) (pin `193de13a`), [`DISCORD-RPC.md`](./DISCORD-RPC.md), [`PRESENCE-DESIGN.md`](./PRESENCE-DESIGN.md) (presence-engine vision), [`_research/community-plugins.md`](./_research/community-plugins.md).

---

## Table of Contents

1. [Conventions](#1-conventions)
2. [Module map](#2-module-map)
3. [Data flow](#3-data-flow)
4. [Session state machine](#4-session-state-machine)
5. [Config schema](#5-config-schema)
6. [Transport abstraction](#6-transport-abstraction)
7. [Extension points](#7-extension-points)
8. [Failure modes](#8-failure-modes)

---

## 1. Conventions

- TypeScript strict, runtime Bun/Node via `node:net`. No `any`.
- `Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>` — see `OPENCODE-PLUGIN-API.md` §3.
- Config precedence: **global file < project file < env var < runtime `PluginOptions`** (§5).
- Wire: `LE u32 opcode + LE u32 length + JSON`, `MaxRpcFrameSize 64 KiB`, opcodes `0..4` — `DISCORD-RPC.md` §3.
- Rate limit: **5 `SET_ACTIVITY` / 20 s**; client enforces **≤ 1 / 4 s** — `DISCORD-RPC.md` §7.3.
- Every source file ≤ 500 lines (`wc -l`).

---

## 2. Module map

```
src/
├── index.ts                 # re-exports Plugin, no logic
├── plugin.ts                # hook wiring + lifecycle
├── types.ts                 # shared types, SDK narrowings
├── config/{schema,loader}.ts
├── core/{session-tracker,state-machine,presence-model,presence-scheduler,tool-activity-resolver}.ts
├── discord/{transport,ipc,presence,reconnect}.ts
└── utils/logger.ts
```

| Module | Owns | Must NOT own |
|---|---|---|
| `index.ts` | Re-export `Plugin`. No side effects. | Hook logic, I/O |
| `plugin.ts` | Constructs deps, registers `Hooks` (`event`, `tool.execute.*`, `permission.ask`, `experimental.session.compacting`, `dispose`), maps events → `StateEvent` | Frame codec, file I/O |
| `config/*` | Schema, defaults, file discovery, merge + validation | Transport, rendering |
| `core/session-tracker.ts` | Per-session `SessionStats` keyed by `sessionID` (idempotent by `messageID`) + active-session `pickActive()` | Discord I/O |
| `core/state-machine.ts` | FSM per session, emits `PresenceModel` | Socket handling |
| `core/presence-model.ts` | Pure `PresenceModel → Activity` + templates/telemetry | State, transport |
| `core/presence-scheduler.ts` | Debounce/throttle/dedupe fingerprint + nonce generation | Presence content |
| `core/tool-activity-resolver.ts` | Normalizes builtin/custom/MCP tools → `ToolActivity` | Transport, rendering |
| `discord/transport.ts` | `Transport` iface + `FrameDecoder` + nonce table + `SET_ACTIVITY`/`CLEAR` | Presence content |
| `discord/ipc.ts` | IPC path resolution + `net.connect` probe | Reconnect policy |
| `discord/reconnect.ts` | Reconnect FSM + exponential backoff + send queue | Content decisions |
| `discord/presence.ts` | `buildActivity()` + asset key/button/type validation | Transport |
| `utils/logger.ts` | `debug/info/warn/error` via `client.app.log` | Business logic |

### 2.1 Boundary interfaces

```ts
// src/types.ts
import type { PluginInput as SdkPluginInput } from "@opencode-ai/plugin";
import type { Event, Message, Part, Session, SessionStatus } from "@opencode-ai/sdk";
export type PluginDeps = Pick<SdkPluginInput, "client" | "project" | "directory" | "worktree">;
export type SessionStats = {
  sessionID: string; providerID: string; modelID: string; mode: string;
  cost: number;
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
  promptCount: number; startedAt: number; lastActivityAt: number;
  contextTokens?: number; contextLimit?: number;
};
export type PresenceModel = {
  details: string; state?: string; startTimestamp?: number; // seconds for RPC — DISCORD-RPC.md §4.2
  largeImageKey: string; largeImageText: string;
  smallImageKey?: string; smallImageText?: string;
  buttons?: Array<{ label: string; url: string }>; // max 2, label 1..32 / url 1..512
  instance?: boolean;
};
export type SessionStateKind = "idle" | "active" | "tool-running" | "waiting-permission" | "compacting" | "error";
```

```ts
// src/config/schema.ts — zod infers this
export type ResolvedConfig = {
  enabled: boolean; debug: boolean; applicationId: string;
  largeImageKey: string; largeImageText: string; smallImageKey?: string; smallImageText?: string;
  detailsTemplate: string; stateTemplate: string;
  activityType: "playing" | "listening" | "watching" | "competing"; activityName?: string;
  phrases: { details: string[]; state: string[]; mode: "random" | "sequential"; rotateMs: number; cooldownMs: number };
  presence: { showTodo: boolean; showContext: boolean; showSessionTitle: boolean; showMcpProvider: boolean };
  privacy: { hideProjectPath: boolean; hideModel: boolean; hideCost: boolean; hideFilePaths: boolean };
  idle: { enabled: boolean; timeoutMs: number; details: string; state: string };
  reconnect: { enabled: boolean; baseMs: number; capMs: number; maxAttempts: number; jitterRatio: number; handshakeTimeoutMs: number };
  throttle: { debounceMs: number; minIntervalMs: number };
  assets: { validate: boolean };
  buttons: Array<{ label: string; url: string }>;
  multiSession: { strategy: "leader-election" | "last-wins" };
  sessionStats: { showModel: boolean; showTokens: boolean; showCost: boolean; showElapsed: boolean };
  perProject: { enabled: boolean; filename: string };
};
export interface ConfigLoader { load(cwd: string, runtimeOptions?: Record<string, unknown>): Promise<ResolvedConfig>; }
```

```ts
// src/core/state-machine.ts
export type StateEvent =
  | { type: "session.created"; sessionID: string; title: string }
  | { type: "session.idle"; sessionID: string }
  | { type: "session.error"; sessionID: string; errorName: string }
  | { type: "message.updated"; sessionID: string; stats: SessionStats }
  | { type: "tool.start"; sessionID: string; tool: string; filePath?: string }
  | { type: "tool.end"; sessionID: string }
  | { type: "permission.ask"; sessionID: string } | { type: "permission.replied"; sessionID: string }
  | { type: "todo.updated"; sessionID: string; done: number; total: number }
  | { type: "compacting.start"; sessionID: string } | { type: "compacting.end"; sessionID: string }
  | { type: "session.deleted"; sessionID: string } | { type: "idle.timeout"; sessionID: string };
export interface StateMachine {
  readonly sessionID: string; readonly state: SessionStateKind;
  dispatch(event: StateEvent): PresenceModel | null; // null = no visible change, skip push
  getModel(): PresenceModel; dispose(): void;
}
```

```ts
// src/core/session-tracker.ts
export interface SessionTracker {
  register(sessionID: string, startedAt: number): void;
  touch(sessionID: string, atMs: number): void; remove(sessionID: string): void;
  pickActive(): string | null; onPickChanged(cb: (id: string | null) => void): () => void;
}
```

```ts
// src/discord/transport.ts
export type TransportState = "disconnected" | "connecting" | "ready" | "degraded" | "closed";
export interface Transport {
  readonly state: TransportState;
  connect(): Promise<void>; setActivity(a: Record<string, unknown> | null, nonce: string): Promise<void>;
  clear(): Promise<void>; close(): Promise<void>;
  on(e: "ready" | "disconnected" | "error" | "closed", cb: (arg?: unknown) => void): void;
  off(e: string, cb: (arg?: unknown) => void): void;
}
export interface FrameDecoder { push(chunk: Buffer, onFrame: (op: number, payload: unknown) => void): void; }
```

```ts
// src/utils/logger.ts
export interface Logger {
  debug(m: string, extra?: Record<string, unknown>): Promise<void>;
  info(m: string, extra?: Record<string, unknown>): Promise<void>;
  warn(m: string, extra?: Record<string, unknown>): Promise<void>;
  error(m: string, extra?: Record<string, unknown>): Promise<void>;
}
```

`src/plugin.ts` contract:

```ts
import type { Plugin } from "@opencode-ai/plugin";
export const createDiscordPresencePlugin: Plugin = async (input, options) => {
  // 1. load config (loader.ts)  2. create logger, Map<sessionID, StateMachine>, coordinator, transport
  // 3. return Hooks — see §3
  return { event: async () => {}, "tool.execute.before": async () => {}, dispose: async () => {} };
};
export default createDiscordPresencePlugin;
```

---

## 3. Data flow

```
opencode runtime
  hooks: chat.message/params, tool.execute.before/after, permission.ask,
         experimental.session.compacting, event: session.*/message.*/todo.*/permission.*
              │
              ▼
     plugin.ts — maps raw events → StateEvent, debounces file/watcher (100 ms)
              │ StateEvent
              ▼
     session-tracker.ts — upsert SessionStats by messageID (replace, not sum — OPENCODE-PLUGIN-API.md §11.3)
              │ SessionStats
              ▼
     state-machine.ts (per SID) — FSM transition → SessionStateKind + PresenceModel
              │ PresenceModel
              ▼
     session-tracker.ts — pickActive() — file-based leader election, stale GC, handoff settle
              │ winning PresenceModel | null
              ▼
     presence-model.ts + presence.ts — template + privacy + truncation + validateActivity()
              │ Activity (Discord shape)
              ▼
     core/presence-scheduler.ts + discord/transport.ts — nonce table + queue, debounce 100 ms, throttle 4000 ms, dedupe fingerprint
              │ SET_ACTIVITY { pid, activity, nonce } (opcode 1 FRAME)
              ▼
     discord/transport.ts + ipc.ts — handshake {v:1, client_id} (opcode 0), scan 0..9
              │ LE u32 op + LE u32 len + JSON
              ▼
          Discord IPC  (\\?\pipe\discord-ipc-{n}  or  $XDG/.../discord-ipc-{n})
```

**Debounce / throttle points (normative):**

| Point | Window | Purpose | Source |
|---|---|---|---|
| `file.edited` / `file.watcher.updated` | 100 ms debounce | avoid flicker | Puri12 `DEBOUNCE_MS` |
| `presence-model → client` coalesce | 100 ms debounce | merge `message.part.updated` bursts | Puri12 pattern |
| `client → transport` throttle | 4000 ms min interval | respect 5/20 s limit | `DISCORD-RPC.md` §7.3 |
| `message.part.updated` delta | do NOT forward directly | throttle ≤ 0.5 Hz | pin `193de13a` §12 |
| Dedupe | `JSON.stringify(activity)` fingerprint | skip identical `SET_ACTIVITY` | Khip01 fingerprint |

---

## 4. Session state machine

### 4.1 States

| State | Meaning | Enter | Exit |
|---|---|---|---|
| `idle` | Waiting for user | `session.created` (initial), `session.idle`, `idle.timeout`, `tool.end` | `message.updated` (busy), `tool.start`, `permission.ask`, `compacting.start` |
| `active` | Model thinking/streaming | `message.updated` (assistant, `busy`), `message.part.updated` | `tool.start`, `permission.ask`, `session.idle`, `session.error`, `compacting.start` |
| `tool-running` | Tool executing | `tool.start` | `tool.end` → `active`/`idle` |
| `waiting-permission` | Permission gate open | `permission.ask` / `permission.updated` | `permission.replied` → `active`/`idle` |
| `compacting` | Context compaction | `compacting.start` | `compacting.end` → `idle` |
| `error` | Last turn errored | `session.error` | next `message.updated`/`session.created` → `active`/`idle` |

```
              session.created
                    │
                    ▼
              ┌──────┐  message.updated/busy  ┌────────┐
              │ idle │───────────────────────►│ active │
              └──┬───┘                        └───┬────┘
             ▲   │ tool.start            tool.start│
             │   ▼                            ▼    │
             │ ┌──────────────┐         ┌──────────────┐
             └──│ tool-running│◄────────│              │
                └──────┬──────┘         └──────────────┘
                       │ tool.end
                       ▼
                permission.ask
                       │
                       ▼
              ┌───────────────────┐
              │ waiting-permission│
              └────────┬──────────┘
                       │ permission.replied
                       ▼
              ┌────────────┐ compacting.start ┌────────────┐
              │ idle/active│─────────────────►│ compacting │
              │            │◄─────────────────│            │
              └────────────┘  compacting.end  └────────────┘
                    ▲
                    │ session.error
                    ▼
              ┌────────────┐
              │   error    │
              └────────────┘
```

### 4.2 Typed transitions

```ts
// src/core/state-machine.ts
type Transition = { from: SessionStateKind[]; on: StateEvent["type"]; to: SessionStateKind };
const TRANSITIONS: Transition[] = [
  { from: ["idle"], on: "message.updated", to: "active" },
  { from: ["active", "idle"], on: "tool.start", to: "tool-running" },
  { from: ["tool-running"], on: "tool.end", to: "active" },
  { from: ["active", "idle", "tool-running"], on: "permission.ask", to: "waiting-permission" },
  { from: ["waiting-permission"], on: "permission.replied", to: "idle" },
  { from: ["active", "idle"], on: "compacting.start", to: "compacting" },
  { from: ["compacting"], on: "compacting.end", to: "idle" },
  { from: ["active", "tool-running", "waiting-permission", "compacting", "idle"], on: "session.error", to: "error" },
  { from: ["error"], on: "message.updated", to: "active" },
  { from: ["active", "tool-running", "waiting-permission", "compacting", "error"], on: "session.idle", to: "idle" },
  { from: ["active", "tool-running"], on: "idle.timeout", to: "idle" },
];
```

`dispatch` returns `null` when the visible `PresenceModel` is unchanged — caller skips the transport push.

### 4.3 Presence field mapping per state

| State | `details` | `state` | `timestamps.start` | `smallImageKey/Text` |
|---|---|---|---|---|
| `idle` | `"Idle — ready"` / idle template | `"$<cost> · <tokens> tokens"` | `startedAt` (seconds) | idle icon |
| `active` | `"Working with <model>"` / `detailsTemplate` | `"$<cost> · <tokens> · <elapsed>"` | same | model icon / `"Thinking…"` |
| `tool-running` | `"Running <tool>"` + file label (if allowed) | previous `state` | same | tool icon |
| `waiting-permission` | `"Waiting for approval"` | permission `title` (≤128) | same | `ask` icon |
| `compacting` | `"Compacting context…"` | `"Summarizing session"` | same | compact icon |
| `error` | `"Error"` | `errorName` | same | error icon |

All states share `largeImageKey/Text` + `buttons` from config. Caps: `details`/`state`/`large_text`/`small_text` ≤ 128, keys ≤ 32 (`discord_rpc.h` historical, stay within — `DISCORD-RPC.md` §4.2). Buttons: max 2, label 1..32 / url 1..512 / `https://` only.

### 4.4 Tool activity resolution

`state` derives from the **currently active tool** via the Tool Activity Resolver (`core/tool-activity-resolver.ts`); generic labels (`Thinking`, `Working`) are forbidden. Sources: **builtin** (`read`/`edit`/`write`/`bash`/`grep`/`glob`/`lsp`/`patch`/`todo`/`task`), **custom** (user/plugin tools), and **MCP** (first-class). All normalize to `ToolActivity { source, provider?, tool, action, target?, phrase }` and render as `<Activity> • <Phrase>`. MCP is parsed generically from `mcp__<provider>__<tool>`; unknown providers/tools fall back to `MCP • Running <tool> • <phrase>` with no engine change. Phrases come from `phrases.details`/`phrases.state` (non-empty overrides the matching `*Template`; template vars such as `{project}` are expanded), selected per `phrases.mode`, rotated per `phrases.rotateMs`, and gated by `phrases.cooldownMs`. Telemetry (context `150.4K (57%)` + `TODO 4/9`) merges into `state` because Discord renders only two text lines. Event priority: `ERROR > PERMISSION > MCP/TOOL > FILE > THINKING > IDLE`. Full model + verified Discord constraints: [`PRESENCE-DESIGN.md`](./PRESENCE-DESIGN.md) §§5–12, §16.

---

## 5. Config schema

Precedence (lowest → highest): **global file < project file < env var < runtime `PluginOptions`**.

| Source | Path / key |
|---|---|
| Global file | `~/.config/opencode/discord-presence.json` (honours `OPENCODE_CONFIG_DIR`) |
| Project file | `<projectRoot>/.discord-presence.json` (or `perProject.filename`) |
| Env var | `OPENCODE_DISCORD_*` (see table) |
| Runtime | `opencode.json` → `plugin: [["@vheins/opencode-discord-rich-presence", { … }]]` (tuple second element) |

Deep merge: objects merge, arrays **replace** (so `buttons` from higher precedence wins), scalars replace.

### 5.1 Options — exact spec

| Option | Type | Default | Env var | Description |
|---|---|---|---|---|
| `enabled` | `boolean` | `true` | `OPENCODE_DISCORD_ENABLED` (`"false"` disables) | Master toggle. `false` → no hooks, no connect. |
| `applicationId` | `string` | `""` → bundled `DEFAULT_CLIENT_ID` | `OPENCODE_DISCORD_CLIENT_ID` / `DISCORD_APP_ID` | Discord Application ID (`/^\d{17,20}$/`). https://discord.com/developers/applications |
| `debug` | `boolean` | `false` | `OPENCODE_DISCORD_DEBUG` | Verbose `client.app.log` (`level:"debug"`). |
| `largeImageKey` | `string` | `"opencode"` | `DISCORD_LARGE_IMAGE_KEY` | Art Asset key (lower-cased) or `mp:`/`https://` URL. 1..32 chars. |
| `largeImageText` | `string` | `"opencode"` | `DISCORD_LARGE_IMAGE_TEXT` | Hover text for large image. 1..128. |
| `smallImageKey` | `string \| undef` | `undefined` | `DISCORD_SMALL_IMAGE_KEY` | Overlay icon key. Omit = no overlay. |
| `smallImageText` | `string \| undef` | `undefined` | `DISCORD_SMALL_IMAGE_TEXT` | Hover text for small image. |
| `detailsTemplate` | `string` | `"Working with {model}"` | — | `details` template. Vars: `{model}` `{provider}` `{project}` `{file}` `{elapsed}`. |
| `stateTemplate` | `string` | `"{cost} · {tokens} tokens"` | — | `state` template. Same vars + `{done}` `{total}` `{contextPercent}`. |
| `activityType` | `"playing" \| "listening" \| "watching" \| "competing"` | `"playing"` | `OPENCODE_DISCORD_ACTIVITY_TYPE` | Activity `type` → RPC `0/2/3/5`. `1`/`4` invalid. `listening` = Spotify-like. |
| `activityName` | `string \| undefined` | `undefined` | `OPENCODE_DISCORD_ACTIVITY_NAME` | Activity `name` override, best-effort (`PRESENCE-DESIGN.md` §16.1). ≤128. |
| `phrases.details` | `string[]` | `[]` | — | `details` pool; non-empty overrides `detailsTemplate`. Template vars allowed. |
| `phrases.state` | `string[]` | `[]` | — | `state` pool; non-empty overrides `stateTemplate`. Template vars allowed. |
| `phrases.mode` | `"random" \| "sequential"` | `"random"` | — | Pool selection order. |
| `phrases.rotateMs` | `number` | `0` | `OPENCODE_DISCORD_ROTATE_MS` | `0` = once per transition; `>0` rotates (clamped 5000..3600000), timer `.unref()`. |
| `phrases.cooldownMs` | `number` | `5000` | — | Min gap before a new phrase (`PRESENCE-DESIGN.md` §15). |
| `privacy.hideProjectPath` | `boolean` | `false` | `OPENCODE_DISCORD_HIDE_PROJECT` | Omit project/directory from `details`. |
| `privacy.hideModel` | `boolean` | `false` | `OPENCODE_DISCORD_HIDE_MODEL` | Omit model; `details` → `"Working"`. |
| `privacy.hideCost` | `boolean` | `false` | `OPENCODE_DISCORD_HIDE_COST` | Omit cost from `state`. |
| `privacy.hideFilePaths` | `boolean` | `true` | `OPENCODE_DISCORD_HIDE_FILES` | Default on — no file names in presence. |
| `idle.enabled` | `boolean` | `true` | — | `idle` shows distinct text vs last `active`. |
| `idle.timeoutMs` | `number` | `300000` (5 min) | `OPENCODE_DISCORD_IDLE_TIMEOUT` | Force `idle` after no activity. Clamped 10 s..1 h. |
| `idle.details` | `string` | `"Idle — ready"` | — | `details` when `idle`. |
| `idle.state` | `string` | `"{cost} · {tokens} tokens"` | — | `state` when `idle`. |
| `reconnect.enabled` | `boolean` | `true` | — | Auto-reconnect on IPC drop. |
| `reconnect.baseMs` | `number` | `1000` | — | First retry delay. |
| `reconnect.capMs` | `number` | `30000` | — | Max backoff. |
| `reconnect.maxAttempts` | `number` | `10` | `OPENCODE_DISCORD_MAX_RETRIES` | → `closed` after this many failures. |
| `reconnect.jitterRatio` | `number` | `0.2` | — | ±20% jitter. |
| `reconnect.handshakeTimeoutMs` | `number` | `10000` | — | Await `READY` timeout (Khip01 uses 30000; default 10000). |
| `throttle.debounceMs` | `number` | `100` | — | Coalesce window before `SET_ACTIVITY`. |
| `throttle.minIntervalMs` | `number` | `4000` | — | Min gap between sends (5/20 s → 4 s). |
| `assets.validate` | `boolean` | `true` | — | Validate `type ∈ {0,2,3,5}`, buttons ≤2, key/URL. |
| `buttons` | `Array<{label,url}>` | `[{label:"View on GitHub",url:"https://github.com/vheins/opencode-discord-rich-presence"}]` | — | Max 2. Label 1..32, url 1..512 `https://`. `[]` = none. |
| `multiSession.strategy` | `"leader-election" \| "last-wins"` | `"leader-election"` | — | Display pick when multiple instances run. |
| `sessionStats.showModel` | `boolean` | `true` | — | Include model (respects `hideModel`). |
| `sessionStats.showTokens` | `boolean` | `true` | — | Include token counts. |
| `sessionStats.showCost` | `boolean` | `true` | — | Include cost (respects `hideCost`). |
| `sessionStats.showElapsed` | `boolean` | `true` | — | Include `timestamps.start` timer. |
| `presence.showTodo` | `boolean` | `true` | — | Append `TODO 4/9` to `state` (`PRESENCE-DESIGN.md` §9). |
| `presence.showContext` | `boolean` | `true` | — | Append `150.4K (57%)` to `state` (`PRESENCE-DESIGN.md` §8). |
| `presence.showSessionTitle` | `boolean` | `true` | — | Use the session title as `details`. |
| `presence.showMcpProvider` | `boolean` | `true` | — | Show the MCP provider name on MCP activities. |
| `perProject.enabled` | `boolean` | `true` | — | Look for project-level file. |
| `perProject.filename` | `string` | `".discord-presence.json"` | — | Filename in `project.directory` / `worktree`. |

**Feature coverage:**

| Feature | Options |
|---|---|
| (a) Session stats | `sessionStats.*`, `privacy.hideModel/hideCost`, template vars `{model}` `{tokens}` `{cost}` `{contextPercent}` |
| (b) Cross-platform IPC + reconnect | `reconnect.*`, `throttle.*` + `discord/ipc.ts` (auto-detected, `DISCORD-RPC.md` §2) |
| (c) Privacy/idle + per-project | `privacy.*`, `idle.*`, `perProject.*` |
| (d) Custom app id & assets | `applicationId`, `largeImageKey/Text`, `smallImageKey/Text`, `assets.validate` |
| (e) Buttons/links + multi-session | `buttons`, `multiSession.strategy` |
| (f) Presence customization + engine | `activityType`, `activityName`, `phrases.*`, `presence.show*` + `core/tool-activity-resolver.ts` |

### 5.2 Validation

`schema.ts` uses `zod` to parse the merged object; on failure log `level:"warn"` and fall back to defaults for that subtree — never crash plugin load. `buttons` URLs must be `https:`; `applicationId` must match `/^\d{17,20}$/` when non-empty.

---

## 6. Transport abstraction

### 6.1 Interface

`Transport` is the only surface `reconnect.ts` depends on — swap impl (library, custom `net`, stub) via this iface. `FrameDecoder` is per-connection and loops over coalesced frames (fixes both library bugs in `DISCORD-RPC.md` §3.1):

```ts
// discord/transport.ts
class FrameDecoderImpl implements FrameDecoder {
  private buf = Buffer.alloc(0);
  push(chunk: Buffer, onFrame: (op: number, payload: unknown) => void): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 8) {
      const op = this.buf.readUInt32LE(0), len = this.buf.readUInt32LE(4);
      if (len > 64 * 1024) throw new Error(`frame too large: ${len}`);
      if (this.buf.length < 8 + len) break;
      const json = this.buf.subarray(8, 8 + len).toString("utf8");
      this.buf = this.buf.subarray(8 + len);
      onFrame(op, JSON.parse(json));
    }
  }
}
```

### 6.2 Reconnect / backoff

Ref: `DISCORD-RPC.md` §7.1–7.2 and community findings (Puri12 generation guard, Khip01 ×1.5).

```
disconnected ─connect()─► connecting ─READY─► ready ─SET_ACTIVITY ok─► ready
     ▲                        │                │  ▲
     │ maxAttempts/close()    │ error/close    │  │ degraded→retry ok
     └──────────────── disconnected        degraded
                              ▲                │
                              └──── backoff ───┘
```

```ts
let attempt = 0, generation = 0; // Puri12: ignore stale ready/disconnected
function nextDelay(n: number, baseMs: number, capMs: number, jitterRatio: number): number {
  const exp = Math.min(capMs, baseMs * 2 ** n);
  const jitter = exp * jitterRatio * (Math.random() * 2 - 1);
  return Math.max(250, Math.round(exp + jitter));
}
// on failure/disconnect: scheduleReconnect()
//   if (!reconnect.enabled || attempt >= maxAttempts) → "closed", stop
//   setTimeout(connect, nextDelay(attempt++, baseMs, capMs, jitterRatio)).unref()
// on READY: attempt=0; generation++; state="ready"; flush pending
// on CLOSE frame (opcode 2): do NOT auto-reconnect without backoff
```

Defaults: `baseMs 1000`, `capMs 30000`, `maxAttempts 10`, `jitterRatio 0.2`, `handshakeTimeoutMs 10000` (all via `reconnect.*`). `generation` guards the zombie-client bug: each `connect()` bumps it; handlers no-op if stale.

### 6.3 Rate-limit / debounce

| Layer | Mechanism | Value |
|---|---|---|
| Coalesce | `scheduleUpdate()` debounce | `throttle.debounceMs` (100 ms) — keep latest `PresenceModel` |
| Throttle | `minIntervalMs` gate | 4000 ms — guarantees ≤ 5/20 s |
| Dedupe | `JSON.stringify(activity)` fingerprint | skip identical `SET_ACTIVITY` |
| Queue | at most one pending `SET_ACTIVITY` while in flight | coalesces further updates |
| Nonce table | `Map<nonce, {resolve,reject,timer}>` 10 s timeout | prevents leaked promises |
| `retry_after` | honour server `retry_after` over `nextDelay` | `DISCORD-RPC.md` §7.2 |

Clearing: `clear()` sends `{ cmd:"SET_ACTIVITY", args:{ pid: process.pid, activity: null }, nonce }` — no `CLEAR_ACTIVITY`.

---

## 7. Extension points

| Want to… | Touch | How |
|---|---|---|
| Add presence field | `types.ts` `PresenceModel` → `core/presence-model.ts` builder + `discord/presence.ts` `buildActivity()` | Add field, extend builder + `discord/presence.ts` validation |
| Handle new opencode event | `plugin.ts` + `core/state-machine.ts` (`StateEvent` + `TRANSITIONS`) | New `event` branch → new `StateEvent` variant + transition row; no transport change |
| Add config option | `config/schema.ts` + `docs/CONFIGURATION.md` | Add zod key with `default()`, wire env in `loader.ts`, document in §5.1 |
| Swap transport | `discord/transport.ts` (`Transport`) | Implement iface (wrap `@xhayper/discord-rpc` or custom `net`); inject via `plugin.ts` (`DiscordPresenceRuntime.createTransport`); keep `FrameDecoder` per-connection |
| Custom display strategy | `core/session-tracker.ts` | Implement `SessionTracker` with a different `pickActive()` |
| New template var | `core/presence-model.ts` | Add to renderer + `VALID_TEMPLATE_VARS` allow-list |
| New asset/button preset | `config/schema.ts` defaults + `discord/presence.ts` | Defaults only, unless adding asset packs |

`plugin.ts` stays thin — it only wires; domain in `core/`, I/O in `discord/`.

---

## 8. Failure modes

| Failure | Detection | Behaviour |
|---|---|---|
| Discord not running | `connect()` `ENOENT`/timeout (`handshakeTimeoutMs`) | Stay `disconnected`; `scheduleReconnect()` with backoff; `debug` first failure, `warn` after `maxAttempts`; drop presence updates; next event re-arms `connect()` |
| IPC lost (quit/crash) | socket `close`/`error`/write error | `ready`/`degraded` → `disconnected`; reject pending nonces; `scheduleReconnect()`; re-push on `ready` |
| `CLOSE` from server (opcode 2) | `CLOSE` frame `{code,message}` | → `closed`; do NOT auto-reconnect without backoff; next user action may `connect()` again |
| Rate limited | `ERROR` + `retry_after` | → `degraded`; keep socket; retry latest coalesced activity after `retry_after`; coalesce intermediates |
| Invalid activity | `assets.validate` throws | Drop update, `warn`, stay in state; never send invalid payload |
| Multi-session conflict | `pickActive()` contenders | Only leader pushes; others keep local FSM; on leader exit elect new leader within `minIntervalMs` (GC `staleThresholdMs` 10 s, settle ~1200 ms — Puri12) |
| Config malformed | zod parse fails | `warn`, defaults for that subtree, continue; never crash load |
| Handshake timeout | no `READY` in `handshakeTimeoutMs` | Connect failure → `scheduleReconnect()` |
| Shutdown (`dispose`/SIGINT) | `dispose` hook | `clear()` (`activity: null`), `close()` socket, clear `unref`'d timers, remove leader file; no reconnect after `dispose` |

**Invariants:**

- All outliving timers (`reconnect`, `idle.timeout`, `throttle`) `.unref()` — never keep opencode alive (Puri12/Khip01 pattern).
- `clear()` is best-effort — Discord never expires presence; stale card remains until overwrite or Discord restart.
- No secret (token, file content, conversation text) enters `details`/`state`/`assets` — privacy defaults enforce this.
- `client.app.log` is fire-and-forget safe (catch and ignore failures).

---

*Scaffold `SCAF-001` (tooling + `config`/`core`/`utils`), `SCAF-002` (`discord/`), `SCAF-003` (`plugin.ts` + examples) implement this verbatim. `DOC-002` expands §5 into `CONFIGURATION.md` / `EXTENDING.md`.*
