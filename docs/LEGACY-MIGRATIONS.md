# Legacy Migrations

This page is for users upgrading from the old v1.x or v2.x plugin to the
current v3.5.0 release.
New installations should follow the [installation guide](./INSTALL.md)
instead.

## Migration from v1.0.0

The v1.0.0 plugin used Linux-only bash scripts and was published under
the name `opencode-dc-too-rich-presence`.

1. Back up your configuration:

   ```bash
   cp ~/.config/opencode/discord-config.json \
     ~/.config/opencode/discord-config.json.backup
   ```

2. Install the latest v3 release using the [installation guide](./INSTALL.md).
3. Run the installer:

   ```bash
   opencode-rpc install
   ```

4. Restore your App ID and presence templates in
   `~/.config/opencode/discord-config.json`.
5. Remove old v1 files if they are still present:

   ```bash
   rm -rf ~/.config/opencode/plugins/opencode-dc-too-rich-presence.js
   rm -f ~/.config/opencode/discord-worker.mjs
   rm -f ~/.config/opencode/restart-discord.sh
   rm -f ~/.config/opencode/package.json
   rm -f ~/.config/opencode/package-lock.json
   rm -f ~/.config/opencode/CUSTOMIZATION.md
   rm -f ~/.config/opencode/README.md
   rm -f ~/.config/opencode/SETUP.md
   ```

6. Restart OpenCode.

## Migration from v2.x

The v2.x line is end-of-life. Install v3 as a fresh package install:

1. Remove the old global package:

   ```bash
   npm uninstall -g opencode-rich-presence
   ```

2. Remove old runtime files if they remain:

   ```bash
   rm -f ~/.config/opencode/.opencode-rich-presence.lock
   rm -f ~/.config/opencode/discord-worker.mjs
   rm -f ~/.config/opencode/package.json
   rm -f ~/.config/opencode/package-lock.json
   ```

3. Install v3 using the [installation guide](./INSTALL.md).
4. Run `opencode-rpc install` and accept removal of any stale
   `opencode-rich-presence` entry from `opencode.jsonc` or
   `opencode.json`.
5. Restart OpenCode. For OpenCode v2, restart the background service:

   ```bash
   opencode service restart
   ```
