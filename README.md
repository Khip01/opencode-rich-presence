# OpenCode Rich Presence

OpenCode plugin that displays your AI session status in Discord.


<img width="449" height="190" alt="image" src="https://github.com/user-attachments/assets/ef8233c2-aa6e-48a5-be98-e0ec58691376" />

**Status: v3.3.2** (daemon-based push, multi-instance safe).
A long-lived daemon holds the single Discord IPC connection for the
whole machine. OpenCode plugin instances connect to it via the
local IPC endpoint and forward their state. Handoff between OpenCode
windows no longer disconnects from Discord.

## What you get today (v3)

- **Daemon-based push**: `src/worker/daemon.mjs` is a long-lived
  subprocess that owns the Discord connection. All OpenCode plugin
  instances connect to it via the local IPC endpoint and forward their
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

## Requirements

- Node.js 18+ (LTS recommended; CI tests on 20, 22, 24, plus 22 on Windows)
- OpenCode CLI (v1 or v2 — `opencode-rpc install` detects the major
  version and links the matching plugin entry: `src/plugin/index.js`
  for v1, `src/plugin/index.v2.js` for v2)
- Discord Desktop (required for v3 Phase 2 push)

Works on **Linux** and **macOS**. Windows support is implemented
through named pipes: the daemon listens on
`\\.\pipe\opencode-rich-presence-<userhash>` instead of a `.sock`
file, and Discord is found via `\\.\pipe\discord-ipc-N`. CI runs a
`windows-latest` job that exercises those paths: the win-path
harness (liveness helpers, IPC address shape), a live daemon spawn
via `presence-toggle`, and the phase2-v2 harness. Real Discord
Desktop handshakes on Windows have been observed on user machines
(`Discord connected` over `\\.\pipe\discord-ipc-0`); if a fresh
spawn does not connect within a minute, restart Discord Desktop
once (it rate-limits rapid reconnects per App ID) and fire a
message to trigger a push. The phase1/phase2/cli-lifecycle harnesses
stay Linux-only until they are
ported off their hardcoded `/tmp` paths and `bash` calls.

## Installation

### 1. Install the package

Pick one install path.

#### Quick install (Linux, macOS, and Windows via Git Bash / MSYS2 / Cygwin / WSL, recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/Khip01/opencode-rich-presence/main/install.sh | bash
```

This downloads the latest stable release tarball, installs it via
`npm install -g <tarball>`, and runs `opencode-rpc install` to set
up the plugin symlink and config. Pin to a specific version:

```bash
curl -fsSL https://raw.githubusercontent.com/Khip01/opencode-rich-presence/main/install.sh \
  | ORP_VERSION=v3.3.2 bash
```

If you do not have `curl`, replace it with `wget -qO- <url>` or
fetch the script manually and `bash ./install.sh`.

Pure cmd.exe / PowerShell users: the script runs in bash. Open
Git Bash (ships with [Git for Windows](https://gitforwindows.org/))
and run it from there.

#### Manual install from a tarball (Linux, macOS, Windows)

1. Download the tarball for your platform from
   [GitHub Releases](https://github.com/Khip01/opencode-rich-presence/releases/latest).
   The tarball name is `opencode-rich-presence-<version>.tgz` and
   works on any platform with Node.js 18+.
2. Install it:
   ```bash
   npm install -g ./opencode-rich-presence-3.3.2.tgz
   ```
3. Continue with step 2 below.

### 2. Set up the plugin

```bash
opencode-rpc install
```

This creates `~/.config/opencode/discord-config.json` from the
bundled example (only if missing, or after confirmation to
overwrite) and symlinks the plugin entry to
`~/.config/opencode/plugins/opencode-rich-presence.js`. v3 installs
no additional npm dependencies.

If OpenCode is already installed, `install.sh` runs this step for
you. Skip it if you already saw the `Replaced / Linked` line.

### 3. Restart OpenCode and verify

The plugin loads automatically via the symlink. After OpenCode
restart:

```bash
opencode-rpc info
```

`info` shows the last 30 entries of the activity log so you can
verify the plugin captured events, the daemon is connected, and
Discord is reporting presence.

For detailed setup (creating your own Discord App, advanced
config), see [`docs/INSTALL.md`](./docs/INSTALL.md).

### OpenCode v2

OpenCode v2 changed the plugin API, so the v1 entry
(`src/plugin/index.js`) does not load there — the server logs
`Plugin must export a default definition with an id and an effect
or setup function`. This package ships a v2 entry
(`src/plugin/index.v2.js`, plugin id
`opencode-rich-presence-v2`) that reuses the same daemon,
templates, and `discord-config.json`; only the event wiring uses
the v2 API (`prompt` / `context` / tool hooks plus an event
subscription). `opencode-rpc install` probes `opencode --version`
and links the matching entry under the same
`~/.config/opencode/plugins/opencode-rich-presence.js` name, so
exactly one entry loads and no startup warning appears. When no
OpenCode binary is found (Desktop-only installs without the CLI on
PATH), the installer asks which entry to link. The v2 entry needs
the `@opencode/plugin` dependency, which ships with the package —
no extra install step.

Note for OpenCode Desktop users: the Desktop backend
(`opencode-cli serve`) is long-lived. After install or upgrade,
restart the backend (quit Desktop fully, or stop its
`opencode-cli` process and let Desktop respawn it) or the new
entry will not load until the next reboot.

## CLI Reference

```bash
opencode-rpc <command> [options]
```

| Command | Description |
|---------|-------------|
| `install` | Set up the plugin (config + symlink). v3 installs no deps. |
| `uninstall` | Remove generated files; back up config to timestamped file |
| `on` | Enable presence (instant, keeps the daemon alive; clears a kill lock) |
| `off` | Disable presence (instant, keeps the daemon alive) |
| `restart` | Kill the daemon so the next chat.message spawns a fresh one. |
| `kill` | Stop the daemon permanently (use `spawn` to start again) |
| `spawn` | Start the daemon again after a `kill` (refuses if one is running) |
| `update` | Upgrade to latest stable release tag |
| `update --stable` | Force-install latest stable tag (skip version check) |
| `update --dev [BRANCH]` | Upgrade to latest commit on BRANCH (default: `main`, currently v3.3.2) |
| `update --ref REF` | Install a specific ref (tag, branch, or commit SHA) |
| `update --repo OWNER/REPO` | Install from a fork instead of upstream |
| `info` | Diagnostics: paths, config, daemon status, activity log tail |
| `version` | Print package version and channel |
| `help` | Show usage |

Full reference: [`docs/CLI-REFERENCE.md`](./docs/CLI-REFERENCE.md)

## Update

```bash
opencode-rpc update                  # latest stable release tag (v3.3.2 today)
opencode-rpc update --stable         # force install latest stable tag
opencode-rpc update --dev <branch>   # latest commit on <branch> (developer)
opencode-rpc update --ref <ref>      # specific ref (tag, branch, or SHA)
opencode-rpc update --repo <fork>    # install from a fork
```

All four flags are mutually exclusive. `update` always installs from
a local tarball (clone + `npm pack` + `npm install -g <tarball>`)
so it sidesteps the npm v11 git-dep bug described at the bottom of
this file.

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
need to upgrade (`opencode-rpc update --ref v3.0.4-phase2` or
newer).

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
| `{model}` | `oc/muse-spark-1.2-contributor-free` | Model full code (raw, with provider prefix) |
| `{modelCode}` | `muse-spark-1.2-contributor-free` | Model code only (after last `/`) |
| `{modelName}` | `Muse Spark 1.2 Contributor Free` | Human-readable Title Case |
| `{modelNameLower}` | `muse spark 1.2 contributor free` | Human-readable lowercase |
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

Plus conditionals (`{{#if mode == "build"}}...{{/if}}`), fallbacks
(`{var|fallback}`), and wildcard `replacements` on any var (e.g. `* Free` -> `""` on `modelName`, `plan` -> `Planning` on `mode`). See [`docs/CUSTOMIZATION.md`](./docs/CUSTOMIZATION.md) for full syntax and the Replacements section.

## Platform Notes

Linux, macOS, and Windows are all supported. See
[`docs/PLATFORM-NOTES.md`](./docs/PLATFORM-NOTES.md) for per-OS
details (Flatpak/Snap detection, AppleScript quit, taskkill quirks,
named pipes).

## Architecture

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full
design (template engine, per-instance state, daemon lifecycle,
single-connection rationale).

## The npm v11 git-dep bug

If you have ever seen this after `npm install -g <repo>#<tag>`:

```
$ npm install -g 'Khip01/opencode-rich-presence#v3.3.2'
added 1 package in 4s

$ opencode-rpc
zsh: command not found: opencode-rpc

$ npm list -g opencode-rich-presence
└── opencode-rich-presence@ -> ./../../../../../.npm/_cacache/tmp/git-cloneAmM1cO
```

You have hit an npm v11 bug. It is on npm's side, not the
package's, and there is no fix from the package side.

### What npm v11 does (the bug)

When installing a global git dep like `<owner>/<repo>#<ref>`, npm
v11:

1. Clones the repo to a temp dir under `~/.npm/_cacache/tmp/`.
2. Symlinks `lib/node_modules/<repo>` to that temp dir.
3. Should create `bin/<binary>` symlinks into the package... but
   does not.

The result: `npm list -g` shows the package, the directory exists,
but the CLI binary is missing. The bug is consistent across
branches, tags, and commit SHAs, and across npm v11.0.0 through at
least v11.8.0.

The temp dir also gets cleaned up by `npm cache clean --force` or
when the system reboots with tmpfs-backed `/tmp` paths on some
configurations. After cleanup the symlink dangles and the install
appears to vanish.

### Why this package cannot work around it

The bug is in npm's git-dep install handler, not in
`opencode-rich-presence`. Even with a complete `package.json`,
correct `bin` entries, and no `files` filter, npm v11 still omits
the bin symlink for global git deps.

### Workarounds (in order of recommendation)

1. **Use the curl installer above.** It downloads a real tarball
   and runs `npm install -g <tarball>`. Tarball installs are not
   affected by the bug.
2. **Manual tarball install** from
   [GitHub Releases](https://github.com/Khip01/opencode-rich-presence/releases/latest).
3. **`opencode-rpc update --ref <tag>`** for upgrades after the
   curl installer has put `opencode-rpc` on PATH.

All three paths install from a local tarball, which sidesteps the
git-dep handler entirely.

## Migration from v1.0.0

v1.0.0 used bash scripts and was Linux-only. See
[`CHANGELOG.md`](./CHANGELOG.md) for the migration guide.

## License

MIT
