# CLI Reference

```
opencode-rpc <command> [options]
```

All commands work the same on Linux, macOS, and Windows. Output below
shows real examples captured from the CLI.

This reference documents both the v2.x line (Discord push) and the
v3 Phase 1 redesign (no Discord push, activity log instead). Where
the commands behave differently between versions, the difference is
called out in each section.

---

## `opencode-rpc version`

Prints the installed package version, plus the install channel
(stable tag or dev commit) read from a `.install-channel` marker
file inside the installed package. The marker is written by
`opencode-rpc update` (any path) and bootstrapped on the first CLI
run after a fresh install. Pre-v2.0.9 installs without a marker
show just the version (no suffix).

```
$ opencode-rpc version
opencode-rich-presence v2.1.1 (stable)
```

```
$ opencode-rpc update --dev    # switch to dev channel
...
$ opencode-rpc version
opencode-rich-presence v2.1.1 (dev: eac311d)
```

v3 Phase 1 prints the same format with version `3.0.0-phase1`.

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

Options (update):
  --dev        Install latest commit from main branch (developer)
  --stable     Force install latest stable tag (use to switch off dev)

Installation (one-time):
  npm install -g Khip01/opencode-rich-presence#v2.1.1
  opencode-rpc install

  # Or install from main (dev / bleeding-edge):
  npm install -g Khip01/opencode-rich-presence
  opencode-rpc install

Update:
  opencode-rpc update                  # latest stable release tag
  opencode-rpc update --dev            # latest commit on main (developer)
  opencode-rpc update --stable         # latest stable tag (any state)

Documentation: https://github.com/Khip01/opencode-rich-presence
```

---

## `opencode-rpc install`

Sets up the Rich Presence plugin for OpenCode.

**v2.x:** Performs three things:

1. Writes `~/.config/opencode/discord-config.json` (only if missing,
   or after confirmation to overwrite).
2. (v2.0.6+) Detects and offers to remove any stale
   `"opencode-rich-presence"` entry left in `opencode.jsonc` from
   pre-v2.0.6 installs.
3. Symlinks the plugin entry to
   `~/.config/opencode/plugins/opencode-rich-presence.js` and
   ensures `@xhayper/discord-rpc` is installed under
   `~/.config/opencode/node_modules/`.

**v3 Phase 1:** Same as v2.x except step 3 no longer installs the
`@xhayper/discord-rpc` npm dependency. Phase 1 has no runtime
dependencies.

**Example: fresh install**

```
$ opencode-rpc install

opencode-rich-presence installer
Phase 1: local state collector + activity log (no Discord push yet).

Creating OpenCode config directory: /home/user/.config/opencode
Created /home/user/.config/opencode/discord-config.json.

  Linked /home/user/.config/opencode/plugins/opencode-rich-presence.js
    -> /home/user/.nvm/versions/node/v24/lib/node_modules/opencode-rich-presence/src/plugin/index.js

Next steps:

1. Restart OpenCode. The plugin loads from a symlink at:
   ~/.config/opencode/plugins/opencode-rich-presence.js
   pointing to the installed package entry file in your npm prefix.

Run `opencode-rpc info` anytime to check status.
```

---

## `opencode-rpc uninstall`

Removes plugin-generated files. Steps:

1. Removes runtime files (legacy lock, presence-state.txt, restart
   signal).
2. v3 Phase 1: also removes the activity log and any
   per-instance state files.
3. Removes the local plugin symlink at
   `~/.config/opencode/plugins/opencode-rich-presence.js`.
4. v2.x: removes `@xhayper/discord-rpc` from
   `~/.config/opencode/package.json` and re-runs `npm install` to
   prune from `node_modules`.
5. Asks before deleting `discord-config.json` (default N). Backup
   with timestamp suffix if user agrees.
6. Removes any stale `"opencode-rich-presence"` entry left in
   `opencode.jsonc` (or `.json`).

After this, run `npm uninstall -g opencode-rich-presence` to
remove the package globally.

```
$ opencode-rpc uninstall

opencode-rich-presence uninstaller

Cleaning up plugin-generated runtime files:
  removed /home/user/.config/opencode/.opencode-rich-presence.lock
  removed /home/user/.config/opencode/presence-state.txt
  removed /home/user/.config/opencode/presence-activity.log
  removed /home/user/.config/opencode/presence-state-pid12345.txt
  removed /home/user/.config/opencode/plugins/opencode-rich-presence.js
  removed "opencode-rich-presence" entry from /home/user/.config/opencode/opencode.jsonc

Delete /home/user/.config/opencode/discord-config.json? [y/N] n
  Kept. The file remains at /home/user/.config/opencode/discord-config.json.

Final cleanup (run manually if you want a full uninstall):
  npm uninstall -g opencode-rich-presence    (removes the CLI globally)

Done. Removed 6 plugin-generated file(s).
```

---

## `opencode-rpc restart`

**v2.x:** Writes a restart signal and kills the worker subprocess.
The plugin respawns the worker within about 7 seconds and reconnects
to Discord. Does NOT touch Discord Desktop.

**v3 Phase 1:** No worker subprocess. Rotates the activity log
(renames `presence-activity.log` to `presence-activity.log.prev`)
so the next OpenCode launch starts fresh.

```
$ opencode-rpc restart

opencode-rich-presence restart (Phase 1)

Phase 1 has no Discord worker. This command rotates the activity log so
the next OpenCode launch starts with a clean history.

Moved /home/user/.config/opencode/presence-activity.log
       to /home/user/.config/opencode/presence-activity.log.prev

Next steps:
  1. Restart OpenCode so it reloads the plugin and starts writing to a fresh log.
  2. tail -f /home/user/.config/opencode/presence-activity.log  to follow the next session.
```

---

## `opencode-rpc update`

Upgrades the installed package. Three modes:

| Mode | What it does |
|------|--------------|
| default | Compare current version against latest stable release tag. If newer, install. |
| `--dev` | Skip version check. Install latest commit on `main`. |
| `--stable` | Skip version check. Install latest stable release tag. |

`--stable` and `--dev` are mutually exclusive. Passing both exits
with code 2 and a clear error message (POSIX Guideline 11).

Internally, all three modes clone the repo, fetch the requested
ref, run `npm pack`, and install the resulting local tarball via
`npm install -g <path>.tgz`. This avoids npm v11's git-dep symlink
bug which produces broken symlinks and `ENOTDIR` on subsequent
installs.

**Example: stable update**

```
$ opencode-rpc update

opencode-rich-presence update

Current: v2.1.1
Latest:  v2.1.1
You are already on the latest stable release.
```

**Example: dev update**

```
$ opencode-rpc update --dev

opencode-rich-presence update (--dev)

Current: v2.1.1 (stable)
Latest:  eac311d (latest commit on main)
Installing dev build (eac311d)...

Cloning repo...
Fetched eac311d.
Packaging...
Installed opencode-rich-presence@eac311d (dev).

Restart OpenCode to load the new build.
```

---

## `opencode-rpc info`

Prints diagnostics. Sections:

- **Environment**: Platform, Node.js, executable path.
- **Paths**: OpenCode dir, config file, default state file, activity
  log, legacy lock, debug log.
- **Config**: Discord App ID (masked), image key, image text,
  currency, presence template customisation status.
- **Legacy lock** (v2.x artifact): PID, start time, age. Shown as
  informational only in v3 Phase 1 (the lock is no longer used).
- **OpenCode plugin symlink**: Linked yes/no, target path.
- **Per-instance state files** (v3 Phase 1): One entry per running
  OpenCode instance.
- **Activity log tail** (v3 Phase 1): Last 30 entries of the
  chronological activity log.

```
$ opencode-rpc info

opencode-rich-presence - diagnostics
==================================================

Environment
  Platform       : linux (linux)
  Node.js        : v24.13.1
  Exec           : /home/khip/.nvm/versions/node/v24.13.1/bin/node

Paths
  OpenCode dir   : /home/khip/.config/opencode
  Config         : /home/khip/.config/opencode/discord-config.json [exists]
  Default state  : /home/khip/.config/opencode/presence-state.txt [missing]
  Activity log   : /home/khip/.config/opencode/presence-activity.log [12.3 KB, tail 30 lines below]
  Legacy lock    : /home/khip/.config/opencode/.opencode-rich-presence.lock [absent]
  Debug log      : /tmp/opencode-rich-presence-debug.log [218.4 KB]

Config (discord-config.json)
  App ID         : 1512...6989
  Image key      : opencode-logo-too-rich-presence
  Image text     : (default)
  Currency       : $
  Custom template: yes

OpenCode plugin symlink
  Path           : /home/khip/.config/opencode/plugins/opencode-rich-presence.js
  Linked         : yes
  Target         : /home/khip/.nvm/versions/node/v24.13.1/lib/node_modules/opencode-rich-presence/src/plugin/index.js

Per-instance state files (2)
  presence-state-pid12345.txt  [1.8 KB, modified 2026-07-05T15:00:00.000Z]
  presence-state-pid23456.txt  [1.8 KB, modified 2026-07-05T15:01:00.000Z]

Activity log (last 30 entries)
--------------------------------------------------
  [2026-07-05 15:00:30.123] [pid 12345] [load] plugin loaded workdir=/home/user/project
  [2026-07-05 15:00:30.456] [pid 12345] [config] appId=1512803991300476989 key=opencode-logo-too-rich-presence currency=$
  [2026-07-05 15:00:30.789] [pid 12345] [event] chat.message sid=test_aaaaaa agent=build model=minimax-m3 mode=build
  [2026-07-05 15:00:30.790] [pid 12345] [state] sid=test_aaaaaa Waiting for command -> Working (chat.message)
  ... (26 more lines)
--------------------------------------------------
Full log: /home/khip/.config/opencode/presence-activity.log
```

---

## `opencode-rpc help` (alias `--help` / `-h`)

Same as the default help output (no arguments case).

---

## `opencode-rpc version` (alias `--version` / `-v`)

Same as the explicit version output.
