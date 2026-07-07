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
  --dev [BRANCH]  Install latest commit on BRANCH (default: main).
                  IMPORTANT: --dev defaults to the upstream `main`
                  branch, which is currently v2.1.1 (pre-redesign).
                  If you are on v3, pass the branch explicitly or
                  you will be downgraded to v2.x:
                    opencode-rpc update --dev redesign/v3-daemon
  --stable         Force install latest stable tag (use to switch off dev)
  --ref REF        Install a specific git ref: tag, branch, or commit SHA.
                   Use this for pre-release branches (e.g.
                   --ref redesign/v3-daemon). Avoids the npm v11
                   git-dep symlink bug that breaks `npm install -g
                   <url>#<branch>` for global packages. Supports any
                   git ref including short SHAs (`--ref 6664bfb`) and
                   full SHAs (`--ref 6664bfb0ba316180fa08617dcb04ee1b59599e7f`).
  --repo OWNER/REPO  Install from a fork instead of the upstream repo.
                    Use this to test changes in your own fork before
                    opening a PR. Combine with --dev, --stable, or --ref.
                    Format: OWNER/REPO (letters, digits, `.`, `_`, `-`).

Installation (one-time):
  # Recommended (sidesteps npm v11 git-dep bug):
  opencode-rpc update                  # latest stable
  opencode-rpc install

  # Specific version:
  opencode-rpc update --ref v3.0.4-phase2
  opencode-rpc install

  # Specific branch:
  opencode-rpc update --ref redesign/v3-daemon
  opencode-rpc install

  # Track a pre-release branch (latest commit):
  opencode-rpc update --dev redesign/v3-daemon
  opencode-rpc install

  # Specific commit SHA:
  opencode-rpc update --ref 471ce94
  opencode-rpc install

  # Install from your own fork:
  opencode-rpc update --repo myname/opencode-rich-presence --ref my-branch
  opencode-rpc install

  # Or, for npmjs registry / stable tag with npm (zsh needs quotes):
  npm install -g 'Khip01/opencode-rich-presence#v3.0.4-phase2'
  opencode-rpc install

  # Or default branch tip:
  npm install -g Khip01/opencode-rich-presence
  opencode-rpc install

Update:
  opencode-rpc update                  # latest stable release tag
  opencode-rpc update --dev            # latest commit on main (developer)
  opencode-rpc update --stable         # latest stable tag (any state)
  opencode-rpc update --ref REF        # specific ref (branch/tag/SHA)

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

Upgrades the installed package. Five modes:

| Mode | What it does |
|------|--------------|
| default | Compare current version against latest stable release tag. If newer, install. |
| `--dev [BRANCH]` | Skip version check. Install latest commit on BRANCH. Defaults to `main`, which is currently v2.1.1 (pre-redesign); pass the branch explicitly if you are on v3. |
| `--stable` | Skip version check. Install latest stable release tag. |
| `--ref REF` | Install a specific git ref: tag, branch, or commit SHA. Supports any ref including short SHAs (`6664bfb`) and full SHAs (`6664bfb0ba316180fa08617dcb04ee1b59599e7f`). |
| `--repo OWNER/REPO` | Install from a fork instead of the upstream repo. Combine with `--dev`, `--stable`, or `--ref`. |

`--stable`, `--dev`, and `--ref` are mutually exclusive. Passing any
two exits with code 2 and a clear error message (POSIX Guideline 11).
`--ref` requires a value: `opencode-rpc update --ref` alone errors
out.

The `--ref` mode is the recommended way to install pre-release
branches like `redesign/v3-daemon`. Do NOT use the equivalent
`npm install -g <url>#<branch>` form: npm v11 has a bug installing
git deps with `#ref` for global packages that creates a partial
directory at `lib/node_modules/opencode-rich-presence/` (only `src/`,
no `package.json`, no `bin/`) and never creates the
`~/.nvm/.../bin/opencode-rpc` symlink. You would then see
`zsh: command not found: opencode-rpc` even though npm reported
"added 1 package".

Internally, all five modes clone the repo, check out the requested
ref (or fetch the latest commit for `--dev`), run `npm pack`, and
install the resulting local tarball via `npm install -g <path>.tgz`.
This avoids npm v11's git-dep symlink bug which produces broken
symlinks and `ENOTDIR` on subsequent installs.

The clone is a full clone (no `--depth=1`) so commit SHAs work
without special handling. `git checkout <ref>` handles branch names,
tag names, and SHAs (full or short) uniformly. Cleanup of the
previous install is deferred until AFTER the tarball is built, so a
failed fetch leaves the existing CLI intact instead of removing it.

**Example: stable update**

```
$ opencode-rpc update

opencode-rich-presence update

Current: v2.1.1
Latest:  v2.1.1
You are already on the latest stable release.
```

**Example: dev update (track a specific branch)**

```
$ opencode-rpc update --dev redesign/v3-daemon

opencode-rich-presence update (--dev redesign/v3-daemon)

Current: v3.1.1-phase2 (dev: redesig)
Latest:  471ce94 (latest commit on redesign/v3-daemon)
Installing dev build (471ce94)...

Cloning repo...
Checked out 471ce94.
Packaging...
Installed opencode-rich-presence@471ce94 (dev).

Restart OpenCode to load the new build.
```

`--dev` without a branch name defaults to `main`, which is
currently v2.1.1 (pre-redesign). If you are on v3, pass the branch
explicitly to avoid an unwanted downgrade.

**Example: install a specific branch**

```
$ opencode-rpc update --ref redesign/v3-daemon

opencode-rich-presence update (--ref)

Current: v3.0.4-phase2 (stable)
Treating as channel=dev for version reporting.

Cloning repo...
Fetched redesign/v3-daemon.
Packaging...
Installed opencode-rich-presence@redesign/v3-daemon (dev).

Restart OpenCode to load the new build.
```

`--ref` works with any git ref the repo exposes: a tag
(`--ref v3.0.4-phase2`), a branch (`--ref redesign/v3-daemon`), a
short commit SHA (`--ref 6664bfb`), or a full commit SHA
(`--ref 6664bfb0ba316180fa08617dcb04ee1b59599e7f`). The channel
label written to the `.install-channel` marker is inferred from the
ref: refs matching a semver pattern are labelled `stable`, anything
else is `dev`. You can verify the channel with `opencode-rpc version`.

**Example: install from a fork**

```
$ opencode-rpc update --repo myname/opencode-rich-presence --ref my-branch

opencode-rich-presence update (--ref my-branch)
Source repo:    myname/opencode-rich-presence

Current: v3.1.1-phase2 (stable)
Treating as channel=dev for version reporting.

Cloning repo...
Checked out my-branch.
Packaging...
Installed opencode-rich-presence@myname/opencode-rich-presence@my-branch (dev).

Restart OpenCode to load the new build.
```

`--repo OWNER/REPO` switches the GitHub repo the install pulls from.
Combine with `--dev`, `--stable`, or `--ref` to pick a branch.
Format: `OWNER/REPO` (letters, digits, `.`, `_`, `-`).

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
