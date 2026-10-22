# OpenCode Rich Presence

Show your OpenCode session in Discord.

<img width="449" height="190" alt="image" src="https://github.com/user-attachments/assets/ef8233c2-aa6e-48a5-be98-e0ec58691376" />

**Current release: v3.4.0**

OpenCode Rich Presence gives your Discord profile a live view of what
OpenCode is doing. It can show the model, current activity, context
usage, cost, and elapsed time.

## Features

- Live Rich Presence for OpenCode sessions
- Stable updates when switching between OpenCode windows
- Presence returns when OpenCode is reopened
- Customizable presence templates
- Built-in activity logs for troubleshooting
- OpenCode v1 and v2 support
- Linux, macOS, and Windows support

## Requirements

- Node.js 18 or newer
- OpenCode CLI, v1 or v2
- Discord Desktop

See the [platform notes](./docs/PLATFORM-NOTES.md) for OS-specific
details.

## Installation

### Quick install

Linux, macOS, and Windows users running Git Bash, MSYS2, Cygwin, or
WSL can use the installer:

```bash
curl -fsSL https://raw.githubusercontent.com/Khip01/opencode-rich-presence/main/install.sh | bash
```

To install a specific release:

```bash
curl -fsSL https://raw.githubusercontent.com/Khip01/opencode-rich-presence/main/install.sh \
  | ORP_VERSION=v3.4.0 bash
```

### Manual install

1. Download the tarball from [GitHub Releases](https://github.com/Khip01/opencode-rich-presence/releases/latest).
2. Install it:

   ```bash
   npm install -g ./opencode-rich-presence-v3.4.0.tgz
   ```

3. Set up the plugin:

   ```bash
   opencode-rpc install
   ```

### Restart and verify

After installation or an upgrade, restart OpenCode. For the OpenCode
v2 CLI, restart its background service:

```bash
opencode service restart
opencode-rpc info
```

For OpenCode v2 Desktop, quit Desktop fully and let its backend restart.
For OpenCode v1, restart OpenCode normally.

## OpenCode v2

OpenCode v2 is supported. `opencode-rpc install` detects your OpenCode
version and links the correct plugin entry automatically.

After upgrading the package, reload the OpenCode v2 service:

```bash
opencode service restart
opencode api get /api/plugin
```

The plugin should appear with ID `opencode-rich-presence-v2` and status
`active`.

## Updating

```bash
opencode-rpc update                  # latest stable release
opencode-rpc update --stable         # force latest stable release
opencode-rpc update --dev            # latest commit on main
opencode-rpc update --ref v3.4.0     # install a specific ref
```

If an update fails, see the [troubleshooting guide](./docs/TROUBLESHOOTING.md).

## Activity log

For a quick diagnostic view:

```bash
opencode-rpc info
```

To follow activity in real time:

```bash
tail -f ~/.config/opencode/presence-activity.log
```

## CLI reference

| Command | Description |
|---|---|
| `install` | Set up the plugin and configuration |
| `uninstall` | Remove plugin-generated files |
| `on` / `off` | Enable or disable Rich Presence |
| `restart` | Restart the Rich Presence daemon |
| `kill` / `spawn` | Stop or start the daemon |
| `update` | Upgrade the package |
| `info` | Show diagnostic information |
| `version` | Show the installed version |
| `help` | Show CLI help |

See the [full CLI reference](./docs/CLI-REFERENCE.md).

## Customization

Edit the generated configuration file:

```text
~/.config/opencode/discord-config.json
```

Example:

```json
{
  "presence": {
    "details": "{modelName} | {mode}",
    "state": "{state} | {contextCompact}"
  }
}
```

See the [customization guide](./docs/CUSTOMIZATION.md) for available
variables, conditionals, and replacements.

## Documentation

- [Installation guide](./docs/INSTALL.md)
- [CLI reference](./docs/CLI-REFERENCE.md)
- [Customization guide](./docs/CUSTOMIZATION.md)
- [Troubleshooting](./docs/TROUBLESHOOTING.md)
- [Platform notes](./docs/PLATFORM-NOTES.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [Legacy migrations](./docs/LEGACY-MIGRATIONS.md)

## License

MIT
