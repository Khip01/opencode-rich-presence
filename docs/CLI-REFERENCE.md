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
opencode-rich-presence v2.0.5
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
  # Plugin loads from ~/.config/opencode/plugins/opencode-rich-presence.js (symlink)

Update:
  opencode-rpc update

Documentation: https://github.com/Khip01/opencode-rich-presence
```

---

## `opencode-rpc install`

Sets up the Discord Rich Presence plugin for OpenCode. Performs three things:

1. Writes `~/.config/opencode/discord-config.json` (only if missing, or after confirmation to overwrite).
2. (v2.0.6+ only) If `opencode.jsonc` (or `.json`) still has a v2.0.5-era `"opencode-rich-presence"` entry from an earlier install, the installer offers to remove it. That entry made OpenCode try to fetch the package from the npm registry on every startup, returning 404. The symlink alone is sufficient.
3. Symlinks the plugin entry to `~/.config/opencode/plugins/opencode-rich-presence.js` and ensures `@xhayper/discord-rpc` is installed under `~/.config/opencode/node_modules/`.

The symlink approach works around the fact that the package is not on the npm registry: OpenCode loads the plugin directly from disk instead of trying to fetch it via Bun and getting a 404.

**Example: fresh install (no stale opencode.jsonc entry, no existing config)**

```
$ opencode-rpc install

opencode-rich-presence installer

Created /home/user/.config/opencode/discord-config.json.

  Linked /home/user/.config/opencode/plugins/opencode-rich-presence.js
    -> /home/user/.nvm/versions/node/v22/lib/node_modules/opencode-rich-presence/src/plugin/index.js

  Updated /home/user/.config/opencode/package.json (added @xhayper/discord-rpc)
  Running npm install in /home/user/.config/opencode...
  Installed dependencies.

Next steps:

1. Restart OpenCode. The plugin loads from a symlink at:
   ~/.config/opencode/plugins/opencode-rich-presence.js
   pointing to the installed package entry file in your npm prefix.

Run `opencode-rpc info` anytime to check status.
```

**Example: upgrade from v2.0.5 with stale opencode.jsonc entry**

```
$ opencode-rpc install

opencode-rich-presence installer

Config exists at /home/user/.config/opencode/discord-config.json. Overwrite? [y/N] Keeping existing config.

  Remove stale "opencode-rich-presence" entry from /home/user/.config/opencode/opencode.jsonc? (causes npm 404 on OpenCode startup) [Y/n]   Updated /home/user/.config/opencode/opencode.jsonc

  Plugin already linked at /home/user/.config/opencode/plugins/opencode-rich-presence.js

  @xhayper/discord-rpc already present in /home/user/.config/opencode/package.json

Next steps:

1. Restart OpenCode. The plugin loads from a symlink at:
   ~/.config/opencode/plugins/opencode-rich-presence.js
   pointing to the installed package entry file in your npm prefix.

Run `opencode-rpc info` anytime to check status.
```

---

## `opencode-rpc uninstall`

Cleans up everything the plugin generated or installed. No prompts for runtime files, symlink, or dependency. Asks Y/N before deleting `discord-config.json` (default N). Auto-removes any stale `"opencode-rich-presence"` entry left in `opencode.jsonc` (or `.json`) by a v2.0.5-era install, so the user does not carry a noisy 404 notification after uninstalling.

```
$ opencode-rpc uninstall

opencode-rich-presence uninstaller

Cleaning up plugin-generated runtime files:
  removed /home/user/.config/opencode/.opencode-rich-presence.lock
  removed /home/user/.config/opencode/presence-state.txt
  removed /home/user/.config/opencode/plugins/opencode-rich-presence.js
  removed @xhayper/discord-rpc from /home/user/.config/opencode/package.json
  running npm install to prune @xhayper/discord-rpc from node_modules...
  removed "opencode-rich-presence" entry from /home/user/.config/opencode/opencode.jsonc

Delete /home/user/.config/opencode/discord-config.json? [y/N]   Kept. The file remains at /home/user/.config/opencode/discord-config.json.

Final cleanup (run manually if you want a full uninstall):
  npm uninstall -g opencode-rich-presence    (removes the CLI globally)

Done. Removed 4 plugin-generated file(s).
```

If you answer `y` to the config prompt, the file is renamed to `discord-config.json.backup-<timestamp>` (persistent in your home dir, NOT in `/tmp`).

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

Current version: v2.0.5
Checking for updates...

Already up-to-date (latest: v2.0.5).
```

**Example: update available**

```
$ opencode-rpc update

Current version: v2.0.4
Checking for updates...

Update available: v2.0.4 -> v2.0.5

Downloading opencode-rich-presence-2.0.5.tgz...
Installing v2.0.5...

Updated to v2.0.5.
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

OpenCode plugin symlink
  Path           : /home/user/.config/opencode/plugins/opencode-rich-presence.js
  Linked         : yes
  Target         : /home/user/.nvm/versions/node/v22/lib/node_modules/opencode-rich-presence/src/plugin/index.js
```

**Sections that may appear based on state:**

- **Lock (leader instance)**: Only shown when a lock file exists (an OpenCode instance is currently the leader).
- **OpenCode plugin symlink**: Always shown. Reports whether the plugin entry is symlinked at `~/.config/opencode/plugins/opencode-rich-presence.js` and what its target is. v2.0.6+ uses the symlink as the sole load mechanism (the entry in `opencode.jsonc` is no longer required and would cause a 404 noise on every OpenCode startup).

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
