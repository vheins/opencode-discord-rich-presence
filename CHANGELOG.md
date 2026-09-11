# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-09-11

Initial public release.

### Added

- **opencode plugin scaffold** — native `@opencode-ai/plugin` entry point with a per-session
  state machine, modular `config` / `core` / `discord` / `utils` layers, and 45-option
  validated configuration (`docs/ARCHITECTURE.md` §5.1).
- **Session stats presence** — live model/provider, token counts
  (`input`/`output`/`reasoning`/`cache`), USD cost, elapsed timer, and `contextPercent`
  template variables.
- **Cross-platform Discord IPC** — `discord-ipc-0..9` discovery on Windows (`\\?\pipe\`) and
  Unix (`$XDG_RUNTIME_DIR`/`$TMPDIR`/`/tmp`), per-connection frame decoder, exponential backoff
  reconnect (base 1 s → cap 30 s, jitter 0.2, max 10 attempts), handshake timeout, debounce
  100 ms + throttle 4000 ms, and `retry_after` handling.
- **Privacy, idle, and per-project config** — `privacy.*` redaction toggles, `idle.*` timeout
  with custom templates, and `perProject.*` overlays with precedence
  `global < project < env < runtime`.
- **Custom Discord app id and Art Assets** — `applicationId` (`/^\d{17,20}$/`) plus
  `largeImageKey`/`largeImageText` and `smallImageKey`/`smallImageText`.
- **Buttons and multi-session** — up to 2 `https://` buttons and `leader-election` /
  `last-wins` multi-session strategies.
- **Presence engine** — `activityType` (`playing`/`listening`/`watching`/`competing`),
  `activityName`, random/sequential phrase pools with cooldown, builtin/custom/MCP tool
  activity resolver with unknown fallback, and context + TODO telemetry merged into the
  Discord two-line limit (`docs/PRESENCE-DESIGN.md`).
- **TypeScript build output** — `tsconfig.build.json` emits ESM JavaScript plus declarations
  and source maps to `dist/`.

### Documentation

- Full docs set under `docs/`: `ARCHITECTURE`, `OPENCODE-PLUGIN-API`, `DISCORD-RPC`,
  `CONFIGURATION`, `PRESENCE-DESIGN`, `EXTENDING`, `COMMUNITY-ANALYSIS`, `ROADMAP`,
  `DEVELOPMENT`.

[Unreleased]: https://github.com/vheins/opencode-discord-rich-presence/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/vheins/opencode-discord-rich-presence/releases/tag/v0.1.0
