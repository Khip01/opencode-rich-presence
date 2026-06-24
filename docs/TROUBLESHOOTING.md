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

---

## Known Root Causes (from v2.0.x development)

These are the specific failure modes that have been observed and fixed. If you hit a similar symptom, check the corresponding root cause before debugging from scratch.

### Plugin acquires lock but Discord never shows presence

**Symptom:** `info` shows `Lock (leader instance)` section with `YOU are leader`, but Discord profile never updates.

**Root cause:** The worker subprocess failed to spawn. The plugin parent stays alive holding the lock, but nothing connects to Discord.

**How to verify:** Check the debug log (`/tmp/opencode-rich-presence-debug.log`):
```bash
tail -30 /tmp/opencode-rich-presence-debug.log
```

Look for `Cannot find module` errors mentioning `discord-worker.mjs`. If the path is wrong (missing `src/`), the worker is computed from the wrong `../` level in `src/shared/paths.js`.

**Fix:** In `src/shared/paths.js`, `WORKER_SOURCE` must be `../worker/discord-worker.mjs` (one `..` from `src/shared/`), not `../../worker/...`. After editing, restart OpenCode (Node ESM caches modules; an in-process plugin keeps the old path).

### OpenCode does not load the plugin at all

**Symptom:** `info` does not show `Lock (leader instance)` section. `Output file: missing`. AI fires messages normally but Discord stays empty. Plugin entry exists in `opencode.jsonc`.

**Root cause:** OpenCode tries to install npm plugins from the npm registry at startup via Bun. The `opencode-rich-presence` package is NOT published there (we distribute via GitHub Releases tarball), so the install attempt 404s. OpenCode creates `~/.cache/opencode/packages/opencode-rich-presence@latest/` but leaves it empty.

**How to verify:**
```bash
npm view opencode-rich-presence version 2>&1 | head -3
# Expected: npm error 404 'opencode-rich-presence@*' could not be found
ls -la ~/.cache/opencode/packages/opencode-rich-presence@latest/
# Expected: empty directory
```

**Fix:** The installer creates a symlink at `~/.config/opencode/plugins/opencode-rich-presence.js` pointing to the package entry file in the npm prefix (global install location). OpenCode also loads from this plugins directory. The symlink approach bypasses the npm registry entirely.

If the symlink is missing, run `opencode-rpc install` to recreate it. Verify with:
```bash
ls -la ~/.config/opencode/plugins/opencode-rich-presence.js
# Should show: -> /.../opencode-rich-presence/src/plugin/index.js
```

### Plugin fixes applied but Discord still does not show

**Symptom:** Code path is fixed, install looks correct, but Discord stays empty.

**Root cause:** Node ESM caches loaded modules. An already-running OpenCode process holds the OLD paths.js in memory even after you reinstall and edit the file on disk. The fix is in the file but not in the running process.

**How to verify:** Check if a previous OpenCode process is still running:
```bash
ps aux | grep opencode | grep -v grep
```

**Fix:** Restart OpenCode. Fully exit (Ctrl+C or `/exit` in OpenCode), then start a fresh `opencode` process. The new process re-imports paths.js with the fixed path.

### JSONC parser treats `://` in URLs as a comment

**Symptom:** When reading `opencode.jsonc` (which contains URLs like `"https://opencode.ai/config.json"`), the parser strips the URL thinking it's a comment. `info` reports `Could not parse opencode.jsonc as JSON/JSONC`.

**Root cause:** The regex `//.*$` (used to strip JSONC line comments) matches `://` in URLs, treating everything from `//` to end of line as a comment.

**How to verify:** Check if the user's opencode.jsonc has URLs:
```bash
grep "//" ~/.config/opencode/opencode.jsonc
```

**Fix:** Use `(?<!:)\/\/.*$` with negative lookbehind on `:` so `://` is not matched as a comment. Plain JSONC comment (space or newline before `//`) still matches.

### Install hangs at confirmation prompt

**Symptom:** `opencode-rpc install` shows `Overwrite? [y/N]` and never returns. Keyboard input has no effect.

**Root cause:** The prompt helper was creating and closing a new readline interface for every prompt. Multiple short-lived interfaces on the same stdin confuses interactive input on some Node versions (especially under Bun).

**How to verify:** Check `node --version` and whether OpenCode spawns its own stdin reader.

**Fix:** Use a single long-lived readline interface created on first prompt and reused across all prompts. For piped (non-TTY) stdin, read all lines upfront into a buffer and consume on each prompt.

### CLI hangs after `Done.` until Ctrl+C

**Symptom:** The uninstall command prints everything and ends with `Done.`, but the prompt does not return. Pressing Ctrl+C is required.

**Root cause:** A readline interface is still open (held by the readline event loop). Node waits for the interface to close before exiting.

**How to verify:** `info` command exits immediately but `install` and `uninstall` hang.

**Fix:** Call `process.exit(0)` after the CLI command completes successfully in `bin/opencode-rpc.js`. Forces Node to exit regardless of pending handles.

### npm install in installer produces a lot of warnings

**Symptom:** The install output is dominated by npm warnings about engine versions (`EBADENGINE Unsupported engine`).

**Root cause:** The user's Node.js version (e.g., 24.13.1) is slightly older than what some dependencies require (`^24.15.0`). This is non-fatal; npm still installs correctly.

**How to verify:** Check the warnings include `current: { node: 'v24.13.1' }` and the install still completes with `added N packages`.

**Fix:** Safe to ignore. If you want clean output, upgrade Node.js to the version listed in the warning. The plugin itself works fine on the older Node version.

---

## Quick Diagnostic Checklist

When Discord presence does not show, walk through this in order:

1. **Plugin registered?**
   ```bash
   opencode-rpc info | grep -A1 "OpenCode plugin registration"
   ```
   If no section appears, `opencode.jsonc` cannot be parsed (likely has `://` in a URL value). Fix the file manually or `opencode-rpc install` will offer to register in another config file.

2. **Plugin loaded by OpenCode?**
   ```bash
   ls -la ~/.config/opencode/plugins/opencode-rich-presence.js
   cat ~/.config/opencode/package.json | grep xhayper
   ```
   Symlink should exist. `@xhayper/discord-rpc` should be in package.json. If missing, run `opencode-rpc install`.

3. **Lock file present?**
   ```bash
   ls -la ~/.config/opencode/.opencode-rich-presence.lock
   opencode-rpc info | grep -A2 "Lock"
   ```
   If no lock file, no OpenCode instance has the plugin running. Restart OpenCode.

4. **Worker spawned successfully?**
   ```bash
   tail -50 /tmp/opencode-rich-presence-debug.log
   ```
   Look for `Spawn worker:` followed by `Discord connected via worker`. If you see `Cannot find module` or repeated `Worker exited: code=1`, the worker path is wrong (see root cause above).

5. **Discord Desktop running?**
   The plugin can only push presence if Discord Desktop is open with the IPC socket available.
