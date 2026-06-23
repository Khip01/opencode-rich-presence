# Troubleshooting

Common issues and fixes for `opencode-rich-presence` v2.0.0+.

## Quick Diagnostics

Run `opencode-rpc info` first. Output sections:

- **Environment**: Platform, Node.js version, executable path (always present)
- **Paths**: OpenCode dir, config file, output file, lock file, debug log (always present)
- **Config**: Your `discord-config.json` values (App ID masked, always present if config exists)
- **Lock (leader instance)**: Only shown when an OpenCode instance currently holds the leader lock
- **OpenCode plugin registration**: Only shown when `~/.config/opencode/opencode.json` or `.jsonc` parses successfully

If something looks wrong, the next steps depend on what's missing.

---

## Discord doesn't show my presence

**Check 1: Is the plugin loaded by OpenCode?**

Look for the `OpenCode plugin registration` section near the bottom of `opencode-rpc info` output. If it's missing entirely, your `~/.config/opencode/opencode.json` or `.jsonc` could not be parsed (see below). If it appears and says `Status: NOT registered`, edit the file:

```json
{ "plugin": ["opencode-rich-presence"] }
```

Then restart OpenCode.

If the `OpenCode plugin registration` section does not appear at all in `opencode-rpc info`, your OpenCode config file contains characters that cannot be parsed. Common causes are unescaped newlines inside string values (for example, model or provider names with literal line breaks). Edit `~/.config/opencode/opencode.json` or `.jsonc` and ensure all string values are valid JSON or JSONC.

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

If unsure, use the fallback defaults (just delete `discordAppId` from your config). The plugin ships with a verified App ID.

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

This is expected behavior. Only one instance pushes to Discord at a time. If you want a specific instance to be leader:
1. Close all other OpenCode windows.
2. The remaining instance becomes leader automatically after the lock expires (15s).
3. Or, run `opencode-rpc restart` to force an immediate leader re-election.

Check leader status. The `Lock (leader instance)` section only appears in `opencode-rpc info` output when a lock file is currently held. If you see it:
```
$ opencode-rpc info
...
Lock (leader instance)
  PID            : 12345
  Started        : 2026-06-23T16:23:34.942Z
  Age            : 42s
  Status         : YOU are leader
```

If no Lock section is shown, no instance currently holds the leader lock (no OpenCode instance is running).

---

## "Worker exited" loops in debug log

**Cause:** Worker subprocess crashes repeatedly. Most common: App ID is wrong or Discord blocks it.

**Fix:**
1. Check the last worker exit code in the debug log.
2. Try with the fallback App ID (delete `discordAppId` from config).
3. Verify Discord is running and not blocked by firewall.
4. Restart OpenCode.

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

If files remain after `opencode-rpc uninstall`:

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

If you can't run scripts, this isn't related to the plugin. Adjust PowerShell policy or use `cmd.exe`.

---

## Plugin loads but Discord shows stale data

**Cause:** Worker is stuck or disconnected.

**Fix:**
```bash
opencode-rpc restart
```

This kills the worker and signals a reload. The plugin respawns the worker within about 7 seconds and reconnects to Discord. Your Discord Desktop session stays open (this command does NOT touch Discord).

---

## Still stuck?

1. Run `opencode-rpc info` and capture the output.
2. Tail the debug log while reproducing the issue.
3. Open an issue at https://github.com/Khip01/opencode-rich-presence/issues with:
   - OS and version
   - Node.js version
   - Output of `opencode-rpc info` (mask sensitive IDs if needed)
   - Relevant debug log snippets
