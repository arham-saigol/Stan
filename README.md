# Stan

Stan is a private, single-owner WhatsApp agent for researching X, drafting in Arham's voice, and performing only explicitly authorized account actions. It runs locally on Node.js 24 with durable Flue and SQLite state.

## Install and set up

```bash
npm install
npm run build
npm link
stan setup
stan start
```

Runtime state is stored under `%LOCALAPPDATA%\Stan` on Windows and `$XDG_STATE_HOME/stan` or `~/.local/state/stan` on Linux. Source-tree files and `.env` are not runtime state.

`stan setup` discloses the Baileys and Supermemory boundaries, creates owner-only state, authenticates Codex and WhatsApp, validates configured APIs, initializes the workspace, and can install native autostart. Baileys is unofficial; use a dedicated WhatsApp number and understand that protocol changes or automation can lead to suspension.

## Operations

```text
stan auth
stan whatsapp auth [--method qr|pairing]
stan apis auth
stan start|stop|restart
stan status
stan logs [-f] [-n 100] [--level info]
stan doctor
stan service install
```

The daemon exposes only a bearer-protected localhost control endpoint. It never mounts the Flue conversation over HTTP. Public X tools receive the selected account from trusted configuration and consume a short-lived owner authorization envelope derived by the WhatsApp gateway; tool arguments, memory, fetched content, automations, and heartbeats cannot create one.

## Development

```bash
npm run typecheck
npm test
npm run build
npm run check
```

Tests use temporary state roots and in-memory/file-backed SQLite. Live provider feasibility status is recorded in [`docs/feasibility-gates.md`](docs/feasibility-gates.md).
