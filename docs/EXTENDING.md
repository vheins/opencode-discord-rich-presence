# Extending — opencode Discord Rich Presence

> Architecture: [`ARCHITECTURE.md`](./ARCHITECTURE.md) · Config: [`CONFIGURATION.md`](./CONFIGURATION.md) · Wire: [`DISCORD-RPC.md`](./DISCORD-RPC.md)

This guide shows how to extend the plugin without breaking its layering.
All paths reference the real module map from `ARCHITECTURE.md §2`.

```
src/
├── index.ts                 # re-export only
├── plugin.ts                # hook wiring + lifecycle (thin)
├── types.ts                 # shared types, SDK narrowings
├── config/{schema,loader}.ts
├── core/{session-state,state-machine,presence-model,multi-session,tool-resolver}.ts
├── discord/{transport,ipc,client,assets}.ts
└── utils/{logger,format}.ts
```

**Layer rule:** `plugin.ts` wires — domain lives in `core/`, I/O in `discord/`, schema in `config/`.
Business logic never lives in closures inside `plugin.ts`.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Recipe 1 — Add a presence field](#2-recipe-1--add-a-presence-field)
3. [Recipe 2 — Handle a new opencode event](#3-recipe-2--handle-a-new-opencode-event)
4. [Recipe 3 — Add or replace a transport](#4-recipe-3--add-or-replace-a-transport)
5. [Recipe 4 — Add a config option](#5-recipe-4--add-a-config-option)
6. [Recipe 5 — Add a test](#6-recipe-5--add-a-test)
7. [Recipe 6 — Add a phrase-pool entry](#7-recipe-6--add-a-phrase-pool-entry)
8. [Recipe 7 — Add a tool→activity mapping](#8-recipe-7--add-a-toolactivity-mapping)
9. [Keeping types in sync](#9-keeping-types-in-sync)

---

## 1. Prerequisites

- Read `ARCHITECTURE.md §2` (module map), `§4` (FSM), `§5` (config), `§6` (transport), `§7` (extension points).
- `src/types.ts` is the single source for `PresenceModel`, `SessionStats`, `SessionStateKind`.
- `src/config/schema.ts` (zod) is the single source for `ResolvedConfig`.
- Every new field must flow: **type → domain → rendering → transport (if wire) → config (if user-facing) → test**.

Validate after each recipe: `bun run typecheck && bun run lint && bun run format:check`
(see `ARCHITECTURE.md §1` — strict TS, `src/` ≤500 lines/file).

---

## 2. Recipe 1 — Add a presence field

**Goal:** add `party` (e.g., `(2 of 5)`) to the displayed presence.

### 2a. Extend the model — `src/types.ts`

```ts
// src/types.ts — add to PresenceModel
export type PresenceModel = {
  // ...existing fields
  party?: { id: string; size: [number, number] };
};
```

### 2b. Render it — `src/core/presence-model.ts`

```ts
// src/core/presence-model.ts
import type { PresenceModel } from "../types.js";

export function buildActivity(model: PresenceModel): Record<string, unknown> {
  const activity: Record<string, unknown> = {
    details: truncate(model.details, 128),
    state: model.state ? truncate(model.state, 128) : undefined,
    // ...
  };
  if (model.party) {
    activity.party = { id: model.party.id, size: model.party.size };
  }
  return activity;
}
```

### 2c. Validate it — `src/discord/assets.ts`

```ts
// src/discord/assets.ts
export function validateActivity(a: Record<string, unknown>): void {
  const party = a.party as { size?: [number, number] } | undefined;
  if (party?.size && (party.size[0] > party.size[1])) {
    throw new RangeError("party.size: current must be ≤ max");
  }
}
```

`assets.validate` (`CONFIGURATION.md #26`) gates this call in `src/discord/client.ts`.

### 2d. Wire state → model — `src/core/state-machine.ts`

Decide which `SessionStateKind` shows the party (e.g., `active`, `tool-running`).
Update the per-state field map (`ARCHITECTURE.md §4.3`) and `getModel()` for that state.

### 2e. Extension point

| Want to… | Touch | Keep in sync |
|---|---|---|
| Presence field | `src/types.ts` → `src/core/presence-model.ts` → `src/discord/assets.ts` | `validateActivity`, `buildActivity`, per-state mapping table |

---

## 3. Recipe 2 — Handle a new opencode event

**Goal:** react to a new opencode event, e.g. `experimental.session.compacting` (already in the map) or a future SDK event.

### 3a. Add the `StateEvent` variant — `src/core/state-machine.ts`

```ts
// src/core/state-machine.ts
export type StateEvent =
  | { type: "session.created"; sessionID: string; title: string }
  // ...existing variants
  | { type: "compacting.start"; sessionID: string }
  | { type: "compacting.end"; sessionID: string }
  // new:
  | { type: "my.newEvent"; sessionID: string; payload: string };
```

Add the transition row:

```ts
const TRANSITIONS: Transition[] = [
  // ...existing rows
  { from: ["active", "idle"], on: "my.newEvent", to: "active" },
];
```

Implement the branch in `dispatch()` — return a new `PresenceModel` or `null` (no visible change → transport skipped).

### 3b. Map the raw opencode hook — `src/plugin.ts`

```ts
// src/plugin.ts — inside createDiscordPresencePlugin
return {
  event: async ({ event }) => {
    if (event.type === "my.newEvent") {
      const se: StateEvent = { type: "my.newEvent", sessionID: event.properties.sessionID, payload: "..." };
      const model = machines.get(se.sessionID)?.dispatch(se);
      if (model) scheduleUpdate(model);
    }
  },
  // existing hooks: "tool.execute.before", "permission.ask", "experimental.session.compacting", dispose
};
```

`plugin.ts` does mapping only — it never builds the `PresenceModel` or calls transport directly.

### 3c. Check idle/reconnect interactions

- If the new event should reset the idle timer, call the same `touch()` used for other activity events.
- No transport change is needed — `src/discord/client.ts` already debounces/throttles whatever `PresenceModel` you produce.

### Extension point

| Want to… | Touch | Keep in sync |
|---|---|---|
| New event | `src/plugin.ts` (map) + `src/core/state-machine.ts` (`StateEvent` + `TRANSITIONS` + `dispatch`) | FSM diagram in `ARCHITECTURE.md §4`, per-state mapping table |

---

## 4. Recipe 3 — Add or replace a transport

**Goal:** swap the Discord transport (e.g., wrap a library, use raw `node:net`, or inject a stub for tests).

### 4a. Implement the interfaces — `src/discord/transport.ts`

```ts
// src/discord/transport.ts
export type TransportState = "disconnected" | "connecting" | "ready" | "degraded" | "closed";
export interface Transport {
  readonly state: TransportState;
  connect(): Promise<void>;
  setActivity(a: Record<string, unknown> | null, nonce: string): Promise<void>;
  clear(): Promise<void>;
  close(): Promise<void>;
  on(e: "ready" | "disconnected" | "error" | "closed", cb: (arg?: unknown) => void): void;
  off(e: string, cb: (arg?: unknown) => void): void;
}
export interface FrameDecoder {
  push(chunk: Buffer, onFrame: (op: number, payload: unknown) => void): void;
}
```

`FrameDecoder` is **per-connection** — it owns `buf` and loops over coalesced frames
(fixes the global-decoder and single-frame-gate bugs in `DISCORD-RPC.md §3.1`).

Reference implementation is in `ARCHITECTURE.md §6.1`.

### 4b. Inject it — `src/discord/client.ts`

```ts
// src/discord/client.ts — transport is the only dep
export function createDiscordClient(opts: { transport: Transport; config: ResolvedConfig }) {
  // owns reconnect FSM, nonce table, debounce/throttle, dedupe
}
```

Swapping means changing which `Transport` you pass to `createDiscordClient` — no change in `plugin.ts`:

```ts
// src/plugin.ts — inject custom transport
import { createCustomTransport } from "./discord/my-transport.js";
const transport = createCustomTransport({ ipcPaths: getIpcPaths() });
const client = createDiscordClient({ transport, config });
```

### 4c. Reuse existing pieces

- `src/discord/ipc.ts` — IPC path resolution + `net.connect` probe (platform-aware, `DISCORD-RPC.md §2`).
- `src/discord/assets.ts` — validation before `setActivity`.
- Reconnect policy (generation guard + backoff + `.unref()` timers) is already in `client.ts` (`ARCHITECTURE.md §6.2`).

Custom transports must honour: `setActivity(null)` clears (`activity: null` — no `CLEAR_ACTIVITY` opcode),
nonces resolve via `Map<nonce, {resolve,reject,timer}>` with 10 s timeout, `CLOSE` (opcode 2) → `closed`
without immediate auto-reconnect.

### Extension point

| Want to… | Touch | Keep in sync |
|---|---|---|
| Replace transport | `src/discord/transport.ts` (iface) + new impl + injection in `src/discord/client.ts` | `FrameDecoder` per-connection, `TransportState` FSM (`ARCHITECTURE.md §6.2`), `src/discord/ipc.ts` if changing discovery |

---

## 5. Recipe 4 — Add a config option

**Goal:** add `privacy.hideWorkspace` (example) that strips the workspace folder from `details`.

### 5a. Extend the schema — `src/config/schema.ts`

```ts
// src/config/schema.ts
import { z } from "zod";

export const configSchema = z.object({
  // ...existing keys
  privacy: z.object({
    hideProjectPath: z.boolean().default(false),
    hideModel: z.boolean().default(false),
    hideCost: z.boolean().default(false),
    hideFilePaths: z.boolean().default(true),
    hideWorkspace: z.boolean().default(false), // new
  }),
}).strict();
export type ResolvedConfig = z.infer<typeof configSchema>;
```

Keep `ResolvedConfig` inferred — no hand-written duplicate.

### 5b. Wire env var — `src/config/loader.ts`

```ts
// src/config/loader.ts — inside env overlay
if (process.env.OPENCODE_DISCORD_HIDE_WORKSPACE !== undefined) {
  env.privacy ??= {};
  env.privacy.hideWorkspace = process.env.OPENCODE_DISCORD_HIDE_WORKSPACE !== "false";
}
```

### 5c. Consume it — `src/core/presence-model.ts`

```ts
// src/core/presence-model.ts
if (config.privacy.hideWorkspace) {
  // strip workspace segment from details
}
```

### 5d. Document it — `docs/CONFIGURATION.md`

Add a row to the full reference table (§4) and to the `privacy.*` detail table.
Count must stay accurate — this recipe would move the total from 45 → 46.

### Extension point

| Want to… | Touch | Keep in sync |
|---|---|---|
| Config option | `src/config/schema.ts` (zod + default) → `src/config/loader.ts` (env/file mapping) → consumer (`core/` or `discord/`) → `docs/CONFIGURATION.md` §4 | `ResolvedConfig` inferred type, precedence table, feature coverage matrix (`ARCHITECTURE.md §5`) |

---

## 6. Recipe 5 — Add a test

Tests are colocated per module. No test suite is scaffolded yet — follow this layout when adding one:

```
tests/
├── config/schema.test.ts
├── core/{state-machine,presence-model,session-state,multi-session}.test.ts
├── discord/{transport,client,assets}.test.ts
└── plugin.test.ts
```

### 6a. Config schema test

```ts
// tests/config/schema.test.ts
import { describe, it, expect } from "bun:test";
import { configSchema } from "../../src/config/schema.js";

describe("configSchema", () => {
  it("defaults hideFilePaths to true", () => {
    const parsed = configSchema.parse({});
    expect(parsed.privacy.hideFilePaths).toBe(true);
  });
  it("rejects non-https button url", () => {
    expect(() => configSchema.parse({ buttons: [{ label: "x", url: "http://x" }] })).toThrow();
  });
});
```

### 6b. State machine test

```ts
// tests/core/state-machine.test.ts
import { describe, it, expect } from "bun:test";
import { createStateMachine } from "../../src/core/state-machine.js";

describe("StateMachine", () => {
  it("active → tool-running on tool.start", () => {
    const sm = createStateMachine("sid-1");
    sm.dispatch({ type: "message.updated", sessionID: "sid-1", stats: /* ... */ } as never);
    const model = sm.dispatch({ type: "tool.start", sessionID: "sid-1", tool: "read" });
    expect(sm.state).toBe("tool-running");
    expect(model).not.toBeNull();
  });
  it("dispatch returns null when presence unchanged", () => {
    // second identical dispatch → null → caller skips transport push
  });
});
```

### 6c. Transport stub test

```ts
// tests/discord/client.test.ts
import { describe, it, expect } from "bun:test";
import type { Transport } from "../../src/discord/transport.js";
import { createDiscordClient } from "../../src/discord/client.js";

function stubTransport(): Transport {
  return {
    state: "disconnected",
    connect: async () => {},
    setActivity: async () => {},
    clear: async () => {},
    close: async () => {},
    on() {}, off() {},
  };
}

describe("DiscordClient", () => {
  it("debounces rapid PresenceModel updates", async () => {
    const client = createDiscordClient({ transport: stubTransport(), config: /* ... */ } as never);
    // push N models within debounceMs → expect single setActivity
  });
});
```

### Extension point

| Want to… | Touch | Keep in sync |
|---|---|---|
| Test | New file under `tests/<area>/` matching `src/<area>/` | `src/types.ts` / `src/config/schema.ts` as source of truth; prefer `stubTransport` over real IPC in unit tests |

---

## 7. Recipe 6 — Add a phrase-pool entry

**Goal:** give a tool/action a custom random phrase instead of the default template.

### 7a. Add the pool — `src/config/schema.ts`

`phrases.details` and `phrases.state` are `string[]` (default `[]`). A **non-empty pool overrides the matching `*Template`**; template vars are expanded per entry.

```ts
// src/config/schema.ts
phrases: z.object({
  details: z.array(z.string()).default([]),   // overrides detailsTemplate when non-empty
  state: z.array(z.string()).default([]),     // overrides stateTemplate when non-empty
  mode: z.enum(["random", "sequential"]).default("random"),
  rotateMs: z.number().int().min(0).default(0),
  cooldownMs: z.number().int().min(0).default(5000),
}),
```

### 7b. Selection & rendering — `src/core/presence-model.ts`

- `phrases.mode: "random"` picks uniformly; `"sequential"` walks the pool in order.
- `phrases.rotateMs: 0` selects **once per FSM transition**; `> 0` rotates on a timer clamped to `5000..3600000 ms` and `.unref()`'d so opencode can exit.
- `phrases.cooldownMs` is the minimum gap before a new phrase may be chosen.
- The rendered line is `<Activity> • <Phrase>` (e.g. `Editing • Refactoring auth flow`).

### 7c. Example — `docs/CONFIGURATION.md` §3f

```jsonc
{ "activityType": "listening", "activityName": "opencode",
  "phrases": { "details": ["{project}", "in {project}"], "rotateMs": 60000 } }
```

### Extension point

| Want to… | Touch | Keep in sync |
|---|---|---|
| Phrase pool | `src/config/schema.ts` (`phrases.*`) → `src/core/presence-model.ts` (select + render) | `CONFIGURATION.md` §4/§5, `ARCHITECTURE.md` §5.1; pool entries are user data, never hardcoded in `core/` |

---

## 8. Recipe 7 — Add a tool→activity mapping

**Goal:** map a new builtin, custom, or MCP tool to a human `ToolActivity`.

### 8a. The model — `src/core/tool-resolver.ts`

```ts
// src/types.ts — ToolActivity
export type ToolActivity = {
  source: "builtin" | "custom" | "mcp";
  provider?: string;   // MCP only (e.g. "github")
  tool: string;        // raw tool name
  action: string;      // human verb ("Reading", "Searching")
  target?: string;     // file/query/url, privacy-filtered
  phrase?: string;     // selected from phrases.details
};
```

### 8b. Resolution order

1. **builtin** — `read`/`edit`/`write`/`bash`/`grep`/`glob` map to fixed actions.
2. **custom** — unknown non-MCP tools fall back to `Running <tool>`.
3. **MCP** — tools shaped `mcp__<provider>__<tool>` are parsed generically into `provider` + `tool`; no per-server table needed. An **unknown provider never drops the event** — it renders the generic fallback `MCP • Running <tool> • <phrase>`.
4. `presence.showMcpProvider: false` hides the provider label while keeping the tool action.
5. Concurrent signals resolve by priority: `ERROR > PERMISSION > MCP/TOOL > FILE > THINKING > IDLE`.

### 8c. Test — `tests/core/tool-resolver.test.ts`

```ts
// assert generic MCP parse + unknown fallback
expect(resolve("mcp__github__search_code").provider).toBe("github");
expect(resolve("mcp__unknown__do_thing").action).toContain("do_thing");
```

### Extension point

| Want to… | Touch | Keep in sync |
|---|---|---|
| Tool mapping | `src/core/tool-resolver.ts` (parse + map) → `src/core/presence-model.ts` (`buildActivity()`) | `ARCHITECTURE.md` §4.4, `CONFIGURATION.md` §3f, `DISCORD-RPC.md` §4.1 (type 0/2/3/5, 2-line limit) |

---

## 9. Keeping types in sync

Single sources of truth — do not duplicate:

| Concept | Source of truth | Derived |
|---|---|---|
| Presence shape | `src/types.ts` `PresenceModel` | `src/core/presence-model.ts` `buildActivity()`, `src/discord/assets.ts` `validateActivity()` |
| Session stats | `src/types.ts` `SessionStats` | `src/core/session-state.ts`, `src/core/state-machine.ts` `StateEvent["message.updated"]` |
| FSM states/events | `src/core/state-machine.ts` `SessionStateKind` / `StateEvent` / `TRANSITIONS` | `ARCHITECTURE.md §4` diagram, `src/plugin.ts` event map |
| Resolved config | `src/config/schema.ts` zod `ResolvedConfig` | `src/config/loader.ts`, `docs/CONFIGURATION.md`, `ARCHITECTURE.md §5` |
| Transport contract | `src/discord/transport.ts` `Transport` / `FrameDecoder` | `src/discord/client.ts`, any custom transport impl |
| Multi-session | `src/core/multi-session.ts` `MultiSessionCoordinator` | `src/plugin.ts` `pickActive()` wiring |
| Tool activity | `src/types.ts` `ToolActivity` | `src/core/tool-resolver.ts` parse/map, `src/core/presence-model.ts` render |

**Checklist after any extension:**

1. `bun run typecheck` — no drift between `types.ts`/`schema.ts` and consumers.
2. Update the relevant doc table: `ARCHITECTURE.md §4`/`§5`/`§7` or `CONFIGURATION.md §4`/`§5`.
3. Add/adjust a test under `tests/<area>/`.
4. `wc -l src/<file>.ts` — keep ≤500 lines; split if needed.

---

*Extension points summary lives in `ARCHITECTURE.md §7`. All module paths above are normative.*
