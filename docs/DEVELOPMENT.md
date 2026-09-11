# Development — opencode Discord Rich Presence

> Companion to [`ARCHITECTURE.md`](./ARCHITECTURE.md), [`CONFIGURATION.md`](./CONFIGURATION.md), and [`OPENCODE-PLUGIN-API.md`](./OPENCODE-PLUGIN-API.md) (pin `193de13a`).

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Repo layout](#2-repo-layout)
3. [Scripts](#3-scripts)
4. [Local plugin dev harness](#4-local-plugin-dev-harness)
5. [Debugging](#5-debugging)
6. [Publishing to npm](#6-publishing-to-npm)
7. [Contribution flow](#7-contribution-flow)

---

## 1. Prerequisites

| Requirement | Version / notes |
|---|---|
| **Bun** | `>= 1.1.0` — runtime and package manager. Install from <https://bun.sh>. `package.json` declares `engines.bun >= 1.1.0`. |
| **Node** | `>= 20` — `engines.node >= 20`. The plugin ships as TypeScript source (`src/index.ts`); opencode loads it via Bun. |
| **Discord desktop client** | Must be running for presence to appear. The browser/PTB build does not expose the local IPC socket. |
| **Discord application** | Optional. The plugin works with zero config (bundled `DEFAULT_CLIENT_ID`). For custom name/icons, create an app at <https://discord.com/developers/applications> → copy the **Application ID** (`/^\d{17,20}$/`) → upload Art Assets → set `applicationId`. See `CONFIGURATION.md` §5. |
| **opencode** | Recent `dev` build — plugin API verified against `anomalyco/opencode@193de13a`. See `OPENCODE-PLUGIN-API.md` §2 for load rules. |
| **TypeScript** | `^5.9.3` (dev dep) — strict mode (`noUncheckedIndexedAccess`, `noUnusedLocals`, etc. in `tsconfig.json`). |
| **Biome** | `^2.5.13` (dev dep) — formatter + linter (`biome.json` — 2-space, 100 cols, `recommended` preset). |

Verify:

```bash
bun --version   # >= 1.1.0
node --version  # >= 20
bun run typecheck
```

---

## 2. Repo layout

Real tree on disk (see `src/**`, `docs/**`; `examples/**` is planned — not yet present):

```
opencode-discord-rich-presence/
├── src/
│   ├── types.ts                     # PluginDeps, SessionStats, PresenceModel, SessionStateKind
│   ├── config/
│   │   ├── schema.ts                # 45-option zod schema + defaults (ARCHITECTURE.md §5.1)
│   │   └── loader.ts                # 4-tier precedence: global < project < env < runtime
│   ├── core/
│   │   ├── state-machine.ts         # 6-state FSM (ARCHITECTURE.md §4), TRANSITIONS table
│   │   ├── session-tracker.ts       # Per-session SessionStats + active-session pick
│   │   ├── presence-model.ts        # PresenceModel builder, templates, telemetry
│   │   ├── presence-scheduler.ts    # debounce/throttle/dedupe + nonce generation
│   │   └── tool-activity-resolver.ts # builtin/custom/MCP → ToolActivity
│   ├── discord/
│   │   ├── ipc.ts                   # IPC path resolution + probe (win32 pipe / Unix socket)
│   │   ├── transport.ts             # Transport iface + per-connection FrameDecoder
│   │   ├── presence.ts              # Presence model → Activity builder
│   │   ├── reconnect.ts             # Backoff (base 1 s, cap 30 s, jitter 0.2, max 10)
│   │   └── *.test.ts                # ipc.test.ts, presence.test.ts, reconnect*.test.ts, transport*.test.ts
│   └── utils/
│       └── logger.ts                # Logger iface → client.app.log adapter, secret redaction
├── docs/
│   ├── ARCHITECTURE.md              # Module map, data flow, FSM, config schema, transport
│   ├── OPENCODE-PLUGIN-API.md       # Authoritative plugin API (pin 193de13a, 32 events)
│   ├── DISCORD-RPC.md               # Wire format, opcodes, IPC paths, rate limits
│   ├── CONFIGURATION.md             # 45-option reference + precedence + examples
│   ├── EXTENDING.md                 # Adding fields/events/options, swapping transport
│   ├── COMMUNITY-ANALYSIS.md        # Gap matrix vs 3 community plugins
│   ├── ROADMAP.md                   # MVP → v1 → v2 → v3 (6 target features)
│   ├── PRESENCE-DESIGN.md           # Presence vision: resolver, MCP, phrases, telemetry
│   ├── DEVELOPMENT.md               # This file
│   └── _research/
│       └── community-plugins.md     # Raw research notes
├── package.json                     # type: module, exports -> ./dist/index.js
├── tsconfig.json                    # ESNext, bundler, strict, noEmit (typecheck)
├── tsconfig.build.json              # extends base, emits dist/ + declarations
├── biome.json                       # formatter + linter config
├── LICENSE                          # MIT
├── CHANGELOG.md                     # Keep a Changelog
├── bun.lock
└── dist/                            # build output (gitignored, shipped via files[])
```

Still planned per `ARCHITECTURE.md` §2 (not yet present):

- `examples/` — minimal `opencode.json` + `.discord-presence.json` samples

Do not import across `core ↔ discord` except through the boundary interfaces in `types.ts` (`ARCHITECTURE.md` §2.1).

Constraints: every `src/**` file ≤ 500 lines (`wc -l`), no `any`, every exported symbol has a DocBlock (`coding-standards.md` §6).

---

## 3. Scripts

Exact scripts from `package.json` — document only these:

| Script | Command | What it does |
|---|---|---|
| `build` | `tsc -p tsconfig.build.json` | Emit ESM JavaScript + `.d.ts` declarations + source maps to `dist/` (`noEmit: false`, `declaration`, `declarationMap`, `sourceMap`; `**/*.test.ts` excluded). |
| `typecheck` | `tsc --noEmit` | Strict type-check without emit. No errors allowed. |
| `lint` | `biome check .` | Lint + import organization + `noExplicitAny` / `noUnusedImports` checks. Exit non-zero on violations. |
| `format` | `biome format --write .` | Auto-format in place (2-space, 100 cols). |
| `test` | `bun test` | Run Bun's test runner over `**/*.test.ts`. |

Run before every push:

```bash
bun install
bun run typecheck
bun run lint
bun run format
bun test
```

`bun run build` uses `tsconfig.build.json` and emits `dist/`; `typecheck` uses `tsconfig.json` (`noEmit: true`) and also checks `*.test.ts`.

---

## 4. Local plugin dev harness

Opencode loads plugins from four sources in order (`OPENCODE-PLUGIN-API.md` §2.1–2.2):

1. `~/.config/opencode/opencode.json` → `plugin: [...]` (npm packages)
2. `opencode.json` → `plugin: [...]` (npm packages)
3. `~/.config/opencode/plugins/*.{js,ts}` (local files)
4. `.opencode/plugins/*.{js,ts}` (local files)

For local iteration, use the plugin directory — no npm publish needed.

### 4.1 Project-scoped harness (recommended for development)

```bash
# from the repo root
mkdir -p .opencode/plugins

# option 1: copy/symlink the entry (once plugin.ts + index.ts exist)
ln -sf ../../src/index.ts .opencode/plugins/discord-presence.ts

# option 2: point at the source directly via opencode.json
cat > opencode.json <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["@vheins/opencode-discord-rich-presence", { "debug": true }]
  ]
}
JSON
```

Then start opencode from this directory:

```bash
opencode
# or: bunx opencode
```

The plugin's `debug: true` routes every state/transport transition through `client.app.log` at `level: "debug"`.

### 4.2 Global harness (test across projects)

```bash
mkdir -p ~/.config/opencode/plugins
cp src/index.ts ~/.config/opencode/plugins/discord-presence.ts
# restart opencode — any project now shows presence
```

### 4.3 If the plugin imports npm packages

Add a `package.json` inside the config directory so opencode runs `bun install` before loading local plugins:

```bash
cat > .opencode/package.json <<'JSON'
{
  "dependencies": { "zod": "^4.1.8" }
}
JSON
# opencode runs `bun install` inside .opencode/ at startup automatically
```

### 4.4 Iterative edits

- Edit `src/**` → save → restart opencode (plugins are loaded once at startup; there is no hot reload).
- Keep `bun run typecheck` and `bun run lint` green — opencode will still load a type-broken plugin at runtime, but Discord frames may be malformed.
- Use `debug: true` + `client.app.log` output to verify FSM transitions without attaching a debugger.

---

## 5. Debugging

### 5.1 Logging

All plugin logs go through `src/utils/logger.ts` → `client.app.log({ body: { service, level, message, extra } })` (`OPENCODE-PLUGIN-API.md` §8). Levels: `debug | info | warn | error`.

- `debug` — every FSM transition, `FrameDecoder` push, `connect`/`ready`/`disconnected`, debounce/throttle decisions. Only when `debug: true`.
- `info` — lifecycle: `Plugin initialized`, `connect ok`, `clear()`.
- `warn` — invalid config subtree (zod fallback), invalid `applicationId`, invalid activity dropped (`assets.validate`), `handshakeTimeoutMs` hit.
- `error` — socket `error`, `CLOSE` frame, unexpected `JSON.parse` failure.

Logs are fire-and-forget (`catch` and ignore) — logging never crashes the plugin. View them in opencode's log output (wherever `client.app.log` is surfaced; typically the opencode server log).

```bash
# verbose run
OPENCODE_DISCORD_DEBUG=1 opencode
# or runtime:
# opencode.json → ["@vheins/opencode-discord-rich-presence", { "debug": true }]
```

### 5.2 Common failures

| Symptom | Cause | Fix |
|---|---|---|
| Presence never appears | Discord not running | Start the Discord desktop client. The plugin stays `disconnected` and calls `scheduleReconnect()` with backoff (`reconnect.*` in `ARCHITECTURE.md` §6.2); presence reappears when Discord restarts — no opencode restart needed. |
| `warn: invalid applicationId` | `applicationId` not `/^\d{17,20}$/` (e.g., pasted URL or empty with typo) | Copy the numeric ID from <https://discord.com/developers/applications> → **General Information → Application ID**. Or leave `""` to use the bundled `DEFAULT_CLIENT_ID`. |
| `disconnected` / `ENOENT` on connect | IPC socket not found | Discord creates `discord-ipc-0` (up to `9`) under `\\?\pipe\` (Windows) or `$XDG_RUNTIME_DIR`/`$TMPDIR`/`/tmp` (Unix). Check that Discord owns the socket: `ls /tmp/discord-ipc-*` or `ls $XDG_RUNTIME_DIR/discord-ipc-*`. Scanning `0..9` is automatic (`src/discord/ipc.ts`, `DISCORD-RPC.md` §2). |
| `handshake timeout` / no `READY` | Discord slow to respond or `applicationId` rejected | Increase `reconnect.handshakeTimeoutMs` (default `10000 ms`; Khip01 uses `30000`). Check Application ID validity. |
| `warn: invalid activity` — update dropped | `largeImageKey` > 32, `buttons` > 2, non-`https` URL, invalid `type` | Set `assets.validate: true` (default) and fix the flagged field. Validate in `src/discord/presence.ts`. Caps: `details`/`state`/`large_text`/`small_text` ≤ 128 (`DISCORD-RPC.md` §4.2). |
| Stale presence after quit | Discord never expires presence | Expected — `dispose` sends `activity: null` best-effort; card clears on next overwrite or Discord restart (`ARCHITECTURE.md` §8). |
| Config change ignored | Higher precedence layer wins | Precedence is `global < project < env < runtime`. Arrays **replace** (so `buttons` from a higher layer wins entirely). Check `CONFIGURATION.md` §2. |
| Timers keep opencode alive | Timers not `unref()`'d | All outliving timers (`reconnect`, `idle.timeout`, `throttle`) must be `.unref()`'d per `ARCHITECTURE.md` §8 invariants. |

### 5.3 Quick diagnostics

```bash
# is Discord exposing the socket?
ls -la /tmp/discord-ipc-* 2>&1
ls -la "${XDG_RUNTIME_DIR:-/tmp}"/discord-ipc-* 2>&1
# Windows: check \\?\pipe\discord-ipc-* via PowerShell
#   [System.IO.Directory]::GetFiles("\\.\pipe\") | Select-String discord-ipc

# does the schema accept your config?
bun -e "import { validateConfig } from './src/config/schema.ts'; console.log(validateConfig(JSON.parse(await Bun.file('.discord-presence.json').text())))"

# verbose plugin logs
OPENCODE_DISCORD_DEBUG=1 opencode 2>&1 | grep -i presence
```

---

## 6. Publishing to npm

### 6.1 Pre-publish checks

```bash
bun run typecheck
bun run lint
bun test
bun run build            # emit dist/ (required before packing/publishing)
# ensure package.json fields are correct: name, version, exports, files, keywords
cat package.json
```

`package.json` ships `dist/` + `src/` + `README.md` + `LICENSE` + `CHANGELOG.md` (`files` array) and exposes `".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }` (`type: module`, `sideEffects: false`). Run `bun run build` first so `dist/` exists — opencode (via Bun) imports the compiled ESM entry; `src/` is included for source-level inspection.

Bump the version per `ROADMAP.md` §7 tags (`v0.1.0` MVP → `v1.0.0` v1 → `v1.1.0` v2 → `v1.2.0`/`v2.0.0` v3).

### 6.2 Publish

```bash
npm publish --access public
# or: bun publish
```

Verify the tarball before publishing:

```bash
npm pack --dry-run
# check output lists: dist/**, src/**, README.md, LICENSE, CHANGELOG.md, package.json
# (and not node_modules/, docs/, tests, or .opencode/)
```

### 6.3 Consuming via `opencode.json`

After publishing, users add the package to their opencode config:

```jsonc
// ~/.config/opencode/opencode.json  (global)  or  ./opencode.json  (project)
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@vheins/opencode-discord-rich-presence",
    // with options (optional — highest precedence):
    ["@vheins/opencode-discord-rich-presence", { "debug": false, "privacy": { "hideFilePaths": true } }]
  ]
}
```

On next `opencode` start, Bun installs the package into `~/.cache/opencode/node_modules/` and loads it. Duplicate `name@version` entries are deduplicated; a local file and an npm package with similar names are both loaded (`OPENCODE-PLUGIN-API.md` §2.2).

Pinning a version:

```jsonc
{ "plugin": ["@vheins/opencode-discord-rich-presence@1.1.0"] }
```

---

## 7. Contribution flow

1. **Branch** from `main`:
   ```bash
   git checkout -b feat/<short-name>
   # or: fix/<short-name>, docs/<short-name>
   ```
2. **Read the specs** before coding:
   - `docs/ARCHITECTURE.md` — module boundaries, FSM, transport invariants (authoritative)
   - `docs/OPENCODE-PLUGIN-API.md` — hook/event contracts (pin `193de13a`)
   - `docs/DISCORD-RPC.md` — wire format and caps
   - `docs/CONFIGURATION.md` — option precedence and validation
3. **Code** under the module map (`ARCHITECTURE.md` §2). Keep each file ≤ 500 lines, no `any`, DocBlock on every exported symbol.
4. **Validate locally**:
   ```bash
   bun install
   bun run typecheck
   bun run lint
   bun run format
   bun test
   ```
5. **Test the plugin** via the local harness (§4) — start opencode with `debug: true` and confirm presence appears/updates/clears.
6. **Commit** with conventional messages:
   ```bash
   git add <files>               # never `git add .` blindly
   git commit -m "feat(discord): add idle timeout handling"
   # or: fix(config): clamp idle.timeoutMs, docs: update DEVELOPMENT
   ```
7. **Open a PR** against `main`. Include: what changed, which `ARCHITECTURE.md` section it implements, and manual test evidence (log snippet or screenshot).

Do not commit `node_modules/`, `dist/`, `.env*`, or `bun.lock` changes unrelated to your diff (see `.gitignore`).

---

*Scripts: `package.json`. Types: `src/types.ts`. FSM: `src/core/state-machine.ts`. Transport: `src/core/presence-scheduler.ts` + `src/discord/transport.ts` + `src/discord/ipc.ts` + `src/discord/reconnect.ts`. Config: `src/config/schema.ts` + `src/config/loader.ts`.*
