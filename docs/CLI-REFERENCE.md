# CLI Reference

```
opencode-rpc <command> [options]
```

All commands work the same on Linux, macOS, and Windows.

---

## `opencode-rpc install`

Creates the Discord Rich Presence config file at `~/.config/opencode/discord-config.json` from the bundled example, then prints setup steps.

**Behavior:**
- Creates `~/.config/opencode/` directory if missing.
- If `discord-config.json` exists, asks before overwriting.
- Prints the OpenCode config edit instructions.

**Example:**
```
$ opencode-rpc install

opencode-rich-presence installer

Creating OpenCode config directory: /home/user/.config/opencode
Created /home/user/.config/opencode/discord-config.json

Next steps:

1. (Optional) Edit your config to set Discord App ID and templates:
   /home/user/.config/opencode/discord-config.json

2. Register the plugin with OpenCode by adding it to:
   /home/user/.config/opencode/opencode.json
   ...
```

---

## `opencode-rpc uninstall`

Interactive cleanup. Walks through each generated file and asks before deleting.

**Behavior:**
- Removes the plugin entry hint from `opencode.json` (manual edit required).
- Asks before deleting: lock file, restart signal, output file.
- Asks before deleting (with backup) the main config file.
- Prints the `npm uninstall -g` command to remove the CLI.

**Example:**
```
$ opencode-rpc uninstall

opencode-rich-presence uninstaller

Step 1: Remove plugin from OpenCode config
  ...

Step 2: Clean up generated files
  Delete /home/user/.config/opencode/.opencode-rich-presence.lock? [y/N]
  ...

Step 3: Remove CLI globally (optional)
  npm uninstall -g opencode-rich-presence
```

---

## `opencode-rpc restart`

Triggers a Discord desktop client restart and signals the plugin to reload.

**Behavior:**
- Writes a restart signal file (`~/.config/opencode/.discord-restart-request`).
- Asks if you also want to restart the Discord desktop client.
- If yes: kills Discord via platform-specific command, relaunches from common install paths.

**Platform implementations:**

| OS | Kill command | Relaunch |
|---|---|---|
| Linux | `kill -TERM/-KILL <pids>` | `/usr/bin/discord`, `/opt/discord/discord`, Flatpak, Snap |
| macOS | `osascript` (AppleScript) + `pkill -x Discord` fallback | `open -a Discord` |
| Windows | `taskkill /IM Discord.exe /T /F` | `cmd /c start "" Discord` |

**Example:**
```
$ opencode-rpc restart

Restarting Discord desktop client...

Wrote restart signal: /home/user/.config/opencode/.discord-restart-request

Also restart the Discord desktop app now? [Y/n] y

Discord restart triggered.
```

---

## `opencode-rpc update`

Checks GitHub Releases for the latest version, downloads the new tarball, and reinstalls globally via npm.

**Behavior:**
- Fetches `https://api.github.com/repos/Khip01/opencode-rich-presence/releases/latest`.
- Compares semver versions.
- If newer version exists: downloads `.tgz` asset to temp dir, runs `npm install -g <tgz>`, cleans up.
- Prints the new version and reminds to restart OpenCode.

**Example:**
```
$ opencode-rpc update

Current version: v2.0.0
Checking for updates...

Update available: v2.0.0 -> v2.0.1

Downloading opencode-rich-presence-2.0.1.tgz...
Installing v2.0.1...

Updated to v2.0.1.
Restart OpenCode to apply changes.
```

---

## `opencode-rpc info`

Prints diagnostic info: paths, config status, lock file state, OpenCode plugin registration.

**Example:**
```
$ opencode-rpc info

opencode-rich-presence - diagnostics
==================================================

Environment
  Platform       : linux (linux)
  Node.js        : v20.10.0
  Exec           : /usr/bin/node

Paths
  OpenCode dir   : /home/user/.config/opencode
  Config         : /home/user/.config/opencode/discord-config.json [exists]
  Output file    : /home/user/.config/opencode/presence-state.txt [1.2 KB, modified ...]
  Lock file      : /home/user/.config/opencode/.opencode-rich-presence.lock [present]
  Debug log      : /tmp/opencode-rich-presence-debug.log [0 B]

Config (discord-config.json)
  App ID         : 1512...6989
  Image key      : opencode-logo-too-opencode-rpc
  Image text     : OpenCode
  Currency       : $
  Custom template: no

Lock (leader instance)
  PID            : 12345
  Started        : 2026-06-23T...
  Age            : 42s
  Status         : YOU are leader

OpenCode plugin registration
  Status         : REGISTERED in opencode.json
```

---

## `opencode-rpc version`

Prints package name and version.

```
$ opencode-rpc version
opencode-rich-presence v2.0.0
```

---

## `opencode-rpc help`

Prints usage summary.

---

## Global Options

Currently no global flags. Reserved for future use:

| Flag | Description |
|------|-------------|
| `--debug` | Enable verbose logging to stdout and debug log file |
| `--config <path>` | Override config file path (for testing) |

To enable debug logging today, set the env var:
```bash
OPENCODE_RICH_PRESENCE_DEBUG=true opencode
```

---

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error (file write failed, network error, etc.) |
| 2 | Unknown command |

---

## Environment Variables

| Variable | Used by | Description |
|----------|---------|-------------|
| `DISCORD_APP_ID` | Plugin + Worker | Override App ID (highest priority over config file) |
| `DISCORD_LARGE_IMAGE_KEY` | Plugin | Override Discord asset key |
| `DISCORD_LARGE_IMAGE_TEXT` | Plugin | Override asset hover text |
| `OPENCODE_RICH_PRESENCE_DEBUG` | Plugin | Enable verbose logging |
| `OPENCODE_CONFIG_DIR` | Plugin + Worker | Override OpenCode config dir (per OpenCode docs) |
