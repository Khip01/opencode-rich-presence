# Installation Guide

Detailed setup for `opencode-rich-presence` v2.1.0+.

## Prerequisites

1. **OpenCode CLI** installed and working.
2. **Node.js 18+** (`node --version` to check). 20+ recommended.
3. **Discord Desktop** installed and running on the same machine.

## Step 1: Install the package

Pick one installation method.

### A. From a specific release tag (recommended for end users)

```bash
npm install -g Khip01/opencode-rich-presence#v2.1.0
```

This installs the `opencode-rpc` CLI globally from the v2.1.0 tag. `npm` clones the repo at that tag and installs from there. No separate tarball download is needed.

### B. Latest stable release

```bash
npm install -g Khip01/opencode-rich-presence#semver:^2.0.0
```

`npm` finds the latest tag matching `^2.0.0` (e.g. v2.1.0) and installs from that. Pin to a specific tag (option A) for reproducibility.

### C. Dev / bleeding-edge (latest commit on main)

```bash
npm install -g Khip01/opencode-rich-presence
```

No `#ref` means `npm` uses the default branch (main), i.e. the latest commit. Use this if you want the newest features/fixes before they are tagged.

### D. From local source (for development)

```bash
git clone https://github.com/Khip01/opencode-rich-presence.git
cd opencode-rich-presence
npm install
npm link
```

## Step 2: Create a Discord Application (optional)

The plugin ships with a verified App ID and asset key as defaults so it works out-of-box. You only need your own if you want custom branding.

If you want your own:

1. Go to https://discord.com/developers/applications.
2. Click **New Application**, give it a name (e.g., "OpenCode").
3. Copy the **Application ID**: this is your `discordAppId`.
4. (Optional) Go to **Rich Presence > Art Assets** and upload an image. Note the asset key.

## Step 3: Run the installer

```bash
opencode-rpc install
```

The installer:

1. Creates `~/.config/opencode/discord-config.json` from the bundled example (only if missing, or after confirmation to overwrite).
2. Detects and offers to remove any stale `"opencode-rich-presence"` entry left in `opencode.jsonc` (or `.json`) by pre-v2.0.6 installs. The symlink alone is sufficient; the entry would cause OpenCode to attempt an npm install on every startup, returning 404.
3. Symlinks the plugin entry to `~/.config/opencode/plugins/opencode-rich-presence.js` and ensures `@xhayper/discord-rpc` is installed under `~/.config/opencode/node_modules/`.

The symlink approach works around the fact that the package is not on the npm registry: OpenCode loads the plugin directly from disk instead of trying to fetch it via Bun and getting a 404.

If your config does not yet have a Discord App ID, the installer will suggest editing it:

```bash
nano ~/.config/opencode/discord-config.json
```

## Step 4: Verify and restart OpenCode

```bash
opencode-rpc info
```

You should see `OpenCode plugin symlink` with `Linked: yes` and a `Target:` pointing to the package entry file in your npm prefix. Then start OpenCode and check Discord. Your AI session should appear as a rich presence within a few seconds.

```bash
opencode
```

## Updating

```bash
opencode-rpc update                  # upgrade to latest stable release (if newer)
opencode-rpc update --dev            # upgrade to latest commit on main (developer)
opencode-rpc update --stable         # force install latest stable tag (use to switch off dev)
```

Fetches the latest tag (or commit, with `--dev`) from GitHub, then runs `npm install -g Khip01/opencode-rich-presence#<ref>` to upgrade in place. `--stable` skips version comparison and always installs the latest tag, useful for switching back from `--dev` mode. `--stable` and `--dev` are mutually exclusive. Restart OpenCode afterwards.

## Uninstalling

```bash
opencode-rpc uninstall    # removes plugin-generated files + symlink + dependency
npm uninstall -g Khip01/opencode-rich-presence    # removes the package globally
```

The uninstaller automatically removes:

- Runtime files (`~/.config/opencode/.opencode-rich-presence.lock`, `presence-state.txt`, `.discord-restart-request`)
- Local plugin symlink at `~/.config/opencode/plugins/opencode-rich-presence.js`
- `@xhayper/discord-rpc` from `~/.config/opencode/package.json` and `node_modules`
- Any stale `"opencode-rich-presence"` entry left in `~/.config/opencode/opencode.jsonc` (or `.json`). Without this cleanup, OpenCode would attempt an npm install on every startup and return 404.

You will be asked before `discord-config.json` is deleted (default N), with a timestamp-suffixed backup if you agree.

To complete uninstall, also remove the package itself with `npm uninstall -g Khip01/opencode-rich-presence`.

## Migration from v1.0.0

v1.0.0 used bash scripts (`install`, `uninstall`, `restart-discord.sh`) and was Linux-only.

1. Back up `~/.config/opencode/discord-config.json`.
2. Install v2.1.0 via the steps above.
3. Run `opencode-rpc install` to set up the new config file.
4. Restore your settings into the new config (App ID, presence templates).
5. Remove the old v1.0.0 leftovers from `~/.config/opencode/`:
   ```bash
   rm -rf ~/.config/opencode/plugins/opencode-dc-too-rich-presence.js
   rm -f ~/.config/opencode/discord-worker.mjs
   rm -f ~/.config/opencode/restart-discord.sh
   rm -f ~/.config/opencode/package.json ~/.config/opencode/package-lock.json
   rm -f ~/.config/opencode/CUSTOMIZATION.md ~/.config/opencode/README.md ~/.config/opencode/SETUP.md
   ```
6. Restart OpenCode.

The plugin name changed from `opencode-dc-too-rich-presence` to `opencode-rich-presence`.

## Troubleshooting

If Discord does not show your presence:

1. Run `opencode-rpc info` and check that the plugin symlink is present, the lock file exists, and Discord is reported as `connected`.
2. Verify Discord Desktop is running.
3. Check the debug log: `cat $(opencode-rpc info | grep "Debug log" | awk '{print $3}')`.
4. See [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) for the diagnostic checklist and known root causes.
