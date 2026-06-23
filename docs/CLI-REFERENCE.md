# CLI Reference

```
opencode-rpc <command> [options]
```

All commands work the same on Linux, macOS, and Windows. Output below shows real examples captured from the CLI.

---

## `opencode-rpc version`

Prints the installed package version.

```
$ opencode-rpc version
opencode-rich-presence v2.0.2
```

---

## `opencode-rpc help`

Prints usage summary.

```
$ opencode-rpc help

opencode-rich-presence - Discord Rich Presence plugin for OpenCode AI

Usage:
  opencode-rpc <command> [options]

Commands:
  install      Set up Rich Presence for OpenCode (creates config)
  uninstall    Remove Rich Presence configuration
  restart      Reload the plugin worker (writes restart signal, kills worker)
  update       Check for updates and upgrade
  info         Show diagnostic information
  help         Show this message
  version      Print version

Installation (one-time):
  npm install -g https://github.com/Khip01/opencode-rich-presence/releases/latest/download/opencode-rich-presence-latest.tgz
  opencode-rpc install
  # Then add "plugin": ["opencode-rich-presence"] to ~/.config/opencode/opencode.json

Update:
  opencode-rpc update

Documentation: https://github.com/Khip01/opencode-rich-presence
```

---

## `opencode-rpc install`

Creates the config file at `~/.config/opencode/discord-config.json` from the bundled example. If a config already exists, asks before overwriting. Prints setup steps.

**Example: config already exists**

```
$ opencode-rpc install

opencode-rich-presence installer

Config exists at /home/user/.config/opencode/discord-config.json. Overwrite? [y/N] Keeping existing config.

Next steps:

1. (Optional) Edit your config to set Discord App ID and templates:
   /home/user/.config/opencode/discord-config.json

2. Register the plugin with OpenCode by adding it to:
   /home/user/.config/opencode/opencode.jsonc  (file exists)

   Add this line to the file:

   {
     "plugin": ["opencode-rich-presence"]
   }

3. Start OpenCode. The plugin auto-installs via Bun and Discord presence activates.

Run `opencode-rpc info` anytime to check status.
```

If the config does not exist, the installer creates it without prompting and skips the `Overwrite?` question.

---

## `opencode-rpc uninstall`

Interactive cleanup. Walks through each generated file and asks before deleting.

```
$ opencode-rpc uninstall

opencode-rich-presence uninstaller

Step 1: Remove plugin from OpenCode config

  (or run: opencode and use /config to edit)

Step 2: Clean up generated files

  Delete /home/user/.config/opencode/.discord-restart-request? [y/N]
  Delete /home/user/.config/opencode/presence-state.txt? [y/N]
  ...

Done.
```

Type `y` to delete, just press Enter to skip.

---

## `opencode-rpc restart`

Reloads the plugin worker. Writes a restart signal that the plugin watches, then kills the worker subprocess so the plugin immediately respawns it with fresh config. Does not touch Discord Desktop.

```
$ opencode-rpc restart

opencode-rich-presence worker restart

Restart signal written: /home/user/.config/opencode/.discord-restart-request
Killed 1 worker process(es).

Current Discord config:
  Config file: /home/user/.config/opencode/discord-config.json
  App ID : 1512803991300476989
  Asset  : opencode-logo-too-rich-presence
  DISCORD_APP_ID env         : <not set>
  DISCORD_LARGE_IMAGE_KEY env: <not set>

Next steps:
Plugin detects restart signal:
  1. Waiting 2s for old IPC socket to release
  2. Reloading config
  3. Spawning new worker

Monitor with:
  tail -f ~/.config/opencode/presence-state.txt

Expected within ~7 seconds: `Discord: connected`

Note: Discord Desktop is not restarted by this command.
If Discord Desktop itself is stuck, close and reopen it manually.
```

Use this when you want to apply config changes without restarting OpenCode, or when the worker is stuck.

---

## `opencode-rpc update`

Fetches the latest release from GitHub and reinstalls globally via npm.

**Example: already up to date**

```
$ opencode-rpc update

Current version: v2.0.2
Checking for updates...

Already up-to-date (latest: v2.0.2).
```

**Example: update available**

```
$ opencode-rpc update

Current version: v2.0.1
Checking for updates...

Update available: v2.0.1 -> v2.0.2

Downloading opencode-rich-presence-2.0.2.tgz...
Installing v2.0.2...

Updated to v2.0.2.
Restart OpenCode to apply changes.
```

---

## `opencode-rpc info`

Prints diagnostic info. Sections shown depend on your setup.

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
  Output file    : /home/user/.config/opencode/presence-state.txt [1.9 KB, modified 2026-06-23T16:23:34.942Z]
  Lock file      : /home/user/.config/opencode/.opencode-rich-presence.lock [absent]
  Debug log      : /tmp/opencode-rich-presence-debug.log [absent]

Config (discord-config.json)
  App ID         : 1512...6989
  Image key      : opencode-logo-too-rich-presence
  Image text     : (default)
  Currency       : $
  Custom template: yes
```

**Sections that may appear based on state:**

- **Lock (leader instance)**: Only shown when a lock file exists (an OpenCode instance is currently the leader)
- **OpenCode plugin registration**: Only shown when `~/.config/opencode/opencode.json` or `.jsonc` is parseable. If your config has malformed JSON (uncommon), this section is skipped silently.

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
| `OPENCODE_RICH_PRESENCE_DEBUG` | Plugin | Enable verbose logging to debug log file |
| `OPENCODE_RPC_DEBUG` | CLI | Print stack traces on CLI errors |
| `OPENCODE_CONFIG_DIR` | Plugin + Worker | Override OpenCode config dir (per OpenCode docs) |
