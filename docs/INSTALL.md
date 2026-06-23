# Installation Guide

Detailed setup for `opencode-rich-presence` v2.0.0+.

## Prerequisites

1. **OpenCode CLI** installed and working.
2. **Node.js 18+** (`node --version` to check).
3. **Discord Desktop** installed and running on the same machine.

## Step 1: Install the package

Pick one installation method.

### A. From GitHub Releases (recommended for end users)

```bash
npm install -g https://github.com/Khip01/opencode-rich-presence/releases/latest/download/opencode-rich-presence-latest.tgz
```

This installs the `opencode-rpc` CLI globally and makes the plugin code available.

### B. From a specific version

```bash
npm install -g https://github.com/Khip01/opencode-rich-presence/releases/download/v2.0.0/opencode-rich-presence-2.0.0.tgz
```

### C. From local source (for development)

```bash
git clone https://github.com/Khip01/opencode-rich-presence.git
cd opencode-rich-presence
npm install
npm link
```

## Step 2: Create a Discord Application (one-time)

1. Go to https://discord.com/developers/applications.
2. Click **New Application**, give it a name (e.g., "OpenCode").
3. Copy the **Application ID**: this is your `discordAppId`.
4. (Optional) Go to **Rich Presence > Art Assets** and upload an image. Note the asset key (e.g., `opencode-logo`).

For the quickest out-of-box experience, the plugin ships with a verified App ID and asset key as defaults. You only need your own if you want custom branding.

## Step 3: Run the installer

```bash
opencode-rpc install
```

This creates `~/.config/opencode/discord-config.json` from the bundled example.

If you have your own Discord Application, edit the file:

```bash
nano ~/.config/opencode/discord-config.json
```

Set:
```json
{
  "discordAppId": "YOUR_APP_ID",
  "discordLargeImageKey": "your-asset-key",
  "discordLargeImageText": "OpenCode",
  "currency": "$"
}
```

## Step 4: Register with OpenCode

Open `~/.config/opencode/opencode.json` (or `.jsonc`):

```bash
nano ~/.config/opencode/opencode.json
```

Add the plugin to the `plugin` array (create it if missing):

```json
{
  "plugin": ["opencode-rich-presence"]
}
```

If the file doesn't exist yet, create it:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-rich-presence"]
}
```

## Step 5: Restart OpenCode

OpenCode auto-installs the npm plugin on startup via Bun.

Verify:

```bash
opencode-rpc info
```

You should see `Status: REGISTERED in opencode.json`.

Start OpenCode and check Discord. Your AI session should appear as a rich presence within a few seconds.

## Updating

```bash
opencode-rpc update
```

This fetches the latest GitHub release, downloads the new tarball, and reinstalls globally. Restart OpenCode afterwards.

## Uninstalling

```bash
opencode-rpc uninstall    # removes config + generated files (interactive)
npm uninstall -g opencode-rich-presence    # removes CLI globally
```

Then remove `"opencode-rich-presence"` from the `plugin` array in `opencode.json`.

## Migration from v1.0.0

v1.0.0 used bash scripts (`install`, `uninstall`, `restart-discord.sh`) and was Linux-only.

1. Back up `~/.config/opencode/discord-config.json`.
2. Install v2.0.0 via the steps above.
3. Restore your settings into the new config file.
4. Restart OpenCode.

The plugin name changed from `opencode-dc-too-rich-presence` to `opencode-rich-presence`. Update your `opencode.json` `plugin` array accordingly.

## Troubleshooting

If Discord doesn't show your presence:

1. Run `opencode-rpc info` to check that the plugin is registered and the config is found.
2. Verify Discord Desktop is running.
3. Check the debug log: `cat $(opencode-rpc info | grep "Debug log" | awk '{print $3}')`.
4. See [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) for platform-specific issues.
