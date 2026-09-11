# OpenCode Plugin API — Authoritative Reference

> **Scope:** plugin lifecycle, `PluginInput` context, every hook/event payload, `tool` helper, logging, compaction, and session-stats wiring for Discord Rich Presence.
> **Audience:** plugin authors targeting `@opencode-ai/plugin` (TypeScript).
> **Sources + retrieval date:** see [Sources](#10-sources--retrieval-date) at end — 2026-09-11. All signatures verified against `anomalyco/opencode@193de13a` (`packages/plugin`, `packages/sdk/js/src/gen/*`, `packages/opencode/src/plugin`).

---

## Table of Contents

1. [What a plugin is](#1-what-a-plugin-is)
2. [Lifecycle and loading](#2-lifecycle-and-loading)
3. [Plugin signature and `PluginInput`](#3-plugin-signature-and-plugininput)
4. [Return value: `Hooks`](#4-return-value-hooks)
5. [Intercept hooks (non-bus)](#5-intercept-hooks-non-bus)
6. [Event bus: `event` hook and `Event` union](#6-event-bus-event-hook-and-event-union)
7. [The `tool` helper and `ToolContext`](#7-the-tool-helper-and-toolcontext)
8. [Logging](#8-logging)
9. [Compaction hooks](#9-compaction-hooks)
10. [Sources and retrieval date](#10-sources--retrieval-date)
11. [Reading active model, tokens, and cost (session stats)](#11-reading-active-model-tokens-and-cost-session-stats)
12. [Events and hooks relevant to Rich Presence](#12-events-and-hooks-relevant-to-rich-presence)
13. [Minimal Rich Presence skeleton](#13-minimal-rich-presence-skeleton)
14. [Versioning and drift notes](#14-versioning-and-drift-notes)
15. [Checklist for presence authors](#15-checklist-for-presence-authors)

---

## 1. What a plugin is

A plugin is a JavaScript/TypeScript module that exports one or more `Plugin` functions. The runtime calls each exported `Plugin` once at startup, passes a `PluginInput` context object, and collects the returned `Hooks` object. All registered hooks run in load order for the lifetime of the process until `dispose` is called.

Type import (verified `packages/plugin/src/index.ts:1`):

```ts
import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
```

`@opencode-ai/plugin` re-exports `tool` and the root SDK types `Event`, `Project`, `Model`, `Provider`, `Permission`, `UserMessage`, `Message`, `Part`, `Config` (all from `@opencode-ai/sdk`). Only `Provider`/`Model` auth helpers come from `@opencode-ai/sdk/v2` — the event/message/part surface used by plugins is the **root** SDK surface.

---

## 2. Lifecycle and loading

### 2.1 Where plugins come from

| Source | Path / config | Install |
|---|---|---|
| Global config | `~/.config/opencode/opencode.json` → `plugin: [...]` | Bun installs listed npm packages at startup; cached in `~/.cache/opencode/node_modules/` |
| Project config | `opencode.json` → `plugin: [...]` | Same |
| Global plugin dir | `~/.config/opencode/plugins/*.{js,ts}` | Loaded directly, no npm publish required |
| Project plugin dir | `.opencode/plugins/*.{js,ts}` | Same |

Local plugins may depend on npm packages by adding a `package.json` inside the config directory (`.opencode/package.json` or `~/.config/opencode/package.json`); OpenCode runs `bun install` at startup before loading them.

`plugin` entries accept `string` or `[string, PluginOptions]`; the second element is forwarded as the plugin's `options` argument.

```jsonc
// opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-helicone-session",
    ["@my-org/custom-plugin", { "feature": true }]
  ]
}
```

### 2.2 Load order and deduplication

Verified in `packages/opencode/src/plugin/index.ts:1-560`:

1. Global config (`~/.config/opencode/opencode.json`)
2. Project config (`opencode.json`)
3. Global plugin directory (`~/.config/opencode/plugins/`)
4. Project plugin directory (`.opencode/plugins/`)

Duplicate **npm packages with the same name and version** are loaded once. A local file and an npm package with similar names are **both** loaded — they are distinct sources. Internal built-ins (`internalPlugins(flags)`) — ~12 providers such as Codex/Copilot/Modal/GitLab/Poe/CloudflareWorkers/Gateway/Azure/DigitalOcean/SnowflakeCortex/Xai/Cerebras — load unless `flags.disableDefaultPlugins` is set. `flags.pure` skips external plugin loading entirely.

Resolution per file:

- If the module matches the v1 plugin shape (`readV1Plugin(mod, spec, "server", "detect")`), the runtime calls `plugin.server(input, load.options)`.
- Otherwise it scans `Object.values(mod)` for server plugins via `getServerPlugin` (accepts a bare `function` or `{ server: function }`); non-conforming exports throw `TypeError`.

### 2.3 Startup sequence

```
config.waitForDependencies()
  → PluginLoader.loadExternal({ items: plugins, kind: "server" })
  → sequential hooks.push(await plugin.server(input, options))
  → sequential hook.config?.(cfg) over collected hooks (mutates config)
  → EventV2Bridge.listen installed (filters event.location.directory !== ctx.directory)
  → hooks remain active until InstanceState disposal
```

`PluginLoader.Plan.options` for each plugin is `ConfigPlugin.pluginOptions(item)` — i.e., the options tuple element from `opencode.json`.

### 2.4 Disposal

If a hook returns `dispose`, the runtime registers it as an `Effect` finalizer via `InstanceState` (`effect/instance-state.ts:30-45`, `ScopedCache` + `registerDisposer`):

```ts
export const MyPlugin: Plugin = async () => {
  const interval = setInterval(tick, 15_000);
  return {
    dispose: async () => clearInterval(interval),
  };
};
```

---

## 3. Plugin signature and `PluginInput`

### 3.1 Signature

From `packages/plugin/src/index.ts:57-83`:

```ts
export type PluginInput = {
  client: ReturnType<typeof createOpencodeClient>;
  project: Project;
  directory: string;
  worktree: string;
  experimental_workspace: {
    register(type: string, adapter: WorkspaceAdapter): void;
  };
  serverUrl: URL;
  $: BunShell;
};

export type PluginOptions = Record<string, unknown>;
export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>;
export type PluginModule = { id?: string; server: Plugin; tui?: never };
```

Basic structure (matches <https://opencode.ai/docs/plugins/#basic-structure>):

```ts
import type { Plugin } from "@opencode-ai/plugin";

export const MyPlugin: Plugin = async ({ project, client, $, directory, worktree }) => {
  await client.app.log({
    body: { service: "my-plugin", level: "info", message: "Plugin initialized" },
  });
  return {
    // hooks
  };
};
```

A module may export **multiple** `Plugin` functions; each is discovered via `Object.values(mod)`.

### 3.2 `PluginInput` fields

| Field | Type | Notes |
|---|---|---|
| `client` | `ReturnType<typeof createOpencodeClient>` (root SDK) | Type-safe client for App/Project/Config/Sessions/Files/TUI/Auth/Events APIs. See §11 snippets. Created from the running server; `createOpencodeClient({ baseUrl })` shape. |
| `project` | `Project` | Current project record (`id`, `workTree`, etc.). From root SDK types. |
| `directory` | `string` | Current working directory for this instance. |
| `worktree` | `string` | Git worktree root. Use `path.relative(worktree, absPath)` for stable display. |
| `experimental_workspace` | `{ register(type, adapter) }` | Registers a `WorkspaceAdapter` (see below). Experimental — signature may change. |
| `serverUrl` | `URL` | Getter for the server URL (property with `get serverUrl()`). |
| `$` | `BunShell` (`Bun.$`) | Bun shell API for `await $\`cmd\``. See <https://bun.com/docs/runtime/shell>. |

`WorkspaceAdapter` (for `experimental_workspace.register`):

```ts
type WorkspaceAdapter = {
  name: string;
  description: string;
  configure(config: WorkspaceInfo): WorkspaceInfo | Promise<WorkspaceInfo>;
  create(config: WorkspaceInfo, env: Record<string, string | undefined>, from?: WorkspaceInfo): Promise<void>;
  remove(config: WorkspaceInfo): Promise<void>;
  target(config: WorkspaceInfo): WorkspaceTarget | Promise<WorkspaceTarget>;
};
```

`WorkspaceInfo` and `WorkspaceTarget` are defined in `packages/plugin/src/index.ts:24-55`.

---

## 4. Return value: `Hooks`

`Hooks` is an interface with optional members — return only what you need. Unlisted keys are ignored.

```ts
interface Hooks {
  dispose?: () => Promise<void>;
  event?: (input: { event: Event }) => Promise<void>;
  config?: (input: Config) => Promise<void>;
  tool?: Record<string, ToolDefinition>;
  auth?: AuthHook;
  provider?: ProviderHook;
  "chat.message"?: (input: {...}, output: {...}) => Promise<void>;
  "chat.params"?: (input: {...}, output: {...}) => Promise<void>;
  "chat.headers"?: (input: {...}, output: {...}) => Promise<void>;
  "permission.ask"?: (input: Permission, output: { status: "ask"|"deny"|"allow" }) => Promise<void>;
  "command.execute.before"?: (input: {...}, output: {...}) => Promise<void>;
  "tool.execute.before"?: (input: {...}, output: {...}) => Promise<void>;
  "shell.env"?: (input: {...}, output: {...}) => Promise<void>;
  "tool.execute.after"?: (input: {...}, output: {...}) => Promise<void>;
  "experimental.chat.messages.transform"?: (input: {}, output: { messages: {info:Message;parts:Part[]}[] }) => Promise<void>;
  "experimental.chat.system.transform"?: (input: {sessionID?:string;model:Model}, output: {system:string[]}) => Promise<void>;
  "experimental.provider.small_model"?: (input: {provider:ProviderV2}, output: {model?:ModelV2}) => Promise<void>;
  "experimental.session.compacting"?: (input: {sessionID:string}, output: {context:string[];prompt?:string}) => Promise<void>;
  "experimental.compaction.autocontinue"?: (input: {...}, output: {enabled:boolean}) => Promise<void>;
  "experimental.text.complete"?: (input: {sessionID:string;messageID:string;partID:string}, output: {text:string}) => Promise<void>;
  "tool.definition"?: (input: {toolID:string}, output: {description:string;parameters:any}) => Promise<void>;
}
```

Each hook category is detailed in §5 (intercept hooks), §6 (event bus), §7 (tool registration), §9 (compaction).

---

## 5. Intercept hooks (non-bus)

These are **called as interceptors** around a specific operation — they receive an `input` (context) and a mutable `output` you may modify. They are **not** `Event.type` values (see §14).

### `config`

```ts
config?: (input: Config) => Promise<void>
```

Called sequentially over collected hooks after loading; mutates the resolved config. `Config` is `Omit<SDKConfig,"plugin"> & { plugin?: Array<string|[string,PluginOptions]> }`.

### `"chat.message"`

```ts
"chat.message"?: (
  input: {
    sessionID: string;
    agent?: string;
    model?: { providerID: string; modelID: string };
    messageID?: string;
    variant?: string;
  },
  output: { message: UserMessage; parts: Part[] },
) => Promise<void>
```

Called when a new user message is received, before it is processed. Mutate `output.message`/`output.parts` to inject or alter context. Prefer this over polling `message.updated` when you need to affect the turn.

### `"chat.params"`

```ts
"chat.params"?: (
  input: { sessionID: string; agent: string; model: Model; provider: ProviderContext; message: UserMessage },
  output: {
    temperature: number;
    topP: number;
    topK: number;
    maxOutputTokens: number | undefined;
    options: Record<string, any>;
  },
) => Promise<void>
```

Modify parameters sent to the LLM. `ProviderContext = { source:"env"|"config"|"custom"|"api"; info:Provider; options:Record<string,any> }`.

### `"chat.headers"`

```ts
"chat.headers"?: (
  input: { sessionID: string; agent: string; model: Model; provider: ProviderContext; message: UserMessage },
  output: { headers: Record<string, string> },
) => Promise<void>
```

Add or override HTTP headers for the provider request.

### `"permission.ask"`

```ts
"permission.ask"?: (
  input: Permission,
  output: { status: "ask" | "deny" | "allow" },
) => Promise<void>
```

Intercepts a permission request. Set `output.status` to auto-decide; leave as `"ask"` to show the prompt. `Permission` shape:

```ts
type Permission = {
  id: string;
  type: string;
  pattern?: string | string[];
  sessionID: string;
  messageID: string;
  callID?: string;
  title: string;
  metadata: Record<string, unknown>;
  time: { created: number };
};
```

This is the **hook name**. The bus events for the same flow are `permission.updated` / `permission.replied` (root) — see §6 and §14.

### `"command.execute.before"`

```ts
"command.execute.before"?: (
  input: { command: string; sessionID: string; arguments: string },
  output: { parts: Part[] },
) => Promise<void>
```

Runs before a slash-command executes (e.g., `/commit`). Mutate `output.parts` to inject context.

### `"tool.execute.before"`

```ts
"tool.execute.before"?: (
  input: { tool: string; sessionID: string; callID: string },
  output: { args: any },
) => Promise<void>
```

Modify tool arguments before execution. Example from docs — block `.env` reads:

```ts
export const EnvProtection: Plugin = async () => ({
  "tool.execute.before": async (input, output) => {
    if (input.tool === "read" && (output.args.filePath as string)?.includes(".env")) {
      throw new Error("Do not read .env files");
    }
  },
});
```

### `"tool.execute.after"`

```ts
"tool.execute.after"?: (
  input: { tool: string; sessionID: string; callID: string; args: any },
  output: { title: string; output: string; metadata: any },
) => Promise<void>
```

Observe or rewrite a tool's result. `output.output` is the string the model will see.

### `"shell.env"`

```ts
"shell.env"?: (
  input: { cwd: string; sessionID?: string; callID?: string },
  output: { env: Record<string, string> },
) => Promise<void>
```

Inject environment variables into every shell execution (tool `bash` and user terminals):

```ts
export const InjectEnv: Plugin = async () => ({
  "shell.env": async (input, output) => {
    output.env.MY_API_KEY = "secret";
    output.env.PROJECT_ROOT = input.cwd;
  },
});
```

### `"experimental.chat.messages.transform"`

```ts
"experimental.chat.messages.transform"?: (
  input: Record<string, never>,
  output: { messages: { info: Message; parts: Part[] }[] },
) => Promise<void>
```

Transform the message history sent to the model.

### `"experimental.chat.system.transform"`

```ts
"experimental.chat.system.transform"?: (
  input: { sessionID?: string; model: Model },
  output: { system: string[] },
) => Promise<void>
```

Modify the system prompt fragments.

### `"experimental.provider.small_model"`

```ts
"experimental.provider.small_model"?: (
  input: { provider: ProviderV2 },
  output: { model?: ModelV2 },
) => Promise<void>
```

Select a small/fast model for a provider.

### `"experimental.text.complete"`

```ts
"experimental.text.complete"?: (
  input: { sessionID: string; messageID: string; partID: string },
  output: { text: string },
) => Promise<void>
```

Post-process a completed text part.

### `"tool.definition"`

```ts
"tool.definition"?: (
  input: { toolID: string },
  output: { description: string; parameters: any },
) => Promise<void>
```

Modify the tool description/JSON Schema sent to the LLM.

---

## 6. Event bus: `event` hook and `Event` union

### 6.1 Subscribing

All bus events flow through a single hook:

```ts
export const MyPlugin: Plugin = async () => ({
  event: async ({ event }) => {
    switch (event.type) {
      case "session.created":   /* ... */ break;
      case "message.updated":   /* ... */ break;
      case "session.idle":      /* ... */ break;
    }
  },
});

export const NotificationPlugin: Plugin = async ({ $ }) => ({
  event: async ({ event }) => {
    if (event.type === "session.idle") {
      await $`osascript -e 'display notification "Session completed!" with title "opencode"'`;
    }
  },
});
```

The runtime bridge (`EventV2Bridge.listen` in `packages/opencode/src/plugin/index.ts` and `event-v2-bridge.ts:19-62`) filters by `event.location.directory !== ctx.directory` before invoking `hook.event({ event: { id, type, properties } })`.

### 6.2 Root `Event` union (exactly 32 variants)

Source: `packages/sdk/js/src/gen/types.gen.ts:704-736` at `193de13a`. Each event is `{ type: discriminator; properties: payload }` (root variants carry no top-level `id`). `Record<string,unknown>` below abbreviates the source's string index signature. `MessageError` is an alias for the assistant/session error union (see §11).

| `type` | `properties` payload |
|---|---|
| `server.instance.disposed` | `{ directory: string }` |
| `installation.updated` | `{ version: string }` |
| `installation.update-available` | `{ version: string }` |
| `lsp.client.diagnostics` | `{ serverID: string; path: string }` |
| `lsp.updated` | `Record<string, unknown>` |
| `message.updated` | `{ info: Message }` |
| `message.removed` | `{ sessionID: string; messageID: string }` |
| `message.part.updated` | `{ part: Part; delta?: string }` |
| `message.part.removed` | `{ sessionID: string; messageID: string; partID: string }` |
| `permission.updated` | `Permission` (directly — not `{ permission: Permission }`) |
| `permission.replied` | `{ sessionID: string; permissionID: string; response: string }` |
| `session.status` | `{ sessionID: string; status: SessionStatus }` |
| `session.idle` | `{ sessionID: string }` |
| `session.compacted` | `{ sessionID: string }` |
| `file.edited` | `{ file: string }` |
| `todo.updated` | `{ sessionID: string; todos: Todo[] }` |
| `command.executed` | `{ name: string; sessionID: string; arguments: string; messageID: string }` |
| `session.created` | `{ info: Session }` |
| `session.updated` | `{ info: Session }` |
| `session.deleted` | `{ info: Session }` |
| `session.diff` | `{ sessionID: string; diff: FileDiff[] }` |
| `session.error` | `{ sessionID?: string; error?: MessageError }` |
| `file.watcher.updated` | `{ file: string; event: "add"\|"change"\|"unlink" }` |
| `vcs.branch.updated` | `{ branch?: string }` |
| `tui.prompt.append` | `{ text: string }` |
| `tui.command.execute` | `{ command: TuiCommand }` |
| `tui.toast.show` | `{ title?: string; message: string; variant:"info"\|"success"\|"warning"\|"error"; duration?: number }` (duration in ms) |
| `pty.created` | `{ info: Pty }` |
| `pty.updated` | `{ info: Pty }` |
| `pty.exited` | `{ id: string; exitCode: number }` |
| `pty.deleted` | `{ id: string }` |
| `server.connected` | `Record<string, unknown>` |

Auxiliary types:

```ts
type TuiCommand =
  | "session.list" | "session.new" | "session.share" | "session.interrupt"
  | "session.compact" | "session.page.up" | "session.page.down"
  | "session.half.page.up" | "session.half.page.down"
  | "session.first" | "session.last"
  | "prompt.clear" | "prompt.submit" | "agent.cycle"
  | string; // arbitrary strings permitted

type Pty = {
  id: string; title: string; command: string; args: string[];
  cwd: string; status: "running" | "exited"; pid: number;
};

type FileDiff = {
  file: string; before: string; after: string;
  additions: number; deletions: number;
};

type GlobalEvent = { directory: string; payload: Event }; // SSE /global/event wrapper

type SessionStatus =
  | { type: "idle" }
  | { type: "retry"; attempt: number; message: string; next: number }
  | { type: "busy" };

type Session = {
  id: string; projectID: string; directory: string; parentID?: string;
  summary?: { additions: number; deletions: number; files: number; diffs?: FileDiff[] };
  share?: { url: string };
  title: string; version: string;
  time: { created: number; updated: number; compacting?: number };
  revert?: { messageID: string; partID?: string; snapshot?: string; diff?: string };
};

type Todo = { content: string; status: string; priority: string; id: string };
// status docs: pending | in_progress | completed | cancelled (still typed as string)
// priority docs: high | medium | low (still typed as string)
```

See also `Message`/`Part` in §11 and `Permission` in §5.

---

## 7. The `tool` helper and `ToolContext`

### 7.1 Defining a custom tool

From `packages/plugin/src/tool.ts:1-45`:

```ts
import { tool } from "@opencode-ai/plugin";

export const CustomToolsPlugin: Plugin = async () => ({
  tool: {
    mytool: tool({
      description: "This is a custom tool",
      args: {
        foo: tool.schema.string(),
        count: tool.schema.number().optional(),
      },
      async execute(args, context) {
        const { directory, worktree } = context;
        return `Hello ${args.foo} from ${directory} (worktree: ${worktree})`;
      },
    }),
  },
});
```

- `tool.schema` is the `zod` export (`tool.schema = z`) — use any Zod builder.
- `args` is a `ZodRawShape`; `execute` receives `z.infer<z.ZodObject<Args>>`.
- Return `string` or `{ title?, output, metadata?, attachments? }`.
- Plugin tools with the same name as a built-in **take precedence**.
- Tool `description`, `args`, and `execute` are all required.

### 7.2 `ToolContext`

```ts
type ToolContext = {
  sessionID: string;
  messageID: string;
  agent: string;
  directory: string;   // prefer over process.cwd()
  worktree: string;
  abort: AbortSignal;
  metadata(input: { title?: string; metadata?: Record<string, any> }): void;
  ask(input: AskInput): Promise<void>;
};

type AskInput = {
  permission: string;
  patterns: string[];
  always: string[];
  metadata: Record<string, any>;
};

type ToolAttachment = { type: "file"; mime: string; url: string; filename?: string };
type ToolResult = string | { title?: string; output: string; metadata?: Record<string,any>; attachments?: ToolAttachment[] };
```

---

## 8. Logging

Use `client.app.log()` — not `console.log` — for structured logs (visible in `opencode` logs):

```ts
export const MyPlugin: Plugin = async ({ client }) => {
  await client.app.log({
    body: {
      service: "my-plugin",
      level: "info",           // "debug" | "info" | "warn" | "error"
      message: "Plugin initialized",
      extra: { foo: "bar" },
    },
  });
  return {};
};
```

Signature from SDK: `client.app.log({ body: { service, level, message, extra? } }) → boolean`. Also available: `client.app.agents() → Agent[]`.

---

## 9. Compaction hooks

### 9.1 `experimental.session.compacting`

Fires **before** the LLM generates a continuation summary. Two modes, mutually exclusive:

```ts
// Append context — default prompt is kept, your strings are appended
export const CompactionPlugin: Plugin = async () => ({
  "experimental.session.compacting": async (input, output) => {
    output.context.push(`## Custom Context
Include any state that should persist across compaction:
- Current task status
- Important decisions made
- Files being actively worked on`);
  },
});

// Replace prompt entirely — output.context is ignored when output.prompt is set
export const CustomCompaction: Plugin = async () => ({
  "experimental.session.compacting": async (input, output) => {
    output.prompt = `You are generating a continuation prompt for a multi-agent swarm session.
Summarize:
1. The current task and its status
2. Which files are being modified and by whom
3. Any blockers or dependencies between agents
4. The next steps to complete the work`;
  },
});
```

Types:

```ts
"experimental.session.compacting"?: (
  input: { sessionID: string },
  output: { context: string[]; prompt?: string },
) => Promise<void>
```

### 9.2 `experimental.compaction.autocontinue`

Fires **after** compaction succeeds, before a synthetic user "continue" turn is added:

```ts
"experimental.compaction.autocontinue"?: (
  input: {
    sessionID: string; agent: string; model: Model;
    provider: ProviderContext; message: UserMessage; overflow: boolean;
  },
  output: { enabled: boolean }, // defaults true; set false to skip the turn
) => Promise<void>
```

Also available: `experimental.text.complete`, `experimental.chat.messages.transform`, `experimental.chat.system.transform` (see §5).

---

## 10. Sources and retrieval date

| Source | URL / path | Retrieved |
|---|---|---|
| Plugin docs | <https://opencode.ai/docs/plugins/> | 2026-09-11 |
| SDK docs | <https://opencode.ai/docs/sdk/> | 2026-09-11 |
| Plugin types | `anomalyco/opencode@193de13a/packages/plugin/src/index.ts`, `packages/plugin/src/tool.ts` | 2026-09-11 (pinned commit `193de13a88d62a6409c6d385831180f1def527dc`) |
| SDK root types | `packages/sdk/js/src/gen/types.gen.ts`, `packages/sdk/js/src/gen/sdk.gen.ts` | 2026-09-11 (same pin) |
| Runtime plugin lifecycle | `packages/opencode/src/plugin/index.ts`, `event-v2-bridge.ts`, `effect/instance-state.ts` | 2026-09-11 (same pin) |
| Runtime usage/cost | `packages/opencode/src/session/session.ts:338-404`, `processor.ts:452-470`, `projector.ts:88-109` | 2026-09-11 (same pin) |

> Pin: `193de13a88d62a6409c6d385831180f1def527dc` (`dev` branch HEAD on retrieval date). Verify currency before release — `dev` moves daily.

---

## 11. Reading active model, tokens, and cost (session stats)

This section is normative for the Discord Rich Presence **session stats** feature. All names are real exports from `@opencode-ai/sdk` (root) or `@opencode-ai/plugin`; no invented APIs.

### 11.1 Data model

```ts
// AssistantMessage — only assistant messages carry usage (narrow via role)
type AssistantMessage = {
  id: string;
  sessionID: string;
  role: "assistant";
  time: { created: number; completed?: number };
  error?: MessageError;
  parentID: string;
  modelID: string;      // e.g. "claude-3-5-sonnet-20241022"
  providerID: string;   // e.g. "anthropic"
  mode: string;
  path: { cwd: string; root: string };
  summary?: boolean;
  cost: number;         // accumulated USD for this message (see §11.3)
  tokens: Tokens;       // snapshot of last step's tokens (see §11.3)
  finish?: string;
};

type Tokens = {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
  // NOTE: no `total` in root SDK — sum it yourself if needed
};

type StepFinishPart = {
  type: "step-finish";
  reason: string;
  snapshot?: string;
  cost: number;         // cost of THIS step
  tokens: Tokens;       // tokens of THIS step
} & PartIdentity;

// Session summary (DB-persisted aggregate — available via client SDK, not via Message directly)
type SessionAggregates = {
  cost: number;
  tokens: Tokens;       // sum of step-finish tokens across the session
};
```

**Key facts verified against runtime:**

- `AssistantMessage.cost` **accumulates** across steps in the same message (`+=` per `step-finish` in `processor.ts:452-470`).
- `AssistantMessage.tokens` is a **snapshot replace** — it is overwritten with the last step's `Tokens`, not summed.
- `StepFinishPart` carries the **per-step** `cost`/`tokens`.
- The `Session` table aggregates `cost`/`tokens` as the **sum** of all `step-finish` parts (via `projector.ts:applyUsage`). At the SDK type level, `Session` itself does not expose `cost`/`tokens` in root types; fetch aggregates via `client.session.*` or by summing observed `step-finish` parts.
- Currency is **USD** (cost per 1M tokens, computed with `Decimal` for precision; no currency literal on the wire — `number` only).
- `UserMessage` has `model: { providerID, modelID }`, `agent`, `time.created` — but **no** `cost`/`tokens`.

### 11.2 Where to read each stat

| Stat | Best source | When it updates |
|---|---|---|
| **Active model** | `AssistantMessage.providerID` + `AssistantMessage.modelID`; or `UserMessage.model` for the pending turn; or `client.config.providers()` | `message.updated` (assistant) or `chat.message` intercept |
| **Tokens (current turn)** | `AssistantMessage.tokens` on `message.updated` | Each `step-finish` within a turn |
| **Tokens (per step)** | `StepFinishPart.tokens` on `message.part.updated` where `part.type==="step-finish"` | Each step |
| **Cost (current turn)** | `AssistantMessage.cost` | Each `step-finish` |
| **Cost (per step)** | `StepFinishPart.cost` | Each step |
| **Session aggregates** | `client.session.messages({ path:{id:sessionID} })` then sum, or `client.session.status()` + local aggregation | Poll or on `message.updated` |

> **v2 drift (informational):** the v2 SDK's `AssistantMessage` adds `agent`, `tokens.total`, `variant`, and `Session` adds `cost`/`tokens`/`model`/`agent` directly. Do **not** use those fields against the root-typed plugin client — they will be `undefined` at runtime under the current pin. See §14.

### 11.3 Accumulation semantics (important for presence)

Do **not** sum `AssistantMessage.cost` across messages if you also sum `StepFinishPart.cost` — they overlap. Two correct strategies:

- **Message-level stats (simpler):** track latest `AssistantMessage.cost`/`tokens` per `sessionID`.
- **Session-level stats (precise):** sum `StepFinishPart.cost`/`tokens` across all messages in the session.

The runtime's own session aggregate does the latter (`projector.ts:applyUsage` increments on each `step-finish`).

### 11.4 Concrete TypeScript snippets

#### Track model + cost + tokens from the event bus

```ts
import type { Plugin } from "@opencode-ai/plugin";
import type { Message, Part } from "@opencode-ai/sdk";

type SessionStats = {
  sessionID: string;
  providerID: string;
  modelID: string;
  cost: number;
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
  updatedAt: number;
};

export const PresenceStatsPlugin: Plugin = async () => {
  const stats = new Map<string, SessionStats>();

  function upsertFromMessage(msg: Message) {
    if (msg.role !== "assistant") return;
    stats.set(msg.sessionID, {
      sessionID: msg.sessionID,
      providerID: msg.providerID,
      modelID: msg.modelID,
      cost: msg.cost,
      tokens: msg.tokens,
      updatedAt: msg.time.completed ?? msg.time.created,
    });
  }

  return {
    event: async ({ event }) => {
      // Assistant message completed/updated — primary source for presence stats
      if (event.type === "message.updated") {
        upsertFromMessage(event.properties.info);
      }

      // Per-step granularity (optional — use for step-level presence details)
      if (event.type === "message.part.updated") {
        const part: Part = event.properties.part;
        if (part.type === "step-finish") {
          // part.cost / part.tokens are the step's contribution
          // Useful for incremental session totals without re-fetching
          const existing = stats.get(part.sessionID);
          if (existing) {
            // If you maintain a session total, sum here; otherwise ignore
            // existing.cost += part.cost; // only if you track session aggregates separately
          }
        }
      }

      // Presence lifecycle: clear on delete
      if (event.type === "session.deleted") {
        stats.delete(event.properties.info.id);
      }
    },
  };
};
```

#### Fetch current stats via the SDK client (poll or on demand)

```ts
import type { Plugin } from "@opencode-ai/plugin";

export const PresenceFetchPlugin: Plugin = async ({ client }) => ({
  event: async ({ event }) => {
    if (event.type !== "session.idle") return;
    const sessionID = event.properties.sessionID;

    // All messages + parts for the session (root SDK: { path:{id}, query? })
    const res = await client.session.messages({ path: { id: sessionID } });
    if (!res.data) return;

    let sessionCost = 0;
    let sessionTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
    let lastModel: { providerID: string; modelID: string } | undefined;

    for (const { info, parts } of res.data) {
      if (info.role === "assistant") {
        lastModel = { providerID: info.providerID, modelID: info.modelID };
        // Option A: use message-level cost (already accumulated)
        // sessionCost += info.cost;
        // Option B: sum step-finish parts (more precise for tokens — pick ONE)
      }
      for (const part of parts) {
        if (part.type === "step-finish") {
          sessionCost += part.cost;
          sessionTokens.input += part.tokens.input;
          sessionTokens.output += part.tokens.output;
          sessionTokens.reasoning += part.tokens.reasoning;
          sessionTokens.cache.read += part.tokens.cache.read;
          sessionTokens.cache.write += part.tokens.cache.write;
        }
      }
    }

    await client.app.log({
      body: {
        service: "presence",
        level: "info",
        message: "Session stats",
        extra: { sessionID, model: lastModel, cost: sessionCost, tokens: sessionTokens },
      },
    });
  },
});
```

#### Read model/usage before the turn starts (intercept)

```ts
import type { Plugin } from "@opencode-ai/plugin";

export const PresencePreflightPlugin: Plugin = async () => ({
  "chat.message": async (input, _output) => {
    // input.model is the requested model for this turn (if specified)
    if (input.model) {
      // input.model.providerID / input.model.modelID
    }
  },
  "chat.params": async (input, _output) => {
    // input.model / input.provider / input.message are available here
    // input.model.id, input.model.cost, input.model.limit, etc.
  },
});
```

#### Resolve available models (for display names)

```ts
import type { Plugin } from "@opencode-ai/plugin";

export const PresenceModelsPlugin: Plugin = async ({ client }) => {
  const res = await client.config.providers();
  if (res.data) {
    for (const provider of res.data.providers) {
      for (const [modelId, model] of Object.entries(provider.models)) {
        // model.name (display), model.cost { input, output, cache:{read,write} }
        void modelId;
      }
    }
  }
  return {};
};
```

#### Streaming deltas (optional — high frequency)

```ts
import type { Plugin } from "@opencode-ai/plugin";

export const PresenceStreamingPlugin: Plugin = async () => ({
  event: async ({ event }) => {
    if (event.type === "message.part.updated" && event.properties.delta) {
      // event.properties.delta is the incremental text delta for this part
      // Throttle presence updates — do not update Discord on every delta
    }
  },
});
```

---

## 12. Events and hooks relevant to Rich Presence

Use this table to map OpenCode signals to Discord Rich Presence fields (`details`, `state`, `largeImageKey/Text`, `smallImageKey/Text`, `startTimestamp`, `buttons`).

| OpenCode event / hook | Presence field(s) it can drive | Notes |
|---|---|---|
| `session.created` (`{ info: Session }`) | `startTimestamp`, `details` ("Starting session"), `largeImageText` (project/directory) | Initialize presence. `Session.time.created` is the canonical start. |
| `session.updated` | `details` (title change), `state` | Title edits; rarely needed if you track `message.updated`. |
| `session.deleted` | Clear presence | Remove session from local stats map. |
| `session.idle` (`{ sessionID }`) | `details` ("Idle" / "Ready"), `smallImageKey` (idle icon) | Session finished responding — best trigger to **finalize stats** and set idle state. |
| `session.status` (`{ status: SessionStatus }`) | `state` ("Thinking…", "Retrying…"), `smallImageKey` | `busy` → spinner, `retry` → attempt/message, `idle` → checkmark. |
| `session.error` (`{ error?: MessageError }`) | `state` ("Error"), `smallImageKey` (error icon) | Surface `ProviderAuthError` / `ApiError` distinctly. |
| `message.updated` (`{ info: Message }`) | `details`, `state`, **model/cost/tokens** | **Primary stats source** — update on every assistant message. Narrow `role==="assistant"` before reading `cost`/`tokens`/`providerID`/`modelID`. |
| `message.part.updated` (`{ part, delta? }`) | `state` (streaming), per-step **cost/tokens** (`step-finish`) | High frequency — throttle Discord updates. `step-finish` parts carry per-step usage. |
| `todo.updated` (`{ todos: Todo[] }`) | `state` ("2/5 tasks"), `details` (current todo) | Drive progress text from `todos.filter(t=>t.status==="in_progress")`. |
| `tool.execute.before` (hook) | `state` ("Running bash…"), `smallImageKey` (tool icon) | Intercept — e.g., show `Writing src/foo.ts…`. |
| `tool.execute.after` (hook) | `state` (clear tool status) | Clear transient tool state. |
| `permission.ask` (hook) + `permission.updated`/`permission.replied` (events) | `state` ("Waiting for approval…") | Show permission gate; clear on `replied`. |
| `file.edited` / `file.watcher.updated` | `details` ("Editing README.md") | File activity indicator — debounce. |
| `command.executed` | `details` ("Ran /commit") | Slash-command activity. |
| `server.connected` | Presence **connect** | Server (re)connected — (re)initialize Discord IPC. |
| `experimental.session.compacting` (hook) | `state` ("Compacting…") | Optional: show compaction progress; inject presence-relevant context. |
| `shell.env` (hook) | — | Not a presence signal — use to inject `DISCORD_*` env if needed. |

**Recommended minimal presence FSM:**

```
session.created → "Working" (startTimestamp = now)
  message.updated (assistant, busy) → "Thinking with <model> — $<cost>"
  tool.execute.before/after → "Running <tool>"
  todo.updated → "<done>/<total> — <current task>"
  permission.* → "Waiting for approval"
  session.idle → "Idle — $<total> · <tokens> tokens"
  session.error → "Error — <error.name>"
  session.deleted / dispose → clear
```

Update Discord at most every 2–5 s (throttle `message.part.updated` deltas); Discord rate-limits presence updates.

---

## 13. Minimal Rich Presence skeleton

Illustrative — uses real plugin names; Discord IPC is out of scope (see `docs/DISCORD-RICH-PRESENCE.md` for transport).

```ts
import type { Plugin } from "@opencode-ai/plugin";
import type { Message } from "@opencode-ai/sdk";

export const DiscordPresence: Plugin = async ({ client, directory, worktree }) => {
  let currentSessionID: string | undefined;

  function formatCosts(m: Message): string | undefined {
    if (m.role !== "assistant") return undefined;
    return `$${m.cost.toFixed(4)} · ${m.tokens.input + m.tokens.output} tokens`;
  }

  async function setPresence(details: string, state?: string) {
    // Replace with your Discord IPC `SET_ACTIVITY` call
    await client.app.log({ body: { service: "presence", level: "debug", message: details, extra: { state, directory, worktree } } });
  }

  return {
    event: async ({ event }) => {
      switch (event.type) {
        case "session.created":
          currentSessionID = event.properties.info.id;
          await setPresence("Starting session", event.properties.info.title);
          break;
        case "session.idle":
          if (event.properties.sessionID === currentSessionID) {
            await setPresence("Idle — ready");
          }
          break;
        case "message.updated": {
          const info = event.properties.info;
          if (info.sessionID !== currentSessionID) break;
          const costLine = formatCosts(info);
          await setPresence(`Working with ${info.role === "assistant" ? info.modelID : "…"}`, costLine);
          break;
        }
        case "session.error":
          await setPresence("Error", event.properties.error?.name ?? "UnknownError");
          break;
        case "todo.updated": {
          const pending = event.properties.todos.filter(t => t.status !== "completed").length;
          const total = event.properties.todos.length;
          await setPresence("Working", `${total - pending}/${total} tasks`);
          break;
        }
      }
    },
    "tool.execute.before": async (input) => {
      await setPresence("Running tool", input.tool);
    },
    "tool.execute.after": async () => {
      // clear transient tool state on next message.updated / session.idle
    },
    dispose: async () => {
      // disconnect Discord IPC
    },
  };
};
```

---

## 14. Versioning and drift notes

### Root SDK vs v2 SDK

- The plugin's `Event`, `Message`, `Part`, `Permission` types are from **`@opencode-ai/sdk` (root)**. The package also ships `@opencode-ai/sdk/v2` with a different `Event` union (has `id` per event, `permission.asked`, `message.part.delta`, etc.) — **do not** use v2 types with the plugin `event` hook.
- `createOpencodeClient` used by `PluginInput.client` is the **root** client. Its methods use `{ path, query, body }` style (e.g., `client.session.messages({ path:{id}, query:{directory} })`). The v2 client uses flattened params (`session.messages({ sessionID, directory })`) — different call shape.

### Documentation vs types (known drift at pin)

| Docs label | Type reality | Guidance |
|---|---|---|
| `permission.asked` / `permission.replied` (docs Events list) | Root events are `permission.updated` (`Permission`) and `permission.replied` (`{ sessionID, permissionID, response }`); hook is `"permission.ask"` | Filter docs events through the 32-variant table in §6. |
| `shell.env`, `tool.execute.before/after` listed as events | These are **hook keys**, not `Event.type` values | Subscribe via `Hooks["shell.env"]`, not `event`. |
| `installation.update-available`, `server.instance.disposed`, `vcs.branch.updated`, PTY events omitted from docs list | Present in the 32-variant union | Implement if needed — they fire. |
| `message.part.updated` `delta` | Root: `properties: { part: Part; delta?: string }`. v2 splits into `message.part.updated` + `message.part.delta` with `sessionID`/`partID`/`field` | Use root shape in plugins. |

If an event you need is not in §6, treat its absence as intentional for this pin and file a follow-up after re-pinning.

---

## 15. Checklist for presence authors

- [ ] Narrow `Message` by `role` before reading `cost`/`tokens`/`providerID`/`modelID`.
- [ ] Do not sum `AssistantMessage.cost` and `StepFinishPart.cost` together — pick one accumulation strategy (§11.3).
- [ ] Throttle Discord updates (≤ 0.5 Hz); debounce `file.watcher.updated` and `message.part.updated` deltas.
- [ ] Handle `session.error` and permission gates explicitly — they are the most visible failure modes.
- [ ] Re-pin `anomalyco/opencode` before release and re-verify §6 and §11 against the new `193de13a` successor.
- [ ] Validate markdown and links before shipping (see Quality Gates in repo).

---

*End of reference. For Discord transport details, see `docs/DISCORD-RICH-PRESENCE.md` (DISC-003). For architecture, see `ARCHITECTURE.md`.*
