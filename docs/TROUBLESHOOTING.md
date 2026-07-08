# Troubleshooting

Common issues and fixes for `opencode-rich-presence` v3.x
(daemon-based push, multi-instance safe).

## Quick Diagnostics

Run `opencode-rpc info` first. Output sections:

- **Environment**: Platform, Node.js version, executable path
- **Paths**: OpenCode dir, config, default state file, activity log,
  lock file, debug log
- **Config**: Your `discord-config.json` values (App ID masked)
- **Per-instance state files**: One entry per running OpenCode instance
- **OpenCode plugin symlink**: Whether the plugin entry is symlinked
- **Activity log tail**: Last 30 entries of the chronological activity log

If something looks wrong, the next steps depend on what's missing.

---

## Phase 2: how to read the activity log

`opencode-rich-presence` v3 Phase 2's primary diagnostic surface is
the activity log at `~/.config/opencode/presence-activity.log`. To
watch it in real time:

```bash
tail -f ~/.config/opencode/presence-activity.log
```

For a snapshot:

```bash
opencode-rpc info         # last 30 entries inline
tail -50 ~/.config/opencode/presence-activity.log
```

Each line:

```
[2026-07-05 14:30:25.789] [pid 12345] [tag] message
```

PID tagging lets you grep one instance when multiple are open:

```bash
grep '\[pid 12345\]' ~/.config/opencode/presence-activity.log
```

Tag reference:

| Tag | When to investigate |
|-----|---------------------|
| `event` | If state does not change after a real OpenCode event, the plugin missed it. Check the `event` line for the session ID. |
| `state` | Should show transitions like `WAITING -> WORKING` on chat.message, `WORKING -> TYPING` on text parts, etc. |
| `display` | If the displayed session does not match what you expect, this is where to look. |
| `template` | If the rendered presence looks wrong (missing variables, wrong model name), this shows the source template and resolved output. |
| `push` | Phase 2 emits `sent rendered payload to daemon` (plugin side) and `[daemon] push details=... state=...` (daemon side). |
| `daemon` | Plugin-side daemon connection events (spawn, connect, disconnect). |
| `check` | Periodic SDK poll (every 5s). High frequency is normal; this catches events the stream missed. |

### "I fired a message but Discord did not update"

You are running Phase 2. Check the activity log:

1. Plugin side: `[push] sent rendered payload to daemon` should
   appear after each chat.message or state change.
2. Daemon side: `[daemon] push details="..." state="..."` should
   appear when the daemon picks the global session and pushes to
   Discord.

If plugin sends but daemon does not push:
- Check `[daemon] Discord connected` is in the log.
- Check `[daemon] no chosen instance` is NOT there (means daemon
  has no client instances).
- Check daemon PID is still alive (`ps aux | grep daemon.mjs`).

If daemon pushes but Discord does not show:
- Check Discord Desktop is running.
- Check `~/.config/opencode/discord-config.json` has a valid App ID.
- Verify the App ID at https://discord.com/developers/applications
  matches your config.

### "Daemon not running" or "Display stuck"

Run `opencode-rpc info`. The Daemon section shows:
- `Socket : [present]` if daemon is listening
- `PID : <number> [alive]` if daemon process is running

If daemon is missing or stale:
1. The next chat.message will spawn a fresh daemon.
2. To force: `opencode-rpc restart` (kills old daemon, rotates log).

### "Display works on odd cycles but fails on even cycles"

Classic symptom of the EPIPE-on-closed-stderr-pipe bug (fixed in
v3.0.4-phase2). Pattern: open opencode and fire (display appears),
exit, open opencode again and fire (display does not appear), exit,
open again (display appears), exit, open again (display does not
appear), ...

Diagnosis:
1. `tail -f ~/.config/opencode/presence-activity.log | grep -E "daemon|uncaughtException|exit"`
2. Look for `uncaughtException: Error: write EPIPE` followed by
   `exit code=1` shortly after the parent opencode process exited.
3. Each "exit code=1" is one daemon dying. The next cycle spawns a
   fresh daemon (which can hit Discord's app-id cooldown, hence the
   "every other cycle fails" symptom).

Fix: upgrade to v3.0.4-phase2 or later. The fix changes the daemon's
`stdio` from `stderr=pipe` to `stderr=ignore` so no pipe is created
in the first place, plus a defensive EPIPE catch in the log helper.
Without a fix, the symptom is permanent on every multi-cycle use.

### "Activity log is empty after I open OpenCode"

Check that the plugin loaded at all:

```bash
tail -50 /tmp/opencode-rich-presence-debug.log
```

Look for `=== Plugin loaded ===` (legacy log line) or `[load]
plugin loaded` (new activity log line). If absent, the plugin
symlink is missing or OpenCode did not load the plugin. See
"Plugin does not load" below.

### "Activity log is huge / has grown forever"

Rotate it via:

```bash
opencode-rpc restart     # renames activity log to .prev
```

Or manually:

```bash
mv ~/.config/opencode/presence-activity.log ~/.config/opencode/presence-activity.log.prev
```

The next OpenCode launch starts a fresh log.

---

## Discord doesn't show my presence

See "Phase 2: I fired a message but Discord did not update" above
for the diagnostic flow. Quick checklist:

1. Activity log shows plugin sending: `[push] sent rendered payload
   to daemon`.
2. Activity log shows daemon receiving: `[daemon] instance
   registered`.
3. Activity log shows daemon pushing: `[daemon] push details="..."
   state="..."`.
4. Discord Desktop is running with the App ID matching your config.
5. `opencode-rpc info` shows daemon PID is alive.

---

## "Permission denied" on Discord connect

**Cause:** Discord Application not approved / not configured
correctly. Surfaces in the daemon log as
`[daemon] Discord connect failed: ...`.

**Fix:**

1. Verify your App ID at https://discord.com/developers/applications.
2. Make sure the application exists and is not deleted.
3. If using your own App, ensure you've uploaded at least one
   asset (Discord sometimes rejects empty apps).
4. Try with the fallback App ID first (remove `discordAppId` from
   config) to isolate.

---

## Plugin runs but doesn't update Discord

**Cause:** Either the plugin is a standby instance (another
OpenCode window is the daemon's primary client) or the daemon has
not received a state update.

**Fix:**

1. Run `opencode-rpc info` and check the Daemon section.
2. Fire a chat.message in this window. This sends a state update
   to the daemon (no need to take over leadership in v3 Phase 2:
   the daemon just picks the most recent activity).
3. If neither helps, run `opencode-rpc restart` to recycle the
   daemon.

---

## "Worker exited" loops in debug log

(Phase 2: there is no per-session worker. The daemon is the only
subprocess. If you see "Worker exited" loops, you are likely
running v2.x. Check `opencode-rpc version`.)

---

## Update fails

**Cause:** GitHub API rate limit or network issue.

**Fix:**

1. Wait a few minutes and retry.
2. Manual fallback: download the tarball directly.
   ```bash
   # Get the URL from: https://github.com/Khip01/opencode-rich-presence/releases/latest
   curl -fL -o opencode-rich-presence.tgz <tarball-url>
   npm install -g ./opencode-rich-presence.tgz
   ```
   If you already have `opencode-rpc` on PATH, prefer
   `opencode-rpc update --stable` once the network is back. The
   manual tarball install only matters for the initial install on a
   fresh machine.

---

## `opencode-rpc: command not found` after install

**Symptom:** `npm list -g` shows `opencode-rich-presence@` in the
list, but running `opencode-rpc` errors with `command not found`.
This can happen immediately after install, or after a reboot / npm
cache cleanup:

```
$ npm install -g 'Khip01/opencode-rich-presence#v3.1.6'
added 1 package in 4s

$ opencode-rpc
zsh: command not found: opencode-rpc

$ npm list -g opencode-rich-presence
└── opencode-rich-presence@ -> ./../../../../../.npm/_cacache/tmp/git-cloneAmM1cO
```

**Cause:** npm v11 has a bug installing global git deps
(`<owner>/<repo>#<ref>`). It:

1. Clones the repo to a temp dir under `~/.npm/_cacache/tmp/`.
2. Symlinks `lib/node_modules/<repo>` to that temp dir.
3. Never creates the `bin/<binary>` symlink that should point into
   the package.

The package appears in `npm list -g` but the CLI binary is missing.
After npm cleans its cache temp dir, or after a reboot that touches
the cache path, the symlink dangles and the install appears to
vanish entirely.

The bug is consistent across branches, tags, and commit SHAs, and
across npm v11.0.0 through at least v11.8.0. It is on npm's side,
not the package's. The package cannot fix it from
`package.json` (we already tried removing the `files` field, which
exposed more files but did not create the missing bin symlink).

**How to verify:**

```bash
npm list -g opencode-rich-presence
# Output shows a dangling symlink under ~/.npm/_cacache/tmp/:
#   opencode-rich-presence@ -> ./../../../../../.npm/_cacache/tmp/git-cloneAmM1cO

ls -la "$(npm root -g)/opencode-rich-presence"
# Output: symlink to a path that no longer exists.
```

**Fix (recovery):**

1. Uninstall the broken install:
   ```bash
   npm uninstall -g opencode-rich-presence
   ```
2. Install via the curl installer (Linux/macOS):
   ```bash
   curl -fsSL https://raw.githubusercontent.com/Khip01/opencode-rich-presence/main/install.sh | bash
   ```
   Or download the tarball manually and install from it (any
   platform):
    ```bash
    # Download from: https://github.com/Khip01/opencode-rich-presence/releases/latest
    # File name: opencode-rich-presence-<version>.tgz
    npm install -g ./opencode-rich-presence-3.1.6.tgz
    ```
3. Verify:
   ```bash
   opencode-rpc version
   # Expected: opencode-rich-presence v3.1.6 (stable)
   ```

**Why `opencode-rpc update --ref <tag>` does not help on a fresh
install:** the `--ref` flow does work, but it requires
`opencode-rpc` to already be on PATH. On a fresh machine, the only
way to get it on PATH is via the curl installer or the manual
tarball install above.

**Prevention:** never use `npm install -g <repo>#<ref>` for the
initial install. Always use the curl installer or a manual tarball
install. After the initial install, `opencode-rpc update --ref
<tag>` is the recommended upgrade path (it clones the repo, packs
a tarball, and installs from the tarball, so the npm v11 bug does
not apply).

---

## Uninstall didn't clean up

If files remain after `opencode-rpc uninstall`:

```bash
# Remove lock file (legacy v2.x; Phase 2 ignores it)
rm -f ~/.config/opencode/.opencode-rich-presence.lock

# Remove presence-state files
rm -f ~/.config/opencode/presence-state*.txt

# Remove activity log
rm -f ~/.config/opencode/presence-activity.log
rm -f ~/.config/opencode/presence-activity.log.prev

# Remove restart signal
rm -f ~/.config/opencode/.discord-restart-request

# Remove config (BACK UP FIRST if you want to keep settings)
mv ~/.config/opencode/discord-config.json ~/.config/opencode/discord-config.json.backup

# Remove CLI globally
npm uninstall -g opencode-rich-presence

# Remove plugin entry from OpenCode config (only needed for v2.0.5-era installs)
# Edit ~/.config/opencode/opencode.jsonc and remove "opencode-rich-presence" from "plugin"
```

---

## Windows: Plugin doesn't load

**Check 1: WSL vs native Windows**

If you run OpenCode in WSL but install the plugin in native Windows,
the paths won't match. OpenCode in WSL sees Linux paths; native npm
install puts files in Windows paths.

**Fix:** Install the plugin inside WSL using the tarball install
from
[GitHub Releases](https://github.com/Khip01/opencode-rich-presence/releases/latest):

```bash
npm install -g ./opencode-rich-presence-3.1.6.tgz
```

**Check 2: PowerShell execution policy**

If you can't run scripts, this isn't related to the plugin. Adjust
PowerShell policy or use `cmd.exe`.

---

## Plugin loads but Discord shows stale data

(Phase 2: replaced by daemon restart: `opencode-rpc restart`.)

---

## Known Root Causes (from v2.0.x / v3 development)

These are the specific failure modes that have been observed and
fixed. If you hit a similar symptom, check the corresponding root
cause before debugging from scratch.

### Phase 2: Daemon says "socket in use, another daemon is already running"

**Symptom:** Activity log shows `[daemon] socket in use, another
daemon is already running; exiting`. This happens when two plugin
instances try to spawn the daemon at the same time.

**Root cause:** Race condition. The second `bind()` to the daemon
socket gets EADDRINUSE. The daemon handles this by logging and
exiting cleanly.

**How to verify:** Check if the daemon is still running:
```bash
ls ~/.config/opencode/.opencode-rich-presence.sock
cat ~/.config/opencode/.opencode-rich-presence.pid
ps -p $(cat ~/.config/opencode/.opencode-rich-presence.pid)
```

**Fix:** This is benign. The first daemon won the race and is
serving both clients. If you want a fresh daemon:
```bash
opencode-rpc restart
```

### Phase 2: Activity log shows events but state transitions look wrong

**Symptom:** The activity log captures every event correctly, but
the `state` transitions are missing or off (e.g. `chat.message`
arrives but no `WORKING -> TYPING` ever appears).

**Root cause:** A new SDK event type or session state has been
introduced that the event handler in `src/plugin/index.js` does
not yet cover. Compare the `event` lines to the handler list:
`session.created`, `session.updated`, `session.deleted`,
`session.status`, `session.idle`, `message.updated`,
`message.part.updated`, `permission.asked`, `permission.replied`,
`chat.message`. Any unhandled event types will not produce state
transitions.

**How to verify:**

```bash
grep "\[event\]" ~/.config/opencode/presence-activity.log | awk -F'[][]' '{print $4}' | sort -u
```

This lists every event type seen in the log. Compare to the handler
list above.

**Fix:** Add a handler for the missing event type in `index.js`.
The pattern is: log it, update session state if applicable,
`transitionTo` on state change, log the display decision.

### Phase 2: Activity log is empty even though OpenCode is running

**Symptom:** OpenCode is open and you are firing messages, but
`~/.config/opencode/presence-activity.log` does not grow.

**Root cause:** Either:
1. OpenCode did not load the plugin. Check the debug log
   (`/tmp/opencode-rich-presence-debug.log`) for plugin load
   messages.
2. The plugin loaded but the activity log file is unwritable.
   Check permissions on `~/.config/opencode/`.
3. You have an OLD plugin version loaded in memory (Node ESM
   caches modules). Restart OpenCode to load the new code.

**How to verify:**

```bash
ls -la ~/.config/opencode/presence-activity.log
ls -la ~/.config/opencode/plugins/opencode-rich-presence.js
tail -20 /tmp/opencode-rich-presence-debug.log
```

**Fix:** If the symlink is missing, run `opencode-rpc install`. If
the file is unwritable, fix permissions. If the debug log shows no
plugin load, the plugin is not loaded.

### Plugin acquires lock but Discord never shows presence (v2.0.x legacy)

(Phase 2: not applicable; no lock file used. The daemon uses
file-lock-free coordination via the local Unix socket.)

(Phase 2: re-add for daemon-related issues.)

### OpenCode does not load the plugin at all

**Symptom:** `info` does not show per-instance state files or
`[load]` entries in the activity log. AI fires messages normally
but no log entries appear.

**Root cause 1:** OpenCode tries to install npm plugins from the npm
registry at startup via Bun. The `opencode-rich-presence` package is
NOT published there (we distribute via GitHub Releases tarball or
git URL), so the install attempt 404s. The fix is the symlink at
`~/.config/opencode/plugins/opencode-rich-presence.js`.

**How to verify:**

```bash
npm view opencode-rich-presence version 2>&1 | head -3
# Expected: npm error 404 'opencode-rich-presence@*' could not be found
ls -la ~/.cache/opencode/packages/opencode-rich-presence@latest/
# Expected: empty directory
ls -la ~/.config/opencode/plugins/opencode-rich-presence.js
# Expected: -> /.../opencode-rich-presence/src/plugin/index.js
```

**Fix:** Run `opencode-rpc install` to recreate the symlink if
missing.

**Root cause 2 (v2.0.5-era installs):** `opencode.jsonc` (or `.json`)
has `"opencode-rich-presence"` in the `plugin` array. OpenCode
reads that array as npm packages to fetch on startup, returning 404.
The symlink in `~/.config/opencode/plugins/` alone is sufficient;
the entry in `opencode.jsonc` is no longer required and should not
be present.

**How to verify:**

```bash
grep "opencode-rich-presence" ~/.config/opencode/opencode.jsonc ~/.config/opencode/opencode.json 2>/dev/null
# Expected: empty output. If a line appears, you have the stale entry.
```

**Fix:**

- v3 Phase 2: Run `opencode-rpc install` and accept the prompt
  to remove the stale entry (default Y). Or run
  `opencode-rpc uninstall` which auto-removes it.
- v2.0.5 users: Edit `~/.config/opencode/opencode.jsonc` (or
  `.json`) and remove the `"opencode-rich-presence"` line from
  the `"plugin"` array manually.

### Plugin fixes applied but Discord still does not show

**Symptom:** Code path is fixed, install looks correct, but Discord
stays empty.

**Root cause:** Node ESM caches loaded modules. An already-running
OpenCode process holds the OLD paths.js in memory even after you
reinstall and edit the file on disk. The fix is in the file but not
in the running process.

**How to verify:** Check if a previous OpenCode process is still
running:

```bash
ps aux | grep opencode | grep -v grep
```

**Fix:** Restart OpenCode. Fully exit (Ctrl+C or `/exit` in
OpenCode), then start a fresh `opencode` process. The new process
re-imports paths.js with the fixed path.

### JSONC parser treats `://` in URLs as a comment

(Phase 2: not applicable. Phase 2 does not parse JSONC from the
config files.)

### Install hangs at confirmation prompt

**Symptom:** `opencode-rpc install` shows `Overwrite? [y/N]` and
never returns. Keyboard input has no effect.

**Root cause:** The prompt helper was creating and closing a new
readline interface for every prompt. Multiple short-lived
interfaces on the same stdin confuses interactive input on some
Node versions (especially under Bun).

**Fix:** Use a single long-lived readline interface created on first
prompt and reused across all prompts. (Already fixed in v2.0.5+;
Phase 2 inherits this fix.)

### CLI hangs after `Done.` until Ctrl+C

**Symptom:** The uninstall command prints everything and ends with
`Done.`, but the prompt does not return. Pressing Ctrl+C is
required.

**Root cause:** A readline interface is still open (held by the
readline event loop). Node waits for the interface to close before
exiting.

**Fix:** Call `process.exit(0)` after the CLI command completes
successfully in `bin/opencode-rpc.js`. Forces Node to exit
regardless of pending handles.

### npm install in installer produces a lot of warnings

(Phase 2: not applicable. Phase 2 has no npm dependency to
install.)

### Phase 2: Display works on odd cycles, fails on even cycles

**Symptom:** Open opencode, fire AI, Discord shows presence. Exit
opencode. Open again, fire AI, Discord does not show. Exit. Open
again, fire AI, Discord shows. Pattern repeats: odd cycles work, even
cycles fail.

**Root cause:** EPIPE on closed stderr pipe. The daemon was spawned
with `stdio: ["ignore", "ignore", "pipe"]`, piping its stderr to the
parent plugin process. When the parent opencode exited, the OS
closed its end of the pipe. The next stderr write from the daemon
(every `logToFile` call) threw EPIPE, which Node 15+ escalates to an
uncaughtException by default. The daemon called `process.exit(1)` and
died. The next opencode launch then spawned a fresh daemon (new
Discord handshake), which sometimes hit Discord's app-id cooldown
and dropped the first SET_ACTIVITY, producing the "every other cycle
fails" symptom.

**How to verify:**
```bash
tail -f ~/.config/opencode/presence-activity.log | grep -E "EPIPE|uncaughtException|exit code|daemon starting"
```
Look for:
- `uncaughtException: Error: write EPIPE at logToFile ... at handleClientMessage ...`
- `exit code=1` shortly after
- Multiple `daemon starting` entries (one per crash cycle)

**Fix:** v3.0.4-phase2 and later change the daemon's `stdio` to
`["ignore", "ignore", "ignore"]` so no stderr pipe is created, plus
a defensive EPIPE catch in `logToFile` that re-throws only non-EPIPE
errors. Daemon logs go to the activity log via `appendFileSync`, so
stderr is redundant.

**Lesson (for future debugging):** When a long-lived child process
crashes silently after the parent exits, check `stdio` configuration.
A piped stdio fd is a Linux pipe: the parent's exit closes it, and
the child's writes become EPIPE. For long-lived children, prefer
`stdio: "ignore"` or redirect to a log file.

---

## Quick Diagnostic Checklist

When something looks wrong, walk through this in order:

1. **Plugin symlinked?**
   ```bash
   opencode-rpc info | grep -A2 "OpenCode plugin symlink"
   ```
   Should show `Linked: yes` and a `Target:` path. If `Linked: NO`,
   run `opencode-rpc install` to create the symlink.

2. **Plugin loaded by OpenCode?**
   ```bash
   ls -la ~/.config/opencode/plugins/opencode-rich-presence.js
   tail -20 /tmp/opencode-rich-presence-debug.log
   ```
   Symlink should exist. Debug log should show plugin load.

3. **Activity log growing?**
   ```bash
   ls -la ~/.config/opencode/presence-activity.log
   tail -20 ~/.config/opencode/presence-activity.log
   ```
   The file should grow on every event. If it is empty or stale,
   the plugin is not running.

4. **Per-instance state file present?**
   ```bash
   opencode-rpc info | grep "presence-state-pid"
   ```
   Each running OpenCode instance should have a corresponding
   state file. If absent, the plugin did not initialize.

5. **Discord Desktop running?** (Phase 2+)
   The plugin can only push presence if Discord Desktop is open
   with the IPC socket available. Phase 2 requires Discord
   for push (Phase 1 did not push).

6. **Daemon still alive across multiple opencode cycles?**
   Phase 2 is meant to keep one daemon alive across many
   opencode launches. Verify:
   ```bash
   tail -100 ~/.config/opencode/presence-activity.log | grep -E "daemon starting|exit code|uncaughtException"
   ```
   Expected on a healthy install:
   - One `daemon starting` line (or one per `opencode-rpc restart`).
   - Zero `exit code=1` lines.
   - Zero `uncaughtException` lines.

   If you see multiple `daemon starting` lines interleaved with
   `exit code=1`, the daemon is crashing every cycle. The most
   likely cause on v3.0.4+ is exhausted Discord rate-limit recovery
   window. On older v3.0.3 and below, see "Display works on odd
   cycles but fails on even cycles" above for the EPIPE bug.
