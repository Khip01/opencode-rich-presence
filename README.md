# OpenCode Rich Presence

Cross-platform Discord Rich Presence plugin for [OpenCode AI](https://opencode.ai/). Displays your AI session status, model, context usage, and cost directly in your Discord profile.

Works on **Linux**, **macOS**, and **Windows**.

<img src="https://github.com/user-attachments/assets/2e03f6b4-e089-4be5-9c65-baa38af39c07" alt="Discord presence preview" width="600">

## Features

- **Real-time Discord Rich Presence** with model, mode, state, context usage, cost, prompts
- **Template engine** with variables, conditionals, fallbacks, per-state templates
- **Multi-instance safe**: leader election via file lock prevents duplicate Discord connections when running multiple OpenCode windows
- **Automatic Discord restart** via CLI (cross-platform: `pkill`, `osascript`, `taskkill`)
- **Status output file** at `~/.config/opencode/presence-state.txt` for debugging
- **CLI management**: install, uninstall, restart, update, info, help

## Installation

### 1. Install the package

```bash
npm install -g https://github.com/Khip01/opencode-rich-presence/releases/latest/download/opencode-rich-presence-latest.tgz
```

This installs the `opencode-rpc` CLI globally. The plugin code is bundled inside the tarball and OpenCode will auto-load it once registered (next step).

### 2. Set up the config

```bash
opencode-rpc install
```

This creates `~/.config/opencode/discord-config.json` from the example. Edit it to set your Discord App ID and customize templates.

### 3. Register the plugin with OpenCode

Add the plugin to `~/.config/opencode/opencode.json` (or `.jsonc`):

```json
{
  "plugin": ["opencode-rich-presence"]
}
```

### 4. Restart OpenCode

OpenCode auto-installs the plugin via Bun on startup. After restart, check status:

```bash
opencode-rpc info
```

For detailed setup (creating your own Discord App, advanced config), see [`docs/INSTALL.md`](./docs/INSTALL.md).

## CLI Reference

```bash
opencode-rpc <command>
```

| Command | Description |
|---------|-------------|
| `install` | Create config file from example, print setup steps |
| `uninstall` | Remove generated files (lock, output, restart signal); backup config |
| `restart` | Restart Discord desktop client + trigger plugin reload |
| `update` | Check GitHub Releases for new version, self-update |
| `info` | Show diagnostic info: paths, config, lock status, plugin registration |
| `version` | Print package version |
| `help` | Show usage |

Full reference: [`docs/CLI-REFERENCE.md`](./docs/CLI-REFERENCE.md)

## Update

```bash
opencode-rpc update
```

Checks the latest GitHub release, downloads the new tarball, and reinstalls globally. No manual steps needed.

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

Plus conditionals (`{{#if mode == "build"}}...{{/if}}`) and fallbacks (`{var|fallback}`).

See [`docs/CUSTOMIZATION.md`](./docs/CUSTOMIZATION.md) for full syntax.

## Platform Notes

Linux, macOS, and Windows are all supported. See [`docs/PLATFORM-NOTES.md`](./docs/PLATFORM-NOTES.md) for per-OS details (Flatpak/Snap detection, AppleScript quit, taskkill quirks, named pipes).

## Architecture

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full design (template engine, multi-instance coordinator, subprocess worker, restart flow).

## Troubleshooting

See [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md) for common issues on each platform.

## Requirements

- Discord Desktop App (running)
- Node.js 18+ (LTS recommended)
- OpenCode CLI

## Migration from v1.0.0

v1.0.0 used bash scripts and was Linux-only. See [CHANGELOG.md](./CHANGELOG.md) for the migration guide.

## License

MIT

---

A co-op project by Minimax M3 and DeepSeek V4 Flash.
