# opencode-rich-presence

Custom instructions for AI agents working on this project.
General writing/workflow rules are in `~/.config/opencode/AGENTS.md`.
This file covers project-specific details that future agents will
need to navigate this codebase safely.

## Project Facts

- **Plugin name**: `opencode-rich-presence`
- **CLI command**: `opencode-rpc`
- **Latest version**: v2.0.8-rc4
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
