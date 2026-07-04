# opencode-rich-presence

Custom instructions for AI agents working on this project.
General writing/workflow rules are in `~/.config/opencode/AGENTS.md`.
This file covers project-specific details that future agents will
need to navigate this codebase safely.

## Project Facts

- **Plugin name**: `opencode-rich-presence`
- **CLI command**: `opencode-rpc`
- **Latest version**: v2.0.9
- **Node.js**: 18+ required, tested with 24.x
- **npm registry**: package is NOT published there. Distributed
  only via GitHub Releases tarballs.
- **Repository**: github.com/Khip01/opencode-rich-presence
- **Plugin author Discord App ID** (default fallback in
  config-resolver.js): `1512803991300476989`
- **Asset key** (Discord rich presence image):
  `opencode-logo-too-rich-presence`

## Project Structure

- `src/plugin/`: Main plugin code
  - `index.js`: plugin entry, event handlers, orchestration
  - `coordinator.js`: leader election via file lock + heartbeat
  - `template-engine.js`: variables, conditionals, render helpers
  - `config-resolver.js`: load discord-config.json + env vars
  - `session-state.js`: per-session token/cost/state tracking
  - `worker-spawner.js`: cross-platform node binary discovery, spawn worker
  - `discord-service.js`: worker lifecycle + activity push
- `src/worker/discord-worker.mjs`: subprocess using @xhayper/discord-rpc
- `src/cli/`: CLI commands
  - `install.js`, `uninstall.js`, `restart.js`, `update.js`
  - `info.js`, `help.js`, `version.js`, `dispatcher.js`, `prompt.js`
- `src/cli/platform/`: per-OS restart logic (`linux.js`, `macos.js`, `windows.js`)
- `src/shared/`: `paths.js`, `constants.js`, `logger.js`
- `bin/opencode-rpc.js`: CLI entry point
- `docs/`: documentation
  - `CLI-REFERENCE.md`, `INSTALL.md`, `ARCHITECTURE.md`
  - `PLATFORM-NOTES.md`, `TROUBLESHOOTING.md`, `CUSTOMIZATION.md`
- `.github/workflows/`: CI
  - `test.yml`: runs matrix on linux/macos/windows x node 18/20/22
  - `release.yml`: runs on tag push, builds tarball, creates GitHub release
- `scripts/`: `smoke-test.js`, `syntax-check.js`, `check-pkg.js`

## Critical Implementation Details

### Plugin Loading

OpenCode loads the plugin from
`~/.config/opencode/plugins/opencode-rich-presence.js`. This is a
symlink created by `opencode-rpc install` that points to the npm
global install location. The package is NOT on the npm registry, so
OpenCode's default auto-install via Bun returns 404. The symlink
bypasses this entirely.

**NEVER add `opencode-rich-presence` to the `plugin` array in
`~/.config/opencode/opencode.jsonc` (or `.json`).** OpenCode reads
that array as a list of npm packages to fetch on startup, and the
package is not on npm. The entry would cause a 404 notification on
every OpenCode launch. v2.0.6+ never writes the entry, migrates
v2.0.5-era stale entries on next install (offered, default Y), and
auto-removes on uninstall.

If the symlink is missing, run `opencode-rpc install` to recreate
it. Verify with `ls -la ~/.config/opencode/plugins/`.

### Worker Path

The worker path in `src/shared/paths.js` uses:
```
fileURLToPath(new URL("../worker/discord-worker.mjs", import.meta.url))
```

This is `../worker/` (one level up from `src/shared/`). NEVER change
to `../../worker/`. That resolves outside the package and causes
`MODULE_NOT_FOUND` errors when spawning the worker subprocess. This
bug was hit in v2.0.0-v2.0.4 and is fixed in v2.0.5.

### JSONC Parser

Use negative lookbehind on `:` so URLs are not treated as line
comments:
```
/(?<!:)\/\/.*$/gm
```

This handles URLs like `"https://opencode.ai/config.json"` correctly.
Always preserve this lookbehind when modifying JSONC handling.

### Multi-instance Leader Election

The plugin uses activity-based leader election since v2.0.7. Pre-v2.0.7
was first-wins and broke multi-window workflows: a previously idle
leader kept showing stale presence while another instance was
actively generating messages.

The flow (in `coordinator.js`):

- Lock at `~/.config/opencode/.opencode-rich-presence.lock` carries
  `{pid, started, lastActivity}`. Leader heartbeat rewrites it every
  5s with current `lastActivity`.
- Standby instances poll every 2s (`HANDOFF_CHECK_INTERVAL`) for lock
  release or staleness. Stale threshold: 15s (`HEARTBEAT_TIMEOUT`).
- When a standby receives a chat.activity event
  (`chat.message`, `message.part.updated`, `permission.asked`,
  `permission.replied`, busy `session.status`), it calls
  `coordinator.markActive()` to update its local `lastActivity` and
  `coordinator.requestHandoff()` to write the handoff signal at
  `~/.config/opencode/.opencode-rich-presence-handoff`.
- Leader's heartbeat reads the handoff signal each tick. If the
  request is from a different PID with `requestedAt` newer than the
  leader's `lastActivity`, the leader releases the lock. The standby
  picks it up on its next poll.

`index.js` registers a leadership-change callback that calls
`startConnect()` on gain and `shutdownWorker()` on loss so the
Discord worker actually starts/stops on transitions. `shutdownWorker()`
is distinct from `destroy()`: it does NOT permanently dispose the
service so the instance can re-acquire leadership later.

The `chat.message` and event handlers use a `noteActivity()` helper
that combines `markActive()` + `requestHandoff()`. Add new activity
events there, not directly in `coordinator`.

### Restart Command

`opencode-rpc restart` only writes the restart signal and kills
the worker subprocess. It does NOT touch Discord Desktop. To
restart Discord itself, the user must close and reopen it manually.

Cross-platform worker kill:
- Linux/macOS: `pgrep` + `kill`
- Windows: `wmic` + `taskkill`

### Uninstall Command

`opencode-rpc uninstall`:
- Removes runtime files (`lock`, `presence-state.txt`, `.discord-restart-request`)
- Removes the local plugin symlink at `~/.config/opencode/plugins/`
- Removes `@xhayper/discord-rpc` from local `package.json` and runs
  `npm install` to prune it from `node_modules`
- Asks Y/N before deleting `discord-config.json` (with timestamp
  backup if yes)
- Prints a code snippet showing how to remove the plugin entry
  from `opencode.jsonc`

### Environment Variables

- `DISCORD_APP_ID`: override Discord App ID (highest priority)
- `DISCORD_LARGE_IMAGE_KEY`: override Discord asset key
- `DISCORD_LARGE_IMAGE_TEXT`: override asset hover text
- `OPENCODE_RICH_PRESENCE_DEBUG`: enable verbose plugin logging
- `OPENCODE_RPC_DEBUG`: print CLI stack traces on errors
- `OPENCODE_CONFIG_DIR`: override OpenCode config dir

## Build, Test, and Verify

Before proposing any commit:
1. `node scripts/smoke-test.js` (verifies 32 files, package, CLI)
2. `node scripts/syntax-check.js` (verifies 25 JS/MJS files parse)
3. End-to-end CLI test of any changed behavior (install, restart,
   info, etc.)
4. Documentation matches actual code behavior, not imagined
   examples

## Commit Message Convention

In addition to the global rules in `~/.config/opencode/AGENTS.md`:
- Body sections use `Fix:` for bug fixes, `Feat:` for new features,
  `Chore:` for maintenance, `Docs:` for documentation only
- Each section has short bullets, one line per change
- Point to `CHANGELOG.md` for detailed info, do not duplicate it

## Known Bugs to Avoid Reintroducing

- Worker path with wrong number of `../` levels (see "Worker
  Path" above). Symptom: plugin acquires lock but Discord never
  shows presence; debug log shows `Cannot find module ... worker/`.
- JSONC regex matching `://` in URLs as comments. Symptom: `info`
  cannot parse `opencode.jsonc` with URLs.
- Hardcoded `/tmp` instead of `os.tmpdir()` for the debug log.
  Already fixed; do not regress.
- Multiple short-lived readline interfaces per prompt. Symptom:
  install hangs at overwrite prompt. Already fixed; the prompt
  helper uses a single long-lived interface.
- Bash scripts in the project root (the v1.0.0 era). Long gone,
  but the docs still mention migration. Do not reintroduce.
- Adding `opencode-rich-presence` to the `plugin` array in
  `opencode.jsonc` (or `.json`). Symptom: every OpenCode startup
  triggers a `Failed to install plugin opencode-rich-presence@latest:
  404 Not Found` notification. OpenCode reads the array as a list
  of npm packages to fetch on startup, and the package is not on
  npm. Fixed in v2.0.6: `install` no longer writes the entry, and
  detects/offers removal of v2.0.5-era stale entries on upgrade.
  `uninstall` auto-removes stale entries as part of cleanup.
- Sending `child.kill("SIGTERM")` (or any signal) to a Node.js
  ChildProcess reference after the child has already exited. Symptom
  was `Worker exited: code=null sig=SIGTERM` for the new leader's
  worker right after a leadership handoff. Linux reuses PIDs as
  soon as a process exits, so the old leader's cached reference
  could resolve to an unrelated new process and signal-kill it.
  Fixed in v2.0.8: `shutdownWorker()` polls `child.exitCode` and
  `child.signalCode` for up to 2s and only force-kills if the
  worker is genuinely still alive. Use this same polling pattern
  whenever sending a signal to a child process; do not assume the
  child is still alive just because the reference exists.
- Handoff-on-every-event oscillation. Symptom was Discord presence
  flickering every few seconds with multiple active OpenCode
  windows. Every instance received every SDK event, so every event
  triggered `requestHandoff()` from any standby instance, and the
  leader yielded as soon as the standby's `lastActivity` was
  fresher. Fixed in v2.0.8: `LEADER_COOLDOWN_MS` (8s) prevents the
  freshly-promoted leader from yielding for that window, and only
  user-initiated events (`chat.message`, `permission.asked`,
  `permission.replied`) request handoff via `noteActivity()` without
  `requestHandoff: false`. Agent-side events (`message.part.updated`,
  `message.updated`, `session.status busy`) only `markActive`.
- Worker exits without sending `clearActivity` to Discord. Symptom
  was Discord presence staying visible after OpenCode exited (the
  "stuck display" the user had to quit-and-reopen Discord to fix).
  Fixed in v2.0.8-rc3: the worker's `shutdown` command handler and
  `SIGINT`/`SIGTERM` handlers now call `clearActivity()` before
  `client.destroy()`. A `shuttingDown` flag suppresses the resulting
  `disconnected` event's reconnect attempt so the worker exits
  cleanly. Same pattern applies whenever you add a new exit path to
  the worker: set `shuttingDown = true` first to prevent the
  reconnect loop.
- `destroy()` (plugin dispose path) sending `SIGTERM` 200ms after
  shutdown command regardless of exit state. Symptom was
  `Worker exited: code=null sig=SIGKILL` in the debug log during
  plugin dispose (similar to the SIGTERM-after-exit race in
  `shutdownWorker` that v2.0.8-rc1 fixed). v2.0.8-rc3 also fixed
  `destroy()` to use the same poll-for-exit pattern: poll
  `child.exitCode` / `child.signalCode` for up to 2s and only
  force-kill if still alive. Use this polling pattern whenever you
  send a signal to a Node.js `ChildProcess`.
- Spawning the worker only AFTER becoming leader. Symptom was
  Discord presence being torn down and rebuilt on every terminal
  switch (the standby that took over leadership had to spawn a fresh
  worker, log into Discord, and only then push its first activity,
  causing a 1-3s "display gone" gap every handoff). Fixed in
  v2.0.8-rc4 with `prepareConnect()`: standby instances pre-spawn
  their worker on user-initiated events (`chat.message`,
  `permission.asked`, `permission.replied`) so the worker is already
  retrying Discord login by the time leadership transfers. When
  adding a new user-initiated event handler that should pre-spawn,
  call `prepareConnect(config)` inside the handler.
- `opencode-rpc update --prerelease` reporting "Already up-to-date"
  when the user's installed package was a stable `v2.0.8` and the
  latest GitHub release was a prerelease like `v2.0.8-rc4`. Root
  cause: `parseSemver` strips the `-rc4` suffix and the numeric
  comparison returned 0. Fixed in v2.0.8-rc5: when `--prerelease`
  is set, also compare the tag itself so a stable-to-prerelease
  upgrade on the same base version is detected.
- Sending `SIGKILL` to a Node.js ChildProcess reference after the
  worker has actually exited. Even with the polling pattern added in
  v2.0.8-rc1/v2.0.8-rc3, there is a window where the worker process
  has exited at the OS level but Node.js has not yet dispatched the
  `exit` event to the parent. `wp.exitCode` is still `null` during
  this window, the parent would still send `SIGKILL`, and Linux
  could have already recycled the PID to the next leader's worker.
  The user observed the new leader's worker dying with
  `code=null sig=SIGKILL` right after a handoff. Fixed in v2.0.8-rc5:
  remove the SIGKILL-after-grace fallback. If the worker hangs, it
  becomes an orphan (cleaned up when its parent exits) but we never
  risk killing an unrelated process. NEVER call `child.kill()`
  after the worker has logically exited.
- First-wins leader election. Symptom: a previously idle leader
  shows stale Discord presence while another instance is actively
  chatting. Pre-v2.0.7 held the lock indefinitely until exit or
  15s stale; standby could not push. Fixed in v2.0.7 with
  activity-based handoff (standby writes handoff signal on
  chat.message, leader's heartbeat reads it and yields if the
  request is fresher than its own activity).

## Documentation Maintenance

When the project changes in ways that affect how an agent should
work on this codebase, update the relevant documentation IN THIS
ORDER before proposing a commit:

1. The code itself (source files, tests, scripts)
2. `docs/CLI-REFERENCE.md` (commands and example output)
3. `docs/INSTALL.md` (install flow)
4. `docs/ARCHITECTURE.md` (architecture diagrams and flow)
5. `docs/PLATFORM-NOTES.md` (per-OS notes, only if changed)
6. `docs/TROUBLESHOOTING.md` (add to root causes section if a new
   bug class is found)
7. `CHANGELOG.md` (final, user-facing summary of what changed)
8. This project-level `AGENTS.md` (if the change affects project
   facts, structure, critical implementation details, or known bugs)
9. The global `~/.config/opencode/AGENTS.md` (if the change affects
   general working conventions, not just project specifics)
10. Commit the changes with a Conventional Commits message

Both AGENTS.md files are PART of the maintenance cycle, not
one-time setup documents. Future agents reading them should trust
that they reflect the current project state.

When pushing AGENTS.md to the remote repo:
- This project-level `AGENTS.md` is COMMITTED to git so the team
  shares it
- The global `~/.config/opencode/AGENTS.md` is personal and stays
  local (per OpenCode docs)

## Lessons Learned (across v2.0.x development)

Patterns that bit us during the v2.0.6 -> v2.0.8 redesign cycle.
Future agents working on this project should keep these in mind,
especially when adding new worker lifecycle code or
multi-instance features.

### Study prior versions before redesigning

When the user reports a regression after a redesign, the FIRST thing
to do is `git log --oneline` and read the previous design (use
`gh release view <tag>` or `git show <tag>:path`). The user
explicitly asked the v2.0.8 author to look at v2.0.6 because the
simpler design worked better for their use case. Several rounds of
"smart" complex fixes later, we ended up with the simple design
plus a small set of targeted improvements. If the user pushes back
on complexity, the answer is usually less, not more.

### Discord IPC is single-connection per Application ID

This is a hard constraint set by Discord, not something we can
bypass. Every leadership handoff requires:
1. Old worker disconnects from Discord IPC
2. Discord sees socket close, may take a moment to consider the
   presence "stale" (or keeps showing it depending on timing)
3. New worker opens a new IPC connection
4. Login handshake with Discord (1-3 seconds typically)

There is no way to "transfer" the connection between processes.
The ONLY way to make multi-instance handoff look seamless to the
user is one of:
- **Daemon architecture**: a long-running worker daemon holds the
  Discord connection; OpenCode instances connect to it. Most
  invasive but eliminates reconnect entirely.
- **Pre-spawned worker** (current v2.0.8+ approach): standby spawns
  its worker ahead of becoming leader, so it is already mid-login
  when the leader releases. Reduces the gap to one Discord login
  handshake (~1-3s, depends on Discord IPC state and network).
- **Accept the gap**: shows as "display offline then back online"
  during terminal switching. What v2.0.7 and earlier did.

If a future redesign wants truly seamless handoff, the daemon
approach is the only option. The pre-spawn approach is a
reasonable compromise that keeps the architecture simple.

### Node.js ChildProcess + Linux PID reuse = never call .kill() after exit

Even with `wp.exitCode !== null` polling, there is a small window
where the worker process has exited at the OS level but Node.js
has not yet dispatched the `exit` event back to the parent. During
this window, `wp.kill("SIGTERM")` will send the signal to a PID
that has already been recycled by the OS (Linux reuses PIDs as
soon as a process exits). The next leader's worker, having spawned
with the recycled PID, will then die with `code=null sig=SIGKILL`.

Rule: NEVER call `child.kill()` on a Node.js ChildProcess after the
child has logically exited. If you must signal, check
`wp.exitCode === null && wp.signalCode === null` AND consider
the polling window. v2.0.8-rc5 dropped the SIGKILL-after-grace
fallback entirely because the polling window is unavoidable.

### semver parsing for prerelease

`parseSemver(/^v?(\d+)\.(\d+)\.(\d+)/)` strips everything after
the patch number, including `-rc4` suffixes. This means
`v2.0.8` and `v2.0.8-rc4` compare as equal numerically. When the
update command needs to distinguish them, also compare the tag
itself AND check the prerelease status separately.

Decision rules in `update.js` (v2.0.9):
- `cmp > 0` (strict numeric upgrade) -> update.
- `cmp < 0` (current is newer) -> skip.
- `cmp === 0`, current is prerelease, latest is stable -> update (prerelease -> stable is a normal upgrade; does NOT require `--prerelease`).
- `cmp === 0`, current is stable, latest is prerelease -> only update with `--prerelease` (do not auto-bump a stable user to a prerelease).
- `cmp === 0`, both are prereleases, `--prerelease` set -> update only if the tag suffix differs (rc4 -> rc5).

The previous "skip if sameBase" logic in v2.0.8 and earlier had a
bug where a user on `v2.0.8-rc5` running `opencode-rpc update`
(no flag) would be told "Already up-to-date" even though the
matching `v2.0.8` stable was available, because `parseSemver`
returned `[2,0,8]` for both and `compareSemver` returned 0. The
user had to run `opencode-rpc update --prerelease` to upgrade
from rc to stable, which was the opposite of the intended UX.

When introducing a new prerelease tag scheme, document it in
`update.js` so the comparison logic stays correct, and add a
test case to `scripts/test-update.mjs` (or wherever you keep
comparison logic tests).

### Multi-process coordination requires polling, not events

Standby instances cannot subscribe to "leader released the lock"
as an event because they are separate processes with no shared
event bus. They must poll the lock file. Trade-offs:
- Fast polling (1s) is responsive but uses more CPU/wakeups
- Slow polling (5s+) saves power but increases handoff latency

v2.0.8-rc2 introduced dual-rate polling: slow (1s) when idle,
fast (250ms) for 8s after `markActive` / `requestHandoff`. This
keeps idle instances cheap while letting an active standby
acquire the lock within ~250ms.

If you change `HANDOFF_CHECK_INTERVAL` or `ACTIVE_HANDSHAKE_INTERVAL`,
also adjust `FAST_POLL_WINDOW_MS` to match the expected active
duration. The cooldown (`LEADER_COOLDOWN_MS`) should be roughly
2x the active poll window or shorter, otherwise the leader
ignores the standby's handoff request before it has time to
react.

### Test in multi-process sandbox before shipping

Single-process tests miss most of the multi-instance bugs we hit:
PID reuse races only manifest with concurrent processes. The
two-process sandbox test in this codebase is essential:

```js
// Two processes, separate OPENCODE_CONFIG_DIR, run in parallel,
// have B request handoff after A becomes leader.
const leader = spawnNode(leaderScript);
sleep(1);
const standby = spawnNode(standbyScript);
waitFor(standby); // wait for handoff completion
```

Future agents adding features that touch the coordinator should
add a sandbox test before shipping.

### User's UX expectations beat clever engineering

The user explicitly said: "v2.0.6 was smooth, v2.0.7+ flickers."
That is the most important feedback. Smoothness of state
transitions matters more than the technical correctness of
leader election. If the user's UX expectation is "state updates
should feel real-time without display restart", work backward
from there:

- v2.0.6 achieved this by never changing leaders (first-wins)
- v2.0.8+ achieves this by pre-spawning workers so handoff
  latency is dominated by Discord IPC handshake, not worker
  lifecycle

If a future agent proposes a redesign that introduces a new
"display restart" feel, expect pushback. Document the change in
CHANGELOG and AGENTS.md so the trade-off is visible.

### Pre-release workflow for risky changes

The user requested `--prerelease` workflow for the v2.0.8 series
specifically because each iteration needed real-world testing
before promotion to stable. This pattern is now part of the
release pipeline (see `.github/workflows/release.yml`):

- Tags with `-rc`, `-beta`, `-alpha` suffixes are marked as
  prerelease on GitHub
- `opencode-rpc update` (no flag) does NOT pick them up
- `opencode-rpc update --prerelease` picks them up

When making a non-trivial change, default to:
1. Commit + tag as `v2.0.X-rc1`
2. Wait for user testing
3. Iterate with `-rc2`, `-rc3`, etc.
4. Tag the same (or final) commit as `v2.0.X` for stable

Do NOT skip straight to stable for changes that touch worker
lifecycle or leader election. The user has explicit "test before
stable" preference.

### Build, Test, and Verify requires an actual Discord IPC handshake

`node scripts/smoke-test.js` and `scripts/syntax-check.js` only
verify file structure and basic CLI behavior. They DO NOT verify
the worker actually connects to Discord. To verify the worker
logic end-to-end, you need:
- A running Discord Desktop with the App ID
- A real IPC socket (`/tmp/discord-ipc-0` on Linux)
- The worker process spawned via the plugin

If you can't run a real Discord connection, at minimum verify:
- Worker starts and logs "Worker started, APP_ID=..."
- `client.login()` is called
- shutdown handler exits within 2s

The plugin's debug log at `/tmp/opencode-rich-presence-debug.log`
is your friend here. `grep "Worker exited" /tmp/opencode-rich-presence-debug.log`
will show you every worker exit and its exit code.

### Plugin dispose fires `dispose` async; everything inside must await

`index.js`'s dispose is an async function. If you add async work
in the dispose callback (e.g. cleanup, worker teardown), it MUST
be awaited or the Node.js process will exit before the cleanup
completes. The current dispose does:
- `clearInterval(refreshTimer)` (sync)
- `clearInterval(activityTimer)` (sync)
- `coordinator.stopStandbyPolling()` (sync)
- `await coordinator.release()` (await!)
- `await discordDestroy()` (await!)

If you add new async cleanup (e.g. flushing state to disk), add
it before the two awaits and remember to test that the Node.js
process does not exit before the cleanup finishes. The debug log
will help: if you see "Disposing..." but no "Released leader
lock", the process exited before the await completed.
