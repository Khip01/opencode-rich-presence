# OpenCode Discord Rich Presence

Real-time Discord Rich Presence plugin for OpenCode CLI. Displays your AI session status directly in Discord.

<img src="https://github.com/user-attachments/assets/2e03f6b4-e089-4be5-9c65-baa38af39c07" alt="Discord presence preview" width="600">

## Quick Install

```bash
./install
nano ~/.config/opencode/discord-config.json    # set your Discord App ID
opencode
```

For detailed setup, see [`SETUP.md`](./SETUP.md).

## Available Variables

Customize what appears in your Discord presence using these variables:

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

Also supports **conditionals** (`{{#if mode == "build"}}...{{/if}}`), **fallbacks** (`{var|fallback}`), and **per-state templates**.

See [`docs/CUSTOMIZATION.md`](./docs/CUSTOMIZATION.md) for full syntax reference.

## Quick Customization Example

```json
{
    "discordAppId": "YOUR_APP_ID",
    "presence": {
        "details": "{model} ({mode})",
        "state": "{state} {contextCompact}",
        "byState": {
            "Typing": {
                "state": "{{#if contextPercent > 80}} {contextCompact} full{{else}}{contextCompact} ctx{{/if}}"
            }
        }
    }
}
```

## Quick Uninstall

```bash
./uninstall
```

## Documentation

| File | Description |
|---|---|
| [SETUP.md](./SETUP.md) | Setup guide, prerequisites, Discord app creation |
| [docs/CUSTOMIZATION.md](./docs/CUSTOMIZATION.md) | Full template syntax, variables, conditionals |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Internal architecture, restart mechanism, multi-instance |
| [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md) | Common issues and fixes |

## Requirements

- Discord Desktop App (running)
- Node.js 18+ or Bun
- OpenCode CLI

## License

MIT

---

*A co-op project by Minimax M3 and DeepSeek V4 Flash.*
