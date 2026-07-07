# Installation Guide

Detailed setup for `opencode-rich-presence` v2.1.1+ and v3.x Phase 1.

> **zsh users**: zsh treats `#` as a glob qualifier, so the unquoted commands below error with `zsh: no matches found: Khip01/opencode-rich-presence#v2.1.1`. Always wrap the URL in single quotes:
>
> ```bash
> npm install -g 'Khip01/opencode-rich-presence#v2.1.1'
> ```
>
> bash and fish users can run the unquoted form. This is a zsh shell issue, not an npm issue.

## Prerequisites

1. **OpenCode CLI** installed and working.
2. **Node.js 18+** (`node --version` to check). 20+ recommended.
3. **Discord Desktop** (v2.x only; not required for v3 Phase 1). Phase 2 will reintroduce this requirement.

## Step 1: Install the package

Pick one installation method.

### A. Latest stable release (recommended for end users)

```bash
opencode-rpc update                  # latest stable release tag
opencode-rpc install                 # link the plugin to OpenCode
```

This is the cleanest path. `update` clones the repo, packs a tarball,
and installs it via `npm install -g <path>.tgz`, which sidesteps the
npm v11 git-dep bug described below.

### B. From a specific release tag

```bash
  opencode-rpc update --ref v3.1.3-phase2
opencode-rpc install
```

Use this when you want a specific version (reproducibility, downgrade,
or staying on a known-good release).

### C. Dev branch (e.g. a feature branch you want to test)

```bash
opencode-rpc update --ref redesign/v3-daemon
opencode-rpc install
```

`--ref` accepts any git ref: branch name, tag, or commit SHA. Use
this for pre-release branches.

> **Do NOT use `npm install -g <url>#<branch>` for branches.** npm v11
> has a bug installing git deps with `#ref` for global packages: the
> install creates a partial directory at
> `lib/node_modules/opencode-rich-presence/` (only `src/`, no
> `package.json`, no `bin/`) and never creates the
> `~/.nvm/.../bin/opencode-rpc` symlink. You would then see
> `zsh: command not found: opencode-rpc` even though npm reported
> "added 1 package". `opencode-rpc update --ref <branch>` avoids this
> bug by installing from a local tarball.

### D. Latest commit on main (no specific ref)

```bash
opencode-rpc update --dev
opencode-rpc install
```

Equivalent to `--ref main`. Use this for the absolute newest changes
before they are tagged.

### E. From local source (for development of the plugin itself)

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

For v2.x: start OpenCode and check Discord. Your AI session should
appear as a rich presence within a few seconds.

For v3 Phase 1: start OpenCode and `tail -f
~/.config/opencode/presence-activity.log`. The log shows every event
the plugin sees and what it would push to Discord.

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
to install a pre-release branch (e.g. `--ref redesign/v3-daemon`).
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
2. Install v2.1.1 via the steps above.
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

## Troubleshooting

For v2.x (Discord push):

1. Run `opencode-rpc info` and check that the plugin symlink is
   present, the lock file exists, and Discord is reported as
   `connected`.
2. Verify Discord Desktop is running.
3. Check the debug log: `cat $(opencode-rpc info | grep "Debug log" | awk '{print $3}')`.
4. See [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) for the diagnostic
   checklist and known root causes.

For v3 Phase 1 (no Discord push):

1. Run `opencode-rpc info` and check the activity log tail at the
   bottom of the output. This shows the last 30 entries the plugin
   recorded.
2. For real-time monitoring: `tail -f ~/.config/opencode/presence-activity.log`.
3. See [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) for Phase 1
   specific guidance.

