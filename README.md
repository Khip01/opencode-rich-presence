# OpenCode Rich Presence

OpenCode plugin that displays your AI session status in Discord.

**Status: v3 Phase 1** (local state + activity log, no Discord push yet).
Discord push arrives in v3 Phase 2 (daemon architecture).

## What you get today (Phase 1)

- **Activity log** at `~/.config/opencode/presence-activity.log` that
  records every OpenCode SDK event the plugin receives, every session
  state transition, and every presence template render. This is the
  diagnostic surface for the v3 redesign.
- **Per-instance state snapshot** at
  `~/.config/opencode/presence-state-pid<pid>.txt` showing what the
  plugin WOULD push to Discord (Phase 2 wires the actual push).
- **Multi-instance safe**: each OpenCode instance writes its own
  state file; the activity log is shared and tagged with PID.

## What you get in Phase 2

- **Daemon architecture**: a long-lived subprocess holds the single
  Discord IPC connection for the whole machine. State updates happen
  in-place via SET_ACTIVITY (no reconnect on terminal switch, no
  "display disappears" gap).
- **Display survives terminal switching**: the daemon picks the
  globally most-recently-active session and shows it on Discord.
  Switching OpenCode windows updates the display without any
  connection tear-down.

Works on **Linux**, **macOS**, and **Windows**.

## Installation

### 1. Install the package

```bash
# Stable release (v2.1.1 is the most recent stable; v3 is on the
# redesign branch and currently in Phase 1)
npm install -g Khip01/opencode-rich-presence#v2.1.1

# Or the v3 Phase 1 redesign branch
npm install -g Khip01/opencode-rich-presence#redesign/v3-daemon

# Or the latest commit on main (rolling)
npm install -g Khip01/opencode-rich-presence
```

This installs the `opencode-rpc` CLI globally. The plugin code lives
in the repo itself (no separate tarball needed), so `npm` clones the
repo and installs from there.

### 2. Set up the config

```bash
opencode-rpc install
```

This creates `~/.config/opencode/discord-config.json` from the
example and the symlink that OpenCode needs to auto-load the plugin.
Phase 1 installs no additional npm dependencies (the v2.x
`@xhayper/discord-rpc` step is gone in Phase 1).

### 3. Restart OpenCode

The plugin is loaded automatically via the symlink at
`~/.config/opencode/plugins/opencode-rich-presence.js`. After
OpenCode restart, check status:

```bash
opencode-rpc info
```

This shows the last 30 entries of the activity log so you can verify
the plugin is capturing events.

For detailed setup (creating your own Discord App, advanced config),
see [`docs/INSTALL.md`](./docs/INSTALL.md).

## CLI Reference

```bash
opencode-rpc <command>
```

| Command | Description |
|---------|-------------|
| `install` | Set up the plugin (config + symlink). Phase 1 installs no deps. |
| `uninstall` | Remove generated files (lock, state files, activity log); backup config |
| `restart` | Phase 1: rotate the activity log. Phase 2: respawn the daemon. |
| `update` | Upgrade to latest stable release (or `--dev` for latest commit, `--stable` to force-reinstall latest stable tag) |
| `info` | Diagnostics: paths, config, per-instance state files, activity log tail |
| `version` | Print package version |
| `help` | Show usage |

Full reference: [`docs/CLI-REFERENCE.md`](./docs/CLI-REFERENCE.md)

## Update

```bash
opencode-rpc update                  # upgrade to latest stable release (if newer)
opencode-rpc update --dev            # upgrade to latest commit on main (developer)
opencode-rpc update --stable         # force install latest stable tag (use to switch off dev)
```

`--stable` skips version comparison and always installs the latest
tag, useful for switching back from `--dev` mode. `--stable` and
`--dev` are mutually exclusive.

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
| `push` | would-push payload (Phase 1 stub; Phase 2: real push) |
| `display` | which session is the displayed one |
| `queue` | session added/removed from local tracking |
| `stats` | cost / tokens / context% updates |
| `check` | periodic SDK poll |

For full troubleshooting, see [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md).

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
        "state": "{{#if contextPercent > 80}} {contextCompact} full{{else}}{contextCompact} ctx{{/if}}"
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
design (template engine, per-instance state, Phase 2 daemon preview).

## Requirements

- Node.js 18+ (LTS recommended)
- OpenCode CLI

Discord Desktop is not required for Phase 1. Phase 2 will require it.

## Migration from v1.0.0

v1.0.0 used bash scripts and was Linux-only. See
[`CHANGELOG.md`](./CHANGELOG.md) for the migration guide.

## License

MIT

---

A co-op project by Minimax M3 and DeepSeek V4 Flash.
