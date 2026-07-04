# Troubleshooting

Common issues and fixes for `opencode-rich-presence` v2.0.0+.

## Quick Diagnostics

Run `opencode-rpc info` first. Output sections:

- **Environment**: Platform, Node.js version, executable path (always present)
- **Paths**: OpenCode dir, config file, output file, lock file, debug log (always present)
- **Config**: Your `discord-config.json` values (App ID masked, always present if config exists)
- **Lock (leader instance)**: Only shown when an OpenCode instance currently holds the leader lock
- **OpenCode plugin symlink**: Always shown. Reports whether the plugin entry is symlinked at `~/.config/opencode/plugins/opencode-rich-presence.js` and what its target is

If something looks wrong, the next steps depend on what's missing.

---

## Discord doesn't show my presence

**Check 1: Is the plugin loaded by OpenCode?**

Look for the `OpenCode plugin symlink` section near the bottom of `opencode-rpc info` output. It should show `Linked: yes` with a `Target:` pointing to the package entry file in your npm prefix (for example, `~/.nvm/versions/node/v22/lib/node_modules/opencode-rich-presence/src/plugin/index.js`).

If it shows `Linked: NO`, run `opencode-rpc install` to create the symlink. If it shows `Linked: NO (regular file at that path, not a symlink)`, the symlink was replaced with a real file at some point. Remove it manually and re-run `opencode-rpc install`.

**Do not add `"opencode-rich-presence"` to the `plugin` array in `opencode.jsonc`.** OpenCode reads that array as a list of npm packages to fetch on startup. The package is not on the npm registry (only on GitHub Releases), so the entry causes a 404 notification every time OpenCode launches. The symlink alone is sufficient.

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

v2.0.7+ uses activity-based leader election: as soon as you send a chat message in this window, it writes a handoff signal, the current leader yields within 5 seconds, and this window becomes leader and starts pushing to Discord. You should see the switch within ~7 seconds of your first message.

If the handoff does not happen within 10 seconds:

1. Verify the other OpenCode window is not actively chatting in the same Discord-target session. If both are active, the one with the most recent activity wins; the other becomes standby.
2. Run `opencode-rpc info` in this window and look for the `Lock (leader instance)` section. If you see `YOU are leader`, this window is the leader.
3. If neither window shows `YOU are leader`, no OpenCode instance currently holds the leader lock. Restart OpenCode.
4. As a last resort, force a leader re-election:
   ```bash
   opencode-rpc restart
   ```
   This kills the worker subprocess so the plugin respawns it. Standby instances also become eligible to take over on their next poll.

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
   npm install -g 'Khip01/opencode-rich-presence#v2.1.1'
   ```
   (zsh users: quote the URL, see INSTALL.md.)

---

## `opencode-rpc: command not found` after install

**Symptom:** `npm list -g` shows `opencode-rich-presence@` in the list, but running `opencode-rpc` errors with `command not found` or `zsh: command not found: opencode-rpc`. The package is "installed" according to npm but no CLI binary is on PATH.

**Cause:** npm v11 (Node 24.x) installs git deps as symlinks under `lib/node_modules/<name>` that point at a temp directory under `~/.npm/_cacache/tmp/<id>`. After npm cleans up that temp dir, the symlink becomes broken. `npm list` reports the symlink as installed, but the `bin` link in `<prefix>/bin/opencode-rpc` is never created, so the CLI is unreachable. This affects:
- `npm install -g <repo>` (no `#ref`) on npm v11.
- v2.1.0's `opencode-rpc update --dev` and `opencode-rpc update --stable`, which called `npm install -g <repo>#<ref>` directly. v2.1.0 is the last version with this bug; v2.1.1+ uses clone+pack+install-from-tarball internally and is unaffected.

**How to verify:**
```bash
# npm thinks it's installed:
npm list -g opencode-rich-presence
# -> opencode-rich-presence@ -> ./../../../../../.npm/_cacache/tmp/git-cloneXXXXXXXX
# But the symlink target does not exist:
ls -la "$(npm root -g)/opencode-rich-presence"
# -> lrwxrwxrwx ... opencode-rich-presence -> /home/<user>/.npm/_cacache/tmp/git-cloneXXXXXXXX
# -> /home/<user>/.npm/_cacache/tmp/git-cloneXXXXXXXX: No such file or directory
```

**Fix (recovery):**
1. Uninstall the broken install:
   ```bash
   npm uninstall -g opencode-rich-presence
   ```
2. Install the latest tarball from the GitHub release. Tarballs install as a real directory (no symlink), so the bug does not apply:
   ```bash
   # Download from: https://github.com/Khip01/opencode-rich-presence/releases/latest
   # Pick the opencode-rich-presence-X.Y.Z.tgz asset under "Assets"
   npm install -g ./Downloads/opencode-rich-presence-2.1.1.tgz   # adjust path
   ```
3. Verify:
   ```bash
   opencode-rpc version
   # -> opencode-rich-presence v2.1.1 (stable)
   which opencode-rpc
   # -> /home/<user>/.nvm/versions/node/v24.13.1/bin/opencode-rpc
   ```
4. If `opencode-rpc version` does not show `(stable)` / `(dev: <sha>)`, the `.install-channel` marker is missing. Run any `opencode-rpc` command; the CLI bootstraps a fresh marker on first run.

**Prevention:** v2.1.1+ uses a tarball-based install flow inside `opencode-rpc update`. As long as the installed CLI is v2.1.1 or later, future `update` calls will not reproduce this bug.

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

# Remove plugin entry from OpenCode config (only needed for v2.0.5-era installs;
# v2.0.6+ removes this automatically)
# Edit ~/.config/opencode/opencode.jsonc and remove "opencode-rich-presence" from "plugin"
```

---

## Windows: Plugin doesn't load

**Check 1: WSL vs native Windows**

If you run OpenCode in WSL but install the plugin in native Windows, the paths won't match. OpenCode in WSL sees Linux paths; native npm install puts files in Windows paths.

**Fix:** Install the plugin inside WSL:
```bash
# Inside WSL
npm install -g Khip01/opencode-rich-presence#v2.1.1
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

**Symptom:** `info` does not show `Lock (leader instance)` section. `Output file: missing`. AI fires messages normally but Discord stays empty.

**Root cause 1:** OpenCode tries to install npm plugins from the npm registry at startup via Bun. The `opencode-rich-presence` package is NOT published there (we distribute via GitHub Releases tarball), so the install attempt 404s. OpenCode creates `~/.cache/opencode/packages/opencode-rich-presence@latest/` but leaves it empty. The fix is the symlink at `~/.config/opencode/plugins/opencode-rich-presence.js`.

**How to verify:**
```bash
npm view opencode-rich-presence version 2>&1 | head -3
# Expected: npm error 404 'opencode-rich-presence@*' could not be found
ls -la ~/.cache/opencode/packages/opencode-rich-presence@latest/
# Expected: empty directory
ls -la ~/.config/opencode/plugins/opencode-rich-presence.js
# Expected: -> /.../opencode-rich-presence/src/plugin/index.js
```

**Fix:** Run `opencode-rpc install` to recreate the symlink if missing.

**Root cause 2 (v2.0.5-era installs):** `opencode.jsonc` (or `.json`) has `"opencode-rich-presence"` in the `plugin` array. OpenCode reads that array as npm packages to fetch on startup, returning 404. The symlink in `~/.config/opencode/plugins/` alone is sufficient; the entry in `opencode.jsonc` is no longer required and should not be present.

**How to verify:**
```bash
grep "opencode-rich-presence" ~/.config/opencode/opencode.jsonc ~/.config/opencode/opencode.json 2>/dev/null
# Expected: empty output. If a line appears, you have the stale entry.
```

**Fix:**
- v2.0.6+: Run `opencode-rpc install` and accept the prompt to remove the stale entry (default Y). Or run `opencode-rpc uninstall` which auto-removes it.
- v2.0.5 users (before this release): Edit `~/.config/opencode/opencode.jsonc` (or `.json`) and remove the `"opencode-rich-presence"` line from the `"plugin"` array manually.

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

### Idle leader keeps showing stale presence while another instance is actively chatting

**Symptom:** OpenCode instance #1 opened first and is the current leader (Discord shows its presence). OpenCode instance #2 opens later. When you send a message in #2, Discord keeps showing #1's stale idle presence instead of #2's activity.

**Root cause:** Pre-v2.0.7 leader election was first-wins. The first instance to acquire the leader lock held it indefinitely (until exit or 15s stale). Standby instances could not push to Discord even when actively chatting. Fixed in v2.0.7 with activity-based handoff.

**How to verify:**
```bash
# In a stale-presence scenario, check the leader lock's lastActivity
cat ~/.config/opencode/.opencode-rich-presence.lock
# Expected (v2.0.7+): includes "lastActivity" timestamp that updates when the leader receives chat.message
# Pre-v2.0.7 lock has only pid + started; standby's chat.message events do not reach it.
```

**Fix:** Upgrade to v2.0.7. As soon as you send a chat message in any window, that window writes a handoff signal and takes over leadership within ~7 seconds. The previously idle leader yields and becomes standby.

### Discord presence flickers every few seconds with multiple OpenCode windows

**Symptom:** Two or more OpenCode windows open. Discord presence flips between them every few seconds, briefly disconnecting and reconnecting. Sometimes the new leader's worker exits with `code=null sig=SIGTERM` and the presence goes away entirely.

**Root cause:** Pre-v2.0.8 leadership ping-pong. Every instance saw every SDK event (`message.part.updated`, `session.status`, etc.), so every event triggered a handoff request from any standby instance. The leader yielded as soon as the standby's `lastActivity` was fresher, which happened every 5 seconds. The kill signal in `shutdownWorker` could also hit the new leader's worker via PID reuse.

**How to verify:**
```bash
# Watch the leader PID change every few seconds
watch -n 1 'cat ~/.config/opencode/.opencode-rich-presence.lock'
# Also check the debug log for repeated "Handoff requested" and "Worker exited: code=null sig=SIGTERM"
tail -50 /tmp/opencode-rich-presence-debug.log
```

**Fix:** Upgrade to v2.0.8. The leader now ignores handoff signals for 8 seconds after becoming leader (`LEADER_COOLDOWN_MS`), and only user-initiated events (`chat.message`, `permission.asked`, `permission.replied`) request handoff. `shutdownWorker` polls for actual exit before signaling.

### Display stuck at "Typing" after handoff to a new leader

**Symptom:** After a leadership change, Discord shows the new leader's presence but the state stays at "Typing" even after the model has finished. The actual chat has progressed to completion.

**Root cause:** Pre-v2.0.8, standby instances did not poll the server for activity (only the leader did). When a standby instance took over leadership, its in-memory `SessionState` objects could be stale. State transitions like `Typing -> Waiting for command` happen via events, and `session.idle` might not have arrived yet for the new leader.

**How to verify:**
```bash
# Check the presence-state.txt for the current state
cat ~/.config/opencode/presence-state.txt | head -20
# If it shows "Typing" but the chat is actually finished, you have this issue
```

**Fix:** Upgrade to v2.0.8. The new leader now calls `checkAllSessionsActivity()` after gaining leadership, which fetches the latest message for each known session and updates the state (e.g., to `Waiting for command` if the latest message is a completed assistant message).

---

## Quick Diagnostic Checklist

When Discord presence does not show, walk through this in order:

1. **Plugin symlinked?**
   ```bash
   opencode-rpc info | grep -A2 "OpenCode plugin symlink"
   ```
   Should show `Linked: yes` and a `Target:` path. If `Linked: NO`, run `opencode-rpc install` to create the symlink.

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
