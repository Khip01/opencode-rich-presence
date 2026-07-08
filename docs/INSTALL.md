# Installation Guide

Detailed setup for `opencode-rich-presence` v3.x.

## Prerequisites

1. **Node.js 18+** (`node --version` to check). 20+ recommended.
2. **OpenCode CLI** (the `opencode` command on PATH).
3. **Discord Desktop** (required for v3 Phase 2 push; not required
   if you only want the activity-log diagnostic surface).

## Step 1: Install the package

> **Important**: do not install via `npm install -g <repo>#<ref>`
> for the initial install. npm v11 has a bug that breaks global
> git deps: the install appears to succeed but the `opencode-rpc`
> binary is missing (`zsh: command not found: opencode-rpc`),
> including after reboots. The bug is on npm's side and cannot be
> fixed from the package. Always install from a local tarball.
> See [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md#opencode-rpc-command-not-found-after-install)
> for the full story.

Pick one installation method.

### A. Quick install (Linux, macOS, and Windows via Git Bash / MSYS2 / Cygwin / WSL, recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/Khip01/opencode-rich-presence/main/install.sh | bash
```

The script downloads the latest stable release tarball, installs it
via `npm install -g <tarball>`, and runs `opencode-rpc install` to
set up the plugin symlink and config. Pin to a specific version:

```bash
curl -fsSL https://raw.githubusercontent.com/Khip01/opencode-rich-presence/main/install.sh \
  | ORP_VERSION=v3.1.7 bash
```

If you do not have `curl`, replace it with `wget -qO- <url>` or
fetch the script manually and `bash ./install.sh`.

Windows users: the installer runs in bash. Open Git Bash (ships
with [Git for Windows](https://gitforwindows.org/)), MSYS2, or
Cygwin and run it from there. WSL users get Linux detection and
the standard install path. Pure cmd.exe / PowerShell users should
use the manual tarball install in path B.

### B. Manual install from a tarball (Linux, macOS, Windows)

1. Download the tarball from
   [GitHub Releases](https://github.com/Khip01/opencode-rich-presence/releases/latest).
   The tarball name is `opencode-rich-presence-<version>.tgz`.
2. Install it:
   ```bash
   npm install -g ./opencode-rich-presence-3.1.7.tgz
   ```
3. Continue with Step 2 below (`opencode-rpc install`).

### C. Upgrade with `opencode-rpc update` (requires prior install)

Once `opencode-rpc` is on your PATH (via path A or B), you can
upgrade without manually downloading a tarball:

```bash
opencode-rpc update                    # latest stable release tag
opencode-rpc update --ref v3.1.7 # pin to a specific tag
opencode-rpc update --dev main         # latest commit on main (developer)
opencode-rpc update --ref <branch>     # a feature branch you want to test
opencode-rpc update --repo fork/repo    # install from a fork instead
```

`update` clones the repo, runs `npm pack`, and installs the local
tarball via `npm install -g <tarball>`. This avoids the npm v11
git-dep bug because the install path is a real file, not a git
URL.

`--ref` accepts any git ref: branch name, tag, or commit SHA. Use
this for pre-release branches.

### D. From local source (for development of the plugin itself)

```bash
git clone https://github.com/Khip01/opencode-rich-presence.git
cd opencode-rich-presence
npm install
npm link
```

## Step 2: Create a Discord Application (optional)

The plugin ships with a verified App ID and asset key as defaults so
it works out-of-box. You only need your own if you want custom
branding.

If you want your own:

1. Go to https://discord.com/developers/applications.
2. Click **New Application**, give it a name (e.g., "OpenCode").
3. Copy the **Application ID**: this is your `discordAppId`.
4. (Optional) Go to **Rich Presence > Art Assets** and upload an image.
   Note the asset key.

v3 Phase 1 does not push to Discord, so the App ID and asset key are
read but not used. They will be needed when Phase 2 lands.

## Step 3: Run the installer

```bash
opencode-rpc install
```

The installer:

1. Creates `~/.config/opencode/discord-config.json` from the bundled
   example (only if missing, or after confirmation to overwrite).
2. Detects and offers to remove any stale `"opencode-rich-presence"`
   entry left in `opencode.jsonc` (or `.json`) by pre-v2.0.6 installs.
   The symlink alone is sufficient; the entry would cause OpenCode to
   attempt an npm install on every startup, returning 404.
3. Symlinks the plugin entry to
   `~/.config/opencode/plugins/opencode-rich-presence.js`. v2.x also
   installed `@xhayper/discord-rpc` under
   `~/.config/opencode/node_modules/`; v3 Phase 1 has no runtime
   dependencies so this step is gone.

The symlink approach works around the fact that the package is not on
the npm registry: OpenCode loads the plugin directly from disk instead
of trying to fetch it via Bun and getting a 404.

If your config does not yet have a Discord App ID, the installer will
suggest editing it:

```bash
nano ~/.config/opencode/discord-config.json
```

## Step 4: Verify and restart OpenCode

```bash
opencode-rpc info
```

You should see `OpenCode plugin symlink` with `Linked: yes` and a
`Target:` pointing to the package entry file in your npm prefix. The
last 30 lines of the activity log appear at the bottom of the output.

Start OpenCode and check Discord. Your AI session should appear as
a rich presence within a few seconds. For a closer look at what the
plugin is doing (handy if Discord does not update):

```bash
tail -f ~/.config/opencode/presence-activity.log
```

```bash
opencode
```

## Updating

```bash
opencode-rpc update                  # upgrade to latest stable release (if newer)
opencode-rpc update --stable         # force install latest stable tag (switch off dev)
opencode-rpc update --dev            # upgrade to latest commit on main (developer)
opencode-rpc update --ref REF        # install a specific branch, tag, or commit SHA
```

Fetches the chosen ref from GitHub, then clones the repo, runs
`npm pack`, and installs the resulting local tarball via
`npm install -g <path>.tgz`. This avoids npm v11's git-dep symlink bug
(which produces broken symlinks at `lib/node_modules/opencode-rich-presence/`
and fails with `ENOTDIR` on subsequent installs). `--stable` skips
version comparison and always installs the latest tag, useful for
switching back from `--dev` mode. `--ref <REF>` is the recommended way
to install a pre-release branch (e.g. `--ref feature/some-branch`).
All four flags are mutually exclusive. Restart OpenCode afterwards.

## Uninstalling

```bash
opencode-rpc uninstall    # removes plugin-generated files + symlink
npm uninstall -g opencode-rich-presence    # removes the package globally
```

The uninstaller automatically removes:

- Runtime files (legacy lock, presence-state.txt, restart signal)
- The activity log and any per-instance state files (v3 Phase 1+)
- Local plugin symlink at
  `~/.config/opencode/plugins/opencode-rich-presence.js`
- `@xhayper/discord-rpc` from `~/.config/opencode/package.json` and
  `node_modules` (v2.x only; v3 Phase 1 has no runtime deps)
- Any stale `"opencode-rich-presence"` entry left in
  `~/.config/opencode/opencode.jsonc` (or `.json`). Without this
  cleanup, OpenCode would attempt an npm install on every startup and
  return 404.

You will be asked before `discord-config.json` is deleted (default N),
with a timestamp-suffixed backup if you agree.

To complete uninstall, also remove the package itself with
`npm uninstall -g opencode-rich-presence`.

## Migration from v1.0.0

v1.0.0 used bash scripts (`install`, `uninstall`, `restart-discord.sh`)
and was Linux-only.

1. Back up `~/.config/opencode/discord-config.json`.
2. Install the latest v3.x release via the steps above.
3. Run `opencode-rpc install` to set up the new config file.
4. Restore your settings into the new config (App ID, presence
   templates).
5. Remove the old v1.0.0 leftovers from `~/.config/opencode/`:
   ```bash
   rm -rf ~/.config/opencode/plugins/opencode-dc-too-rich-presence.js
   rm -f ~/.config/opencode/discord-worker.mjs
   rm -f ~/.config/opencode/restart-discord.sh
   rm -f ~/.config/opencode/package.json ~/.config/opencode/package-lock.json
   rm -f ~/.config/opencode/CUSTOMIZATION.md ~/.config/opencode/README.md ~/.config/opencode/SETUP.md
   ```
6. Restart OpenCode.

The plugin name changed from `opencode-dc-too-rich-presence` to
`opencode-rich-presence`.

## Migration from v2.x

v2.x is end-of-life. The upgrade path is the same as a fresh
install:

1. Uninstall the v2.x package: `npm uninstall -g opencode-rich-presence`
2. Remove any leftover state:
   ```bash
   rm -f ~/.config/opencode/.opencode-rich-presence.lock
   rm -f ~/.config/opencode/discord-worker.mjs
   rm -f ~/.config/opencode/package.json ~/.config/opencode/package-lock.json
   ```
3. Install v3.x via Step 1 above (curl installer recommended).
4. Run `opencode-rpc install` and answer `Y` to remove any stale
   `opencode-rich-presence` entry from `opencode.jsonc` / `opencode.json`.
5. Restart OpenCode.

## Troubleshooting

If something looks wrong after install:

1. Run `opencode-rpc info`. It shows the plugin symlink target,
   the config (App ID masked), the daemon socket/PID status, and
   the last 30 entries of the activity log.
2. For real-time monitoring: `tail -f
   ~/.config/opencode/presence-activity.log`. The log records every
   event the plugin sees, every daemon message, and every push
   attempt.
3. For the full diagnostic checklist and known root causes, see
   [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md).

