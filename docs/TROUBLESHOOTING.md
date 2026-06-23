# Troubleshooting

Common issues and fixes for `opencode-rich-presence` v2.0.0+.

## Quick Diagnostics

Run `rich-presence info` first. It shows:
- Platform and Node.js version
- All file paths and existence
- Config values (App ID masked)
- Lock file state (leader/standby)
- OpenCode plugin registration status

If something looks wrong, the next steps depend on what's missing.

---

## Discord doesn't show my presence

**Check 1: Is the plugin loaded by OpenCode?**

```
$ rich-presence info
...
OpenCode plugin registration
  Status         : REGISTERED in opencode.json
```

If it says NOT registered, edit `~/.config/opencode/opencode.json`:
```json
{ "plugin": ["opencode-rich-presence"] }
```

Then restart OpenCode.

**Check 2: Is Discord running?**

```
$ ps aux | grep -i discord    # Linux/macOS
$ tasklist | findstr Discord   # Windows
```

If Discord isn't running, start it.

**Check 3: App ID and Asset Key**

Verify your config:
```bash
cat ~/.config/opencode/discord-config.json
```

If using your own Discord App:
- App ID must match the one from https://discord.com/developers/applications
- Asset key must match an asset uploaded to that app's Rich Presence > Art Assets

If unsure, use the fallback defaults (just delete `discordAppId` from your config) — the plugin ships with a verified App ID.

**Check 4: Debug log**

```bash
OPENCODE_RICH_PRESENCE_DEBUG=true opencode    # run in foreground
```

Or check the log file:
```bash
# Linux
cat /tmp/opencode-rich-presence-debug.log
# macOS
cat /var/folders/*/T/opencode-rich-presence-debug.log
# Windows
type %TEMP%\opencode-rich-presence-debug.log
```

Look for `Discord connected via worker` message. If you see retry attempts, the App ID may be invalid or Discord is blocking it.

---

## "Permission denied" on Discord connect

**Cause:** Discord Application not approved / not configured correctly.

**Fix:**
1. Verify your App ID at https://discord.com/developers/applications.
2. Make sure the application exists and is not deleted.
3. If using your own App, ensure you've uploaded at least one asset (Discord sometimes rejects empty apps).
4. Try with the fallback App ID first (remove `discordAppId` from config) to isolate.

---

## Plugin runs but doesn't update Discord

**Cause:** You're a standby instance (another OpenCode window is the leader).

**Fix:**

This is expected behavior — only one instance pushes to Discord at a time. If you want a specific instance to be leader:
1. Close all other OpenCode windows.
2. The remaining instance becomes leader automatically after the lock expires (15s).
3. Or, restart Discord with `rich-presence restart` to trigger an immediate leader re-election.

Check leader status:
```
$ rich-presence info
...
Lock (leader instance)
  PID            : 12345
  Status         : YOU are leader
```

---

## "Worker exited" loops in debug log

**Cause:** Worker subprocess crashes repeatedly. Most common: App ID is wrong or Discord blocks it.

**Fix:**
1. Check the last worker exit code in the debug log.
2. Try with the fallback App ID (delete `discordAppId` from config).
3. Verify Discord is running and not blocked by firewall.
4. Restart OpenCode.

---

## Linux: Discord not found in common paths

If Discord is installed via Flatpak (user), Snap, or custom location, the restart command won't find it.

**Fix:**
- Start Discord manually before running `rich-presence restart`.
- Or symlink Discord into a standard location:
  ```bash
  sudo ln -s /path/to/your/discord /usr/local/bin/discord
  ```

---

## macOS: AppleScript quit fails

**Cause:** First-time AppleScript permission prompt.

**Fix:**
1. Run `rich-presence restart` once.
2. macOS will prompt "Terminal wants to control Discord" — click **OK**.
3. Re-run if needed.

---

## Windows: `taskkill` access denied

**Cause:** Discord running as a different user (e.g., admin).

**Fix:**
- Run your terminal as Administrator, or
- Manually close Discord and skip the restart option in `rich-presence restart` (answer `n` to "Also restart Discord").

---

## Update fails

**Cause:** GitHub API rate limit or network issue.

**Fix:**
1. Wait a few minutes and retry.
2. Manual fallback:
   ```bash
   npm install -g https://github.com/Khip01/opencode-rich-presence/releases/latest/download/opencode-rich-presence-latest.tgz
   ```

---

## Uninstall didn't clean up

If files remain after `rich-presence uninstall`:

```bash
# Remove lock file
rm -f ~/.config/opencode/.opencode-rich-presence.lock

# Remove output file
rm -f ~/.config/opencode/presence-state.txt

# Remove restart signal
rm -f ~/.config/opencode/.discord-restart-request

# Remove config (BACK UP FIRST if you want to keep settings)
mv ~/.config/opencode/discord-config.json ~/.config/opencode/discord-config.json.backup

# Remove CLI globally
npm uninstall -g opencode-rich-presence

# Remove plugin entry from OpenCode config
# Edit ~/.config/opencode/opencode.json and remove "opencode-rich-presence" from "plugin"
```

---

## Windows: Plugin doesn't load

**Check 1: WSL vs native Windows**

If you run OpenCode in WSL but install the plugin in native Windows, the paths won't match. OpenCode in WSL sees Linux paths; native npm install puts files in Windows paths.

**Fix:** Install the plugin inside WSL:
```bash
# Inside WSL
npm install -g https://github.com/Khip01/opencode-rich-presence/releases/latest/download/opencode-rich-presence-latest.tgz
```

**Check 2: PowerShell execution policy**

If you can't run scripts, this isn't related to the plugin — adjust PowerShell policy or use `cmd.exe`.

---

## Plugin loads but Discord shows stale data

**Cause:** Worker is stuck or disconnected.

**Fix:**
```bash
rich-presence restart
```

This triggers an intentional restart, reloads config, and reconnects.

---

## Still stuck?

1. Run `rich-presence info` and capture the output.
2. Tail the debug log while reproducing the issue.
3. Open an issue at https://github.com/Khip01/opencode-rich-presence/issues with:
   - OS and version
   - Node.js version
   - Output of `rich-presence info` (mask sensitive IDs if needed)
   - Relevant debug log snippets
