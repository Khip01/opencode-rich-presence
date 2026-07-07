# OpenCode Rich Presence

OpenCode plugin that displays your AI session status in Discord.

**Status: v3.1.4-phase2** (daemon-based push, multi-instance safe).
A long-lived daemon holds the single Discord IPC connection for the
whole machine. OpenCode plugin instances connect to it via local
Unix socket and forward their state. Handoff between OpenCode
windows no longer disconnects from Discord.

The `main` branch currently holds the v2.1.1 release (pre-redesign).
Active v3 development is on the `redesign/v3-daemon` branch; install
from there for the daemon-based push experience.

## What you get today (v3)

- **Daemon-based push**: `src/worker/daemon.mjs` is a long-lived
  subprocess that owns the Discord connection. All OpenCode plugin
  instances connect to it via local Unix socket and forward their
  rendered presence payload. The daemon picks the global
  most-recently-active instance and pushes to Discord in place.
- **Display survives terminal switching**: when you switch
  OpenCode windows, the same Discord connection just shows the
  new state (no reconnect, no "display disappears" gap).
- **Display survives exit-and-reopen**: close all OpenCode
  windows, reopen, fire a message, the display comes back
  instantly. The daemon stays alive (no Discord reconnect,
  no app-id cooldown exposure).
- **Activity log** at `~/.config/opencode/presence-activity.log`
  that records every plugin action (events, state transitions,
  template renders, daemon sends, push events). PID-tagged for
  easy filtering when multiple OpenCode windows are open.
- **Per-instance state snapshot** at
  `~/.config/opencode/presence-state-pid<pid>.txt` showing what
  each OpenCode instance is rendering.
- **Crash diagnostics built-in**: `uncaughtException`,
  `unhandledRejection`, `beforeExit`, and `exit` handlers log
  every abnormal exit path so silent daemon deaths have a trail.

Works on **Linux** and **macOS**. Windows requires named-pipe
support which is not part of CI; the daemon falls back to a
named-pipe on Windows but it is not actively tested.

## Installation

### 1. Install the package

Use the CLI's built-in installer (recommended — it sidesteps a
npm v11 bug that breaks `npm install -g <url>#<branch>` for
branches):

```bash
# Track the v3 redesign branch for ongoing dev installs:
opencode-rpc update --dev redesign/v3-daemon
opencode-rpc install

# Or pin to a specific v3 tag (once published):
opencode-rpc update --ref v3.0.0
opencode-rpc install

# Or the latest stable v2 (no daemon, no Discord push):
npm install -g 'Khip01/opencode-rich-presence#v2.1.1'   # zsh: quote
opencode-rpc install

# Install from your own fork (test your changes before opening a PR):
opencode-rpc update --repo myname/opencode-rich-presence --ref my-branch
opencode-rpc install
```

Do NOT use `npm install -g <url>#<branch>` for branches — see the
"npm v11 git-dep bug" section below.

### 2. Set up the config

```bash
opencode-rpc install
```

This creates `~/.config/opencode/discord-config.json` from the
example and the symlink that OpenCode needs to auto-load the plugin.
v3 installs no additional npm dependencies.

### 3. Restart OpenCode

The plugin is loaded automatically via the symlink at
`~/.config/opencode/plugins/opencode-rich-presence.js`. After
OpenCode restart, check status:

```bash
opencode-rpc info
```

This shows the last 30 entries of the activity log so you can verify
the plugin is capturing events, the daemon is connected, and
Discord is reporting presence.

For detailed setup (creating your own Discord App, advanced config),
see [`docs/INSTALL.md`](./docs/INSTALL.md).

## CLI Reference

```bash
opencode-rpc <command> [options]
```

| Command | Description |
|---------|-------------|
| `install` | Set up the plugin (config + symlink). v3 installs no deps. |
| `uninstall` | Remove generated files; back up config to timestamped file |
| `restart` | Kill the daemon so the next chat.message spawns a fresh one. |
| `update` | Upgrade to latest stable release tag |
| `update --stable` | Force-install latest stable tag (skip version check) |
| `update --dev [BRANCH]` | Upgrade to latest commit on BRANCH (default: `main`, which is currently v2.1.1 — pass branch explicitly on v3) |
| `update --ref REF` | Install a specific ref (tag, branch, or commit SHA) |
| `update --repo OWNER/REPO` | Install from a fork instead of upstream |
| `info` | Diagnostics: paths, config, daemon status, activity log tail |
| `version` | Print package version and channel |
| `help` | Show usage |

Full reference: [`docs/CLI-REFERENCE.md`](./docs/CLI-REFERENCE.md)

## Update

```bash
opencode-rpc update                  # latest stable release tag (v2.1.1 today)
opencode-rpc update --stable         # force install latest stable tag
opencode-rpc update --dev <branch>   # latest commit on <branch> (developer)
opencode-rpc update --ref <ref>      # specific ref (tag, branch, or SHA)
opencode-rpc update --repo <fork>    # install from a fork
```

All four flags are mutually exclusive. `--ref` and `--dev <branch>`
are the recommended paths for non-stable installs because they
sidestep the npm v11 git-dep bug.

## Activity log: what to look at

```bash
tail -f ~/.config/opencode/presence-activity.log
```

Each line:

```
[2026-07-05 14:30:25.789] [pid 12345] [tag] message
```

Tags you'll see:

| Tag | Meaning |
|-----|---------|
| `load` | plugin lifecycle |
| `event` | raw SDK event received |
| `state` | session state transition |
| `template` | presence template render (source -> output) |
| `push` | real push to Discord via the daemon (or `would-push` in local-only fallback) |
| `display` | which session is the displayed one |
| `queue` | session added/removed from local tracking |
| `stats` | cost / tokens / context% updates |
| `check` | periodic SDK poll |
| `daemon` | plugin-side daemon connection events (spawn, connect, disconnect) |
| `presence` | Phase 2 start/stop markers |

For full troubleshooting, see [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md).

### Diagnosing the daemon

If the display stops updating:

```bash
tail -200 ~/.config/opencode/presence-activity.log | grep -E "daemon|instance|push|EPIPE|exit code"
```

Expected on a healthy install:

- One `daemon starting` line per `opencode-rpc restart`.
- Zero `exit code=1` lines.
- Zero `uncaughtException` or `unhandledRejection` lines.
- One `push pid=...` line per `chat.message` event.

If you see `uncaughtException: Error: write EPIPE` followed by
`exit code=1`, you are on a version older than v3.0.4-phase2 and
need to upgrade (`opencode-rpc update --ref redesign/v3-daemon`).

## Customization

Edit `~/.config/opencode/discord-config.json`:

```json
{
  "discordAppId": "YOUR_APP_ID",
  "discordLargeImageKey": "your-asset-key",
  "currency": "$",
  "presence": {
    "details": "{model} ({mode})",
    "state": "{state} · {contextCompact}",
    "byState": {
      "Typing": {
        "state": "{{#if contextPercent > 80}}⚠️ {contextCompact} full{{else}}{contextCompact} ctx{{/if}}"
      }
    }
  }
}
```

### Available Variables

| Variable | Example | Description |
|---|---|---|
| `{model}` | `minimax-m3` | Model in use |
| `{mode}` | `build`, `plan` | Agent mode |
| `{state}` | `Working`, `Thinking` | Current state |
| `{context}` | `45,321` | Tokens used (raw) |
| `{contextCompact}` | `45.3K` | Tokens used (compact) |
| `{contextPercent}` | `23.7` | Context percentage |
| `{contextLimit}` | `262,144` | Model context limit |
| `{prompts}` | `12` | User prompt count |
| `{promptsCompact}` | `1.5K` | Prompt count (compact) |
| `{cost}` | `$0.0042` | Session cost |
| `{costCompact}` | `$1.5K` | Session cost (compact) |
| `{elapsed}` | `1h 23m` | Session duration |
| `{provider}` | `Khip01` | Provider name |

Plus conditionals (`{{#if mode == "build"}}...{{/if}}`) and fallbacks
(`{var|fallback}`).

See [`docs/CUSTOMIZATION.md`](./docs/CUSTOMIZATION.md) for full syntax.

## Platform Notes

Linux, macOS, and Windows are all supported. See
[`docs/PLATFORM-NOTES.md`](./docs/PLATFORM-NOTES.md) for per-OS
details (Flatpak/Snap detection, AppleScript quit, taskkill quirks,
named pipes).

## Architecture

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full
design (template engine, per-instance state, daemon lifecycle,
single-connection rationale).

## Requirements

- Node.js 18+ (LTS recommended; CI tests on 20, 22, 24)
- OpenCode CLI
- Discord Desktop (required for v3 Phase 2 push)

## The npm v11 git-dep bug

`npm install -g <owner>/<repo>#<branch>` for global packages
creates a partial install on npm 11.x:

- The package directory at `lib/node_modules/<repo>/` contains
  only `src/`, no `package.json`, no `bin/`.
- The `<repo>` symlink in `~/.nvm/.../bin/` is never created.
- npm reports "added 1 package" anyway.

Symptoms: `zsh: command not found: opencode-rpc` immediately after
install. Workaround: use `opencode-rpc update --ref <branch>`
instead — it does a clean clone + `npm pack` + install of the
local tarball, which is not affected by the bug. See
[`docs/INSTALL.md`](./docs/INSTALL.md) for the full install flow.

## Migration from v1.0.0

v1.0.0 used bash scripts and was Linux-only. See
[`CHANGELOG.md`](./CHANGELOG.md) for the migration guide.

## License

MIT
