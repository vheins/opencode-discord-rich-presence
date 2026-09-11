# Discord Rich Presence + Cross-Platform IPC Reference

> **Scope:** Authoritative reference for implementing Discord Rich Presence over local IPC in a Bun/TypeScript opencode plugin. Every claim in §1–§4 is traced to an official Discord doc or a library source permalink; anything that could not be verified is explicitly marked **Unverified**.
>
> **Retrieval date:** 2026-09-11 (UTC). Re-verify source URLs before shipping — Discord docs are living.

## Table of Contents

1. [How this document is verified](#1-how-this-document-is-verified)
2. [IPC transport — what actually exists](#2-ipc-transport--what-actually-exists)
3. [Wire protocol — framing, opcodes, handshake](#3-wire-protocol--framing-opcodes-handshake)
4. [SET_ACTIVITY and the activity object](#4-set_activity-and-the-activity-object)
5. [Assets — how `large_image` keys resolve](#5-assets--how-large_image-keys-resolve)
6. [Library comparison and recommendation](#6-library-comparison-and-recommendation)
7. [Reconnect state machine and rate limits](#7-reconnect-state-machine-and-rate-limits)
8. [Minimal implementation sketch (non-normative)](#8-minimal-implementation-sketch-non-normative)
9. [Sources](#9-sources)

---

## 1. How this document is verified

| Evidence class | What was read | Why it matters |
|---|---|---|
| **Official RPC doc (current)** | `https://docs.discord.com/developers/topics/rpc` — sections *RPC over IPC*, *Connecting to IPC*, *Opcodes*, *Payload Structure*, *SET_ACTIVITY* (retrieved via `webfetch`; full body cached at `~/.local/share/opencode/tool-output/tool_08f35b962001sM91q7frVmeP0Q`) | Canonical IPC path format, opcode table, handshake payload, `SET_ACTIVITY` arg shape |
| **Official Gateway activity schema** | `https://docs.discord.com/developers/events/gateway-events#activity-object` | Canonical `Activity` object fields (`details`, `state`, `timestamps`, `assets`, `buttons`, `party`, `secrets`, `instance`, `flags`, `buttons` constraints) |
| **Official Social SDK — Setting Rich Presence** | `https://docs.discord.com/developers/discord-social-sdk/development-guides/setting-rich-presence` | Uploaded vs external assets, 1024×1024 recommendation, 300-asset cap, key lower-casing, timestamp semantics (seconds), button/URL examples |
| **Official C++ reference implementation** | `discord/discord-rpc` (`rpc_connection.h`, `connection_unix.cpp`, `connection_win.cpp`, `serialization.cpp`, `include/discord_rpc.h`) — historical but shows frame header, temp-path resolution, pipe scan, and `CLEAR` semantics | Frame header layout, `MaxRpcFrameSize`, env-var priority, scan range |
| **Published library source (JS)** | `discord-rpc@4.0.1` (`src/transports/ipc.js`, `src/client.js`, `src/util.js`) and `@xhayper/discord-rpc@1.3.4` (`dist/transport/IPC.js`, `dist/Client.js`, `dist/index.d.ts`) via `gh` + UNPKG | What real Node/Bun clients actually do: framing edge cases, reconnect gaps |

> **Reading the doc:** Bullets prefixed **Verified** map 1:1 to a row in §9. Bullets prefixed **Unverified** could not be confirmed in the docs read for this revision and must not be treated as spec.

---

## 2. IPC transport — what actually exists

### 2.1 Path format

**Verified — Official RPC doc, *IPC Path* table:**

| Platform | Path format | Resolution order |
|---|---|---|
| Windows | `\\?\pipe\discord-ipc-{n}` | `CreateFileW` on `\\?\pipe\discord-ipc-0` .. `\\?\pipe\discord-ipc-9`, incrementing the trailing digit |
| Linux / macOS (and other Unix) | `${DIR}/discord-ipc-{n}` | `DIR` is the first non-empty value of `XDG_RUNTIME_DIR` → `TMPDIR` → `TMP` → `TEMP` → `/tmp` |

The doc shows the prefix candidates as `${XDG_RUNTIME_DIR}/discord-ipc-{n}`, `${TMPDIR}/discord-ipc-{n}`, `${TMP}/discord-ipc-{n}`, `${TEMP}/discord-ipc-{n}`, or `/tmp/discord-ipc-{n}` and states the fallback order explicitly: *Discord resolves the IPC prefix in this order: `XDG_RUNTIME_DIR`, `TMPDIR`, `TMP`, `TEMP`, then `/tmp` as a final fallback.*

**Verified — C++ reference (`connection_unix.cpp` / `connection_win.cpp`):**

- Unix helper `GetTempPath()` reads exactly that env chain (`XDG_RUNTIME_DIR`, `TMPDIR`, `TMP`, `TEMP`, fallback `/tmp`) and formats `"%s/discord-ipc-%d"` with `pipeNum`.
- Windows helper does `CreateFileW(L"\\\\?\\pipe\\discord-ipc-0", …)` and increments the last code unit `L'0'` → `L'9'`.
- Loop bound in that implementation is `pipeNum 0..9` inclusive (10 candidates).

**Verified — Library divergence:**

- `discord-rpc@4.0.1` (`src/transports/ipc.js`) scans `0..10` inclusive (11 candidates) — one more than the official table/C++ impl.
- `@xhayper/discord-rpc@1.3.4` (`dist/transport/IPC.js`) scans `0..9` by default and supports a user-supplied `transport.pathList` (including custom TCP tuples).

**Additional discovery (library-only, not in official doc):**

- `@xhayper` adds Linux Flatpak/Snap path prefixes (`snap.discord/`, `app/com.discordapp.Discord/`) and explicit FreeBSD/OpenBSD/NetBSD socket paths. These are *implementation conveniences*, not part of the official spec — treat them as **Verified (library)** / **Unverified (official)**.

### 2.2 How many sockets to try and in what order

1. Resolve `DIR` per the priority chain above. On Linux, `@xhayper` further resolves the chosen directory via `fs.realpathSync()` (so a symlinked `XDG_RUNTIME_DIR` is dereferenced); `discord-rpc` does not.
2. For `n = 0, 1, 2, …` attempt `connect(DIR + "/discord-ipc-" + n)` (Unix) or `CreateFileW("\\\\?\\pipe\\discord-ipc-n")` (Windows) until one succeeds or the list is exhausted.
3. The official C++ impl and `@xhayper` default stop at `9`; `discord-rpc` stops at `10`. A new plugin should try at least `0..9` and is free to extend to `10` for compatibility — document whichever bound you ship.

### 2.3 Permissions and coexistence

- The IPC socket/named pipe is created by the Discord desktop client with user-local permissions. A second Discord client (e.g., Canary/PTB) or a Snap/Flatpak install may own a *different* pipe/slot. That is why clients scan: slot `0` may belong to Stable while your user runs PTB on slot `1`.
- Multiple apps can hold concurrent IPC connections to the same client; each connection independently handshakes.

---

## 3. Wire protocol — framing, opcodes, handshake

### 3.1 Frame layout

**Verified — Official RPC doc + C++ header `rpc_connection.h:15-27`:**

```c
struct MessageFrameHeader {
    Opcode  opcode;  // uint32 LE
    uint32  length;  // uint32 LE — byte length of the JSON payload that follows
};
// MaxRpcFrameSize = 64 * 1024
// Followed by exactly `length` bytes of UTF-8 JSON
```

- Every frame on the wire is **8 bytes of header + `length` bytes of JSON**. No newline delimiter. No WebSocket framing.
- Header fields are **little-endian unsigned 32-bit integers**. Implementation must use `readUInt32LE` / `writeUInt32LE` (Node/Bun: `Buffer` or `DataView` with `littleEndian: true`).
- The official example handshake bytes are `00 00 00 00 2D 00 00 00 {"v":1,"client_id":"123…"}`, i.e. opcode 0, length 45.

**Verified — Library framing bugs to avoid:**

- `discord-rpc@4.0.1` keeps decoder state in a *module-global* variable shared across all IPC transports and does not iterate over multiple complete frames coalesced in a single `data` event.
- `@xhayper/discord-rpc@1.3.4` (published 1.3.4) only emits when `accumulated.length === exactly one frame`; two frames arriving together can stall, and a header split across reads shorter than 8 bytes is discarded rather than buffered.

A correct implementation keeps *per-connection* state and loops `while (buffer.length >= 8 && buffer.length >= 8 + payloadLength) { emit one frame; slice; continue; }`.

### 3.2 Opcodes

**Verified — Official RPC doc, *Opcodes* table:**

| Opcode | Name | Direction | Meaning |
|---|---|---|---|
| `0` | `HANDSHAKE` | Client → Server | Initiates the session. Payload is `{"v":1,"client_id":"…"}` |
| `1` | `FRAME` | Both | All RPC commands, responses, and subscribed events after the handshake |
| `2` | `CLOSE` | Either | Graceful close. JSON payload is `{"code":…, "message":"…"}` when sent by the server |
| `3` | `PING` | Either | Keep-alive probe. Payload is opaque JSON (often `{}` or a nonce) |
| `4` | `PONG` | Either | Reply to `PING`; payload echoes the ping's payload |

No other opcodes are defined for IPC. `HANDSHAKE` is the *only* frame that may precede authentication; everything else uses `FRAME`.

### 3.3 Handshake

**Verified — Official RPC doc, *Connecting to IPC* + *Handshake Payload*:**

```json
{
  "v": 1,
  "client_id": "123456789012345678"
}
```

- Send as opcode `0` with `length = Buffer.byteLength(JSON.stringify(payload), "utf8")`.
- `v` is the RPC version; `1` is the only non-deprecated version the doc lists.
- `client_id` is the Application ID from the Developer Portal (snowflake rendered as a decimal string).

**Verified — Success signal:**

- On success the server replies with a `FRAME` (opcode `1`) whose JSON has `"evt":"READY"` / `"cmd":"DISPATCH"` and a `data` object containing server/user info. Treat receipt of `READY` as the transition to *ready* (see §7).
- On failure the server may reply with `evt:"ERROR"` and `data.code` (e.g., `4006` if you attempt a command before authenticating — though Rich Presence `SET_ACTIVITY` is explicitly exempt from that gate in the current Social SDK path; see §4.1).

### 3.4 Payload structure for all subsequent frames

**Verified — Official RPC doc, *Payload Structure*:**

| Field | Type | Present when |
|---|---|---|
| `cmd` | enum string | Always (e.g., `"SET_ACTIVITY"`, `"AUTHORIZE"`, `"SUBSCRIBE"`) |
| `nonce` | string | In *responses* to commands (echoes the request's `nonce`). Not in subscribed dispatches |
| `evt` | enum string | In subscribed events, errors, and subscribe/unsubscribe acks |
| `data` | object | In responses from the server |
| `args` | object | In commands sent *to* the server |

Requests you send look like:

```json
{ "cmd": "SET_ACTIVITY", "args": { "pid": 12345, "activity": { … } }, "nonce": "550e8400-…" }
```

Responses you receive look like:

```json
{ "cmd": "SET_ACTIVITY", "data": { … }, "evt": null, "nonce": "550e8400-…" }
```

Errors use `evt:"ERROR"` with `data: { "code": 1234, "message": "…" }`.

---

## 4. SET_ACTIVITY and the activity object

### 4.1 Command shape

**Verified — Official RPC doc, *SET_ACTIVITY*:**

```json
{
  "cmd": "SET_ACTIVITY",
  "args": {
    "pid": 12345,
    "activity": { /* Activity object — see §4.2 */ }
  },
  "nonce": "<uuid>"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `pid` | integer | Yes (per doc) | PID of the calling process. Some library impls substitute `process.pid` automatically |
| `activity` | `Activity` object or `null` | Yes — `null` / omitted to **clear** presence | Absence or `null` is the documented way to clear; there is no `CLEAR_ACTIVITY` RPC command |
| `nonce` | string (UUID v4 recommended) | Yes | Echoed in the response; used to correlate |

**Auth note — Verified:** The RPC doc says *most* commands require `AUTHORIZE` → `AUTHENTICATE` (else `4006`). The Social SDK doc explicitly states **Rich Presence can be set without authentication** via `Client::SetApplicationId` + `Client::UpdateRichPresence` — the local IPC path is the authenticated channel. For a plain IPC plugin, sending `SET_ACTIVITY` after `HANDSHAKE` without an OAuth flow is the intended path for presence-only use.

**Supported activity types over RPC — Verified contradiction to flag:**

- RPC `SET_ACTIVITY` supports only `Playing (0)`, `Listening (2)`, `Watching (3)`, `Competing (5)` — the doc has an explicit `<Info>` box to that effect.
- The Gateway activity schema (for bots) supports `0..5` including `Streaming (1)` and `Custom (4)`. Do not send `1` or `4` over RPC; validate on the client.

### 4.2 Activity object — field by field

The canonical shape is the **Gateway Activity object** (`gateway-events#activity-object`). The tables below reconcile that schema with the RPC example and the Social SDK guide. Where the docs diverge (notably timestamp units), both interpretations are called out.

#### Top-level fields

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | Usually omitted | Application name override. Defaults to the app's registered name. Use `Activity::SetName` / `activity.name` to display a custom top line |
| `type` | integer enum | No — defaults to `0` | `0 Playing`, `2 Listening`, `3 Watching`, `5 Competing` over RPC. Social SDK guide says use `Playing` for games |
| `url` | string | Only with `type:1 Streaming` | Validated Twitch/YouTube URL. **Not valid over RPC** (type 1 is unsupported there) |
| `created_at` | integer | No | When the activity was added. Typically set by the server |
| `application_id` | snowflake string | No | Usually inferred from `client_id` |
| `status_display_type` | integer enum | No | `0 Name` (default), `1 State`, `2 Details` — controls which field is used as the user's status text (Social SDK: `Activity::SetStatusDisplayType`) |
| `details` | string | No | Primary description — line 2 in the profile card. Example: `"Battle Creek"` |
| `details_url` | string (URL) | No | Makes `details` clickable when present |
| `state` | string | No | Secondary status — line 3 first half. Example: `"In Competitive Match"` |
| `state_url` | string (URL) | No | Makes `state` clickable |
| `timestamps` | object | No | Start/end times — controls the elapsed/remaining timer |
| `assets` | object | No | Artwork keys / external URLs |
| `party` | object | No | Party size/id — renders as `(2 of 5)` |
| `secrets` | object | No | Join/spectate/match tokens — power Game Invites |
| `instance` | boolean | No | Whether this is an instanced session (affects join behavior) |
| `flags` | integer bitfield | No | `INSTANCE 1<<0`, `JOIN 1<<1`, `SPECTATE 1<<2`, `JOIN_REQUEST 1<<3`, … |
| `buttons` | array of `Button` | No | Up to 2 call-to-action buttons |
| `emoji` | object | No | Custom status emoji (rarely used with Rich Presence) |
| `supported_platforms` | bitfield/enum | No | Social SDK: `ActivityGamePlatforms::Desktop` etc. — controls where join buttons appear |

#### `timestamps`

| Field | Type | Semantics |
|---|---|---|
| `start` | integer — **Unix seconds** for RPC/Social SDK; **Unix milliseconds** for Gateway `UpdatePresence` | Setting `start` alone → **count-up** timer (`12:34 elapsed`). Value should be `Math.floor(Date.now()/1000)` or `time(nullptr)` at the moment the activity began |
| `end` | integer — same unit | Setting `end` → **count-down** timer (`12:34 left`). Use `time(nullptr) + durationSec`. If both `start` and `end` are set, the display counts down to `end`; `start` still anchors the elapsed reference |

> **Verified contradiction — timestamp units:** The Social SDK guide and the RPC C++ example use **seconds** (`time(nullptr)` plus `writer.Int64(startTimestamp)` with no `*1000`). The Gateway `UpdatePresence` / bot `presence` docs specify **milliseconds** (`since` is *Unix time in milliseconds*). **For IPC `SET_ACTIVITY`, send seconds.** If you also update presence via Gateway, send milliseconds there.

#### `assets`

| Field | Type | Notes |
|---|---|---|
| `large_image` | string | Key of an uploaded Art Asset (lower-cased after upload) **or** an external URL of the form `mp:{media_proxy_id}` / `https://…` (see §5). Rendered as the large thumbnail |
| `large_text` | string | Hover text for `large_image` |
| `large_url` | string (URL) | Makes `large_image` clickable |
| `small_image` | string | Overlay icon key or external URL |
| `small_text` | string | Hover text for `small_image` |
| `small_url` | string (URL) | Makes `small_image` clickable |
| `invite_cover_image` | string | Cover for Game Invites (Social SDK) |

**Historical limits (from `include/discord_rpc.h`):** `state`/`details`/`large_text`/`small_text` `/* max 128 bytes */`, `large_image`/`small_image` keys `/* max 32 bytes */`, `partyId`/`secrets` `/* max 128 bytes */`. **These caps are not restated in the current docs** — treat them as *historical*, not normative, but staying within them remains the safest choice. The Social SDK best-practices doc says only "Keep it short — one line".

#### `party`

```json
{ "id": "party1234", "size": [2, 5] }
```

| Field | Type | Notes |
|---|---|---|
| `id` | string | Party identifier — required for join/spectate flows |
| `size` | `[current, max]` — array of two integers | Both must be present together; current ≤ max. Renders as `(2 of 5)` |

#### `secrets`

| Field | Type | Purpose |
|---|---|---|
| `join` | string | Token that lets another user join this party |
| `spectate` | string | Token for spectate flow |
| `match` | string | Match-level token |

Secrets enable the `ACTIVITY_JOIN` / `ACTIVITY_SPECTATE` / `ACTIVITY_JOIN_REQUEST` dispatches on the subscriber's side (subscribe via `{"cmd":"SUBSCRIBE","evt":"ACTIVITY_JOIN"}` etc.).

#### `buttons`

- **Send shape (what you set):** `[{ "label": "1–32 chars", "url": "1–512 chars, https://…" }, …]` — **max 2**.
- **Receive shape (Gateway):** `buttons: string[]` — labels only; URLs are stripped in the dispatch.
- Buttons are **only visible to other users**, never to the owner of the presence. Testing requires a second account.
- **Verified nuance:** Button labels/URLs are validated server-side; overly long labels or non-`https` URLs are rejected with an `ERROR` frame. Mark any additional character-set restriction as **Unverified** — the docs do not enumerate a charset beyond the length caps.

#### `instance`

Boolean. When `true`, the activity represents a joinable instance. Clearing presence is done by sending `activity: null` (or an `activity` with `instance: false` and no other fields — per `Discord_ClearPresence()` → `JsonWriteRichPresenceObj(null)`).

### 4.3 Minimal valid activity (copypasta-safe)

```json
{
  "cmd": "SET_ACTIVITY",
  "args": {
    "pid": 12345,
    "activity": {
      "type": 0,
      "details": "Editing docs/DISCORD-RPC.md",
      "state": "In opencode",
      "timestamps": { "start": 1726060800 },
      "assets": {
        "large_image": "opencode",
        "large_text": "opencode — AI-native editor",
        "small_image": "editing",
        "small_text": "Editing"
      },
      "buttons": [
        { "label": "View Project", "url": "https://github.com/vheins/opencode-discord-rich-presence" }
      ],
      "instance": false
    }
  },
  "nonce": "550e8400-e29b-41d4-a716-446655440000"
}
```

### 4.4 Clearing activity

**Verified — No `CLEAR_ACTIVITY` command exists in the current RPC docs.** Historical `discord-rpc` clears by calling `Discord_ClearPresence()` which serializes an activity with `presence == nullptr` and sends only `{"pid":…, "activity": null}` (or equivalently omitting the `activity` key). Implement `clear()` as:

```ts
sendFrame(1, { cmd: "SET_ACTIVITY", args: { pid: process.pid, activity: null }, nonce: uuid() });
```

---

## 5. Assets — how `large_image` keys resolve

### 5.1 Uploaded Art Assets (recommended for stable keys)

1. Open the **Discord Developer Portal** → your Application → **Rich Presence → Art Assets** (`https://discord.com/developers/applications/<app_id>/rich-presence/assets`).
2. Upload **PNG, JPEG, or WebP** (no animated images for uploaded assets). The docs recommend **1024 × 1024 px**; higher resolutions are downscaled. The portal caps at **300 custom assets per application**.
3. After saving, **keys are lower-cased** automatically. If you upload `MyIcon`, the key you must send is `myicon`. The portal shows the normalized key — copy it verbatim.
4. On the wire, reference the key as `assets.large_image = "myicon"` (or `small_image`). The Discord client resolves it to CDN `https://cdn.discordapp.com/app-assets/<application_id>/<asset_id>.png` (there is also an `app-assets` CDN variant documented under *Image Formatting*).
5. **Unverified (not in docs):** Maximum byte size per asset, maximum dimension beyond the 1024 recommendation, and exact allowed characters for keys (beyond "lower-cased") are **not stated** — do not invent. In practice keys behave like `^[a-z0-9_-]+$`; treat that as a *convention*, not a spec, until Discord publishes it.

### 5.2 External asset URLs (for >300 assets or dynamic images)

- You may set `assets.large_image` (or `small_image`) to an **external image URL** proxied via Discord's media proxy as `mp:{id}`. The docs phrase this as *"you can also specify an external URL as long it still has the proper dimensions and size"*.
- External URLs support **animated GIF, animated WebP, and AVIF** (unlike uploaded assets).
- The gateway docs describe these as `mp:`-prefixed image identifiers that resolve via `https://media.discordapp.net/...`.
- **Trade-off:** External URLs depend on the remote host staying reachable and risk slower loads/rate-limiting at the proxy. Prefer uploaded assets for anything user-visible in the profile card.

### 5.3 Resolution order the client applies

1. If the string starts with `mp:` or `https://`/`http://`, treat as external/media-proxy.
2. Otherwise treat as an Art Asset key → lower-case → lookup in the app's asset table → CDN fetch.
3. If the key is not found, the image slot is silently empty (no error frame) — the rest of the presence still displays.

---

## 6. Library comparison and recommendation

> **How the table was built:** `gh api` for GitHub repo metadata, `gh` source reads, and `registry.npmjs.org` + `unpkg.com` for published manifests — all on 2026-09-11. No install was performed. Two of the four requested package names could not be resolved in the npm registry at that date — those columns are marked **Unknown**.

| Dimension | `discord-rpc` (discordjs/RPC) | `@xhayper/discord-rpc` (Khaomi/discord-rpc) | `discord-rpc-client` | `@xraybot/discord-rpc` |
|---|---|---|---|---|
| **npm** | `discord-rpc@4.0.1` (2021-06-14), `gitHead c3c8fd4` | `@xhayper/discord-rpc@1.3.4` (2026-04-24), `gitHead 38bc15f` | **Unknown** — `registry.npmjs.org/discord-rpc-client` → 404 | **Unknown** — `registry.npmjs.org/@xraybot/discord-rpc` → 404 |
| **GitHub** | `discordjs/RPC` — `archived:false`, `disabled:false` | `Khaomi/discord-rpc` (npm points to `xhayper/discord-rpc` → redirect) — `archived:false` | **Ambiguous** — best namesake `Metalloriff/discord-rpc-client` exists but is an **Electron app** that *depends on* `discord-rpc@4.0.1`, not a library | **No verified repo** — `xraybot/discord-rpc` lookup → 404 |
| **Maintenance** | Effectively **deprecated** — no publish since 2021; README points to Social SDK | **Actively maintained** (publish April 2026); GitHub `main a51fa70` ahead of npm `1.3.3` manifest | Unknown | Unknown |
| **Language / types** | JS (CommonJS), no bundled types. Community `@types/discord-rpc@4.0.11` (TS 5.3, dep `@types/events`) with many `any`s | **TypeScript**, ships `dist/index.d.ts` + typed `SetActivity`/`ClientUser` | Unknown | Unknown |
| **Node engine** | No explicit engine | `>=20` | Unknown | Unknown |
| **Cross-platform IPC** | Windows `\\?\pipe\…`, Unix `XDG→…→/tmp` (0..10) | Same + `fs.realpathSync()`, configurable `transport.pathList`, extra Snap/Flatpak/BSD paths, default 0..9 | Unknown | Unknown |
| **Transport options** | IPC + WebSocket (deprecated) | IPC + WebSocket (port scan 0..9) + TCP tuple pathList | Unknown | Unknown |
| **Reconnect** | **None** for IPC. Cached `_connectPromise` never cleared — retry requires recreating the `Client`. WebSocket has a 250 ms / 20-attempt loop (not IPC) | **None** for IPC. Promise clears on success/timeout and on socket close, so caller-managed retry is possible without recreation — but no built-in backoff | Unknown | Unknown |
| **Dependencies** | `node-fetch ^2.6.1`, `ws ^7.3.1`, optional `register-scheme` (native `node-gyp rebuild`, `bindings`, `node-addon-api`) — IPC itself is `net`-only, the addon is for URI-scheme registration | `@discordjs/rest ^2.6.1`, `@vladfrangu/async_event_emitter ^2.4.7`, `discord-api-types ^0.38.47`, `ws ^8.20.0` — **no native addon** | Unknown | Unknown |
| **Framing correctness** | **Flawed** — global decoder, no coalesced-frame loop | **Flawed** — `accumulated.length === one frame` gate, <8-byte header discarded | Unknown | Unknown |
| **Provenance gap** | npm `gitHead` resolves | npm `gitHead 38bc15f` → GitHub 422 (no commit). Published JS read from UNPKG; **do not cite GitHub `main` as the 1.3.4 source** | — | — |

### Recommendation for a Bun/TS opencode plugin

**Shortlist `@xhayper/discord-rpc@1.3.4` — but do not adopt without a plugin-owned transport wrapper.**

*Why it is the least-wrong choice:*

- Bundled types and a typed `SetActivity` contract (vs DefinitelyTyped shims).
- No native addon (`register-scheme` / `node-gyp`) — cleaner for Bun.
- Configurable IPC discovery (`pathList`, TCP) and broader Unix coverage (Snap/Flatpak) — useful on Linux where opencode runs.
- No hard-archived/deprecated signal, unlike `discord-rpc`.

*Why it still needs a wrapper (acceptance blockers):*

- Neither library implements **automatic IPC reconnection** — your plugin must own the state machine in §7.
- Both have **framing bugs** — your plugin must own the frame decoder (per-connection buffer, loop over coalesced frames, retain partial headers).
- `@xhayper`'s 1.3.4 provenance is split (npm vs GitHub mismatch) — pin the exact tarball hash and validate framing/error handling before shipping.
- Neither enforces the RPC activity-type subset or timestamp-unit contract — validate in your builder (see §4).

**Do not shortlist** the two unresolved names until exact npm identities are supplied:

- The only verified `discord-rpc-client` on GitHub is an Electron desktop app, not a library — do not attribute its `1.0.0` manifest to the requested package.
- `@xraybot/discord-rpc` had no verified registry or GitHub hit on 2026-09-11 — 404 does not prove historical non-existence, but it is not a selectable dependency.

**Bun note — Verified:** Bun's Node compat docs list `node:net` Unix-domain sockets as supported and support CommonJS — so both libraries are *feasible* on Bun. **Unverified:** Windows named-pipe behavior via these packages, minimum working Bun version, and end-to-end Discord interop on Bun — require an explicit smoke test in your CI matrix.

---

## 7. Reconnect state machine and rate limits

### 7.1 States

```
                    ┌──────────────┐
                    │ disconnected │◄──────────────────────────┐
                    └──────┬───────┘                           │
                           │ connect()                         │ max attempts exhausted
                           ▼                                   │ or explicit close()
                    ┌──────────────┐     socket error /         │
               ┌───►│  connecting  ├────────────────────┐       │
               │    └──────┬───────┘                    │       │
               │           │ READY (FRAME evt:READY)    │       │
               │           ▼                            │       │
               │    ┌──────────────┐   transport error  │       │
               │    │    ready     │────────────────────┤       │
               │    └──────┬───────┘   but socket open  │       │
               │           │ SET_ACTIVITY 2xx/ERROR     │       │
               │           ├────────────────────────────┤       │
               │           │                            ▼       │
               │    ┌──────┴───────┐            ┌──────────────┐│
               │    │  degraded    │            │   closed     ││
               │    └──────┬───────┘            └──────────────┘│
               │           │ recover / retry                    │
               └───────────┘                                    │
                           ▲                                    │
                           └──── backoff + jitter ──────────────┘
```

| State | Meaning | What the plugin does |
|---|---|---|
| `disconnected` | No socket. Initial state and after `CLOSE` or exhausted retries | Idle. No `SET_ACTIVITY` enqueued |
| `connecting` | TCP/pipe connect in progress, handshake sent, awaiting `READY` | 10 s connect timeout (both libraries use 10 s). On timeout → treat as `connect` failure |
| `ready` | `READY` received; `SET_ACTIVITY` may be sent | Normal operation. Queue coalesces: only the latest activity is kept |
| `degraded` | Socket is open but the last `SET_ACTIVITY` errored, or a transport error fired without socket close | Keep socket; surface a warning; retry the *same* activity once after `retry_after` if the error was a rate-limit |
| `closed` | Clean shutdown (`CLOSE` opcode or `client.destroy()`) or terminal failure | Tear down timers, clear queue, emit `closed` |

**Transition triggers:**

- `connecting → ready` — `FRAME` with `evt:"READY"` / `cmd:"DISPATCH"` and `data` present.
- `connecting → disconnected` — socket `error`/`close` before `READY`, or connect timeout, or `ERROR` with non-retryable code.
- `ready → degraded` — `SET_ACTIVITY` response with `evt:"ERROR"` and a retryable code, or transport `error` without socket `close`.
- `ready/degraded → disconnected` — socket `close`/`error` that tears down the handle, or explicit `close()` from either side (opcode `2`).
- `degraded → ready` — a subsequent `SET_ACTIVITY` succeeds.
- Any `→ closed` — caller requested `destroy()` / `CLOSE` opcode, or max reconnect attempts exhausted.

### 7.2 Reconnect policy (plugin-owned — neither library provides this)

```ts
let attempt = 0;
const baseMs = 1_000;          // first retry after 1 s
const capMs  = 30_000;         // never wait longer than 30 s
const maxAttempts = 10;        // after 10 failures, go to `closed` and require manual reconnect
const jitterRatio = 0.2;       // ±20 %

function nextDelay(attempt: number): number {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  const jitter = exp * jitterRatio * (Math.random() * 2 - 1);
  return Math.max(250, Math.round(exp + jitter));
}
```

- Increment `attempt` on each failed `connect()` (including timeout).
- **Reset** `attempt = 0` on `ready` — a successful `READY` proves the client is back.
- On `degraded` due to rate-limit, prefer the server's `retry_after` (if present) over `nextDelay`.
- **Cap total reconnect window** — after `maxAttempts`, transition to `closed` and stop retrying. A future opencode event (e.g., workspace focus) may call `connect()` again and restart from `attempt = 0`.
- **Do not busy-loop.** The WebSocket retry in `discord-rpc` (250 ms × 20) is *not* a model for IPC — IPC failures usually mean Discord is not running; aggressive polling wastes CPU.

### 7.3 SET_ACTIVITY rate limit

**Verified — Gateway docs (`gateway:1561-1563`):**

> *Clients may only update their game status **5 times per 20 seconds**.*

- This is the limit that governs `SET_ACTIVITY` / `UpdatePresence`. The HTTP global `50 req/s` (`rate-limits` doc) is a **different scope** — do not conflate.
- Library source shows no client-side throttling; the plugin must enforce it.
- On `429` / `ERROR` with a `retry_after` field (HTTP-style `{ message, retry_after, global, code }` or the RPC `ERROR` envelope `{ code, message }` with a `retry_after` extension), honor `retry_after` and coalesce intermediate updates.
- Recommended client policy: **debounce `SET_ACTIVITY` to at most once per 4 s**, coalesce rapid edits (only send the latest activity), and queue at most one pending update while a request is in flight.

### 7.4 Error handling checklist

- Every `SET_ACTIVITY` you send must create a pending entry keyed by `nonce` with a **per-request timeout** (e.g., 10 s) — neither inspected library does this; without it a dropped response leaks a promise forever.
- On socket `close`/`error`, reject all pending nonces, clear listeners, and move to `disconnected` (or `closed` if `maxAttempts` exceeded).
- On `ERROR` with `code 4006` (not authenticated) — unexpected for presence-only, but treat as non-retryable and surface to the user (they may need to authorize for non-presence RPC commands).
- On any `CLOSE` frame, do not auto-reconnect without going through the backoff path — the server asked you to stop.

---

## 8. Minimal implementation sketch (non-normative)

This sketch is **not** the spec — it shows how §2–§7 compose into a Bun/Node IPC client. Copy with adaptation, not verbatim, and wrap with the state machine above.

```ts
import net from "node:net";
import { randomUUID } from "node:crypto";

const OPCODES = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 } as const;

function encodeFrame(opcode: number, payload: unknown): Buffer {
  const json = JSON.stringify(payload);
  const body = Buffer.from(json, "utf8");
  const header = Buffer.allocUnsafe(8);
  header.writeUInt32LE(opcode, 0);
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

function getIpcPaths(): string[] {
  const isWin = process.platform === "win32";
  if (isWin) return Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`);
  const dir = process.env.XDG_RUNTIME_DIR
    || process.env.TMPDIR
    || process.env.TMP
    || process.env.TEMP
    || "/tmp";
  return Array.from({ length: 10 }, (_, i) => `${dir}/discord-ipc-${i}`);
}

type Activity = {
  type?: 0 | 2 | 3 | 5;
  name?: string;
  details?: string; details_url?: string;
  state?: string;   state_url?: string;
  timestamps?: { start?: number; end?: number }; // seconds for RPC
  assets?: { large_image?: string; large_text?: string; large_url?: string;
             small_image?: string; small_text?: string; small_url?: string;
             invite_cover_image?: string; };
  party?: { id?: string; size?: [number, number] };
  secrets?: { join?: string; spectate?: string; match?: string };
  instance?: boolean;
  buttons?: Array<{ label: string; url: string }>; // max 2, 1..32 / 1..512
  status_display_type?: 0 | 1 | 2;
};

function validateActivity(a: Activity): void {
  if (a.type !== undefined && ![0, 2, 3, 5].includes(a.type)) {
    throw new RangeError(`activity.type ${a.type} is not valid over RPC (allowed: 0,2,3,5)`);
  }
  if (a.buttons && a.buttons.length > 2) throw new RangeError("buttons: max 2");
  for (const b of a.buttons ?? []) {
    if (b.label.length < 1 || b.label.length > 32) throw new RangeError("button.label: 1..32 chars");
    if (b.url.length < 1 || b.url.length > 512) throw new RangeError("button.url: 1..512 chars");
  }
}

// Per-connection decoder — avoids the global-state / single-frame bugs noted in §3.1
class FrameDecoder {
  private buf = Buffer.alloc(0);
  push(chunk: Buffer, onFrame: (opcode: number, payload: unknown) => void): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 8) {
      const opcode = this.buf.readUInt32LE(0);
      const len    = this.buf.readUInt32LE(4);
      if (len > 64 * 1024) throw new Error(`frame too large: ${len}`);
      if (this.buf.length < 8 + len) break; // incomplete — wait for more data
      const json = this.buf.subarray(8, 8 + len).toString("utf8");
      this.buf = this.buf.subarray(8 + len);
      onFrame(opcode, JSON.parse(json));
    }
  }
}
```

Sending `SET_ACTIVITY`:

```ts
validateActivity(activity);
const nonce = randomUUID();
socket.write(encodeFrame(OPCODES.FRAME, {
  cmd: "SET_ACTIVITY",
  args: { pid: process.pid, activity },
  nonce,
}));
// Register `nonce` with a per-request timeout (e.g., 10 s) and reject on expiry.
```

---

## 9. Sources

All URLs retrieved **2026-09-11 UTC**. Pin versions where noted; re-check before release.

| # | Source | URL / permalink | What it proves |
|---|---|---|---|
| 1 | Discord — RPC over IPC (current) | `https://docs.discord.com/developers/topics/rpc` — *IPC Path* table, *Connecting to IPC*, *Handshake Payload*, *Opcodes* (0–4), *Payload Structure*, *SET_ACTIVITY* (args `{pid, activity}`, allowed types `0,2,3,5`) | Path format, fallback order, frame header example, opcodes, handshake, SET_ACTIVITY shape |
| 2 | Discord — Gateway Activity object | `https://docs.discord.com/developers/events/gateway-events#activity-object` | Full activity schema: `name/type/url/created_at/timestamps/assets/party/secrets/instance/flags/buttons/supportedPlatforms`, `Max 2` buttons, `label 1–32 / url 1–512`, `mp:` external images |
| 3 | Discord — Setting Rich Presence (Social SDK) | `https://docs.discord.com/developers/discord-social-sdk/development-guides/setting-rich-presence` — *Uploading Assets*, *Setting Timestamps*, *Setting Buttons*, *Rich Presence Without Authentication* | 1024×1024, 300 assets, lowercase keys, PNG/JPEG/WebP (uploaded) vs GIF/WebP/AVIF (external), `ActivityTimestamps` in **seconds**, buttons only visible to others, presence without auth |
| 4 | Discord — discord-rpc C++ header | `https://github.com/discord/discord-rpc/blob/master/src/rpc_connection.h#L15-L27` | `MessageFrameHeader { uint32 opcode; uint32 length; }`, `MaxRpcFrameSize 64*1024`, LE u32 |
| 5 | Discord — discord-rpc Unix transport | `https://github.com/discord/discord-rpc/blob/master/src/connection_unix.cpp` | `GetTempPath()` env chain `XDG_RUNTIME_DIR‖TMPDIR‖TMP‖TEMP‖/tmp`, `"%s/discord-ipc-%d"` loop `0..9` |
| 6 | Discord — discord-rpc Windows transport | `https://github.com/discord/discord-rpc/blob/master/src/connection_win.cpp` | `CreateFileW(L"\\\\?\\pipe\\discord-ipc-0")` + increment `L'0'..L'9'` |
| 7 | Discord — discord-rpc serialization | `https://github.com/discord/discord-rpc/blob/master/src/serialization.cpp` (`JsonWriteRichPresenceObj`) + `include/discord_rpc.h:19-29` | `time(nullptr)` seconds, `party.size` only when both present, historical `/* max 128/32 bytes */` limits |
| 8 | npm — discord-rpc | `https://registry.npmjs.org/discord-rpc/latest` + `https://github.com/discordjs/RPC` (`c3c8fd4`, `master 9e7de2a`) + `src/transports/ipc.js:16-163`, `src/client.js:88-161`, `src/util.js` | `4.0.1` (2021-06-14), `archived:false`, no bundled types, `ws`/`node-fetch`/`register-scheme` (native), scan `0..10`, no IPC reconnect, global decoder |
| 9 | npm — @xhayper/discord-rpc | `https://registry.npmjs.org/@xhayper%2Fdiscord-rpc/latest` + `https://unpkg.com/@xhayper/discord-rpc@1.3.4/dist/transport/IPC.js`, `dist/Client.js`, `dist/index.d.ts` + `https://github.com/Khaomi/discord-rpc` (`main a51fa70`, manifest `1.3.3`; npm `gitHead 38bc15f` → 422) | `1.3.4` (2026-04-24), TS, `node>=20`, bundled types, `ws`+`@discordjs/rest`+`async_event_emitter`+`discord-api-types`, configurable `pathList`, extra Flatpak/Snap/BSD paths, no IPC reconnect, framing gate bug |
| 10 | npm — discord-rpc-client / @xraybot/discord-rpc | `https://registry.npmjs.org/discord-rpc-client` → 404, `https://registry.npmjs.org/@xraybot%2Fdiscord-rpc` → 404 (2026-09-11) + `https://github.com/Metalloriff/discord-rpc-client` (`2f0a152`, Electron app) | **Unknown / ambiguous** — do not select until exact identities supplied |
| 11 | Bun — Node compat | `https://bun.com/docs/runtime/nodejs-compat` | `node:net` Unix sockets supported; CommonJS supported — feasibility only |

> **On the "known facts" in the task prompt:** The prompt's summary (Windows `\\.\pipe\…`, Unix `$XDG_RUNTIME_DIR`→`$TMPDIR`→`/tmp`, frame `LE u32 op + LE u32 len + JSON`, opcodes 0–4, handshake `{v:1, client_id}`, `SET_ACTIVITY` with `{pid, activity}`) is **consistent** with the sources above. The precise Windows canonical form is `\\?\pipe\…` (with `?`) in both the current docs and C++ source; `\\.\pipe\…` also works on Windows but the doc normalizes to `\\?\`. Library scan ranges and the exact Unix fallback list (`TMP`/`TEMP` included) are refinements beyond the prompt's shorthand.
