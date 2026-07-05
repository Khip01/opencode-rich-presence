# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0-phase1] - Unreleased

Phase 1 of the v3 redesign. **No Discord push in this release.** The
plugin only collects local state, renders presence payloads, and writes
a comprehensive chronological activity log so the user can verify the
plugin's behavior end-to-end before Phase 2 wires the actual Discord
push via a daemon subprocess.

This is a deliberate step back from the v2.x per-session worker
architecture. The user reported that multi-terminal handoff
("display disappears then reappears") could not be fixed without
removing the cause (per-session worker = per-handoff reconnect).
Phase 1 establishes the local-first diagnostic surface; Phase 2 adds
the daemon that eliminates the reconnect on handoff.

### Removed

- Discord push. No subprocess worker, no Discord IPC, no
  `@xhayper/discord-rpc` dependency. The plugin still renders the
  presence payload but logs it instead of pushing it.
- `src/worker/discord-worker.mjs`. Replaced by Phase 2's daemon.
- `src/plugin/discord-service.js`. Replaced by
  `src/plugin/local-presence.js` (render + log only).
- `src/plugin/coordinator.js`. No leader election in Phase 1;
  each OpenCode instance is independent.
- `src/plugin/worker-spawner.js`. No worker subprocess to spawn.
- v2.x `prepareConnect()`, `shutdownWorker()`, `destroy()`,
  `startConnect()`, `getStatus()` exported from
  `discord-service.js`. None of these are needed in Phase 1.
- `LOCK_FILE` and `HANDOFF_REQUEST` runtime files (the leader
  election infrastructure that backed them is gone).

### Added

- **Activity log** at `~/.config/opencode/presence-activity.log`.
  Append-only chronological log of every plugin action. Each entry:
  `[ISO timestamp] [pid N] [tag] message`. Tags include `load`,
  `config`, `models`, `restore`, `event`, `state`, `session`,
  `stats`, `queue`, `display`, `template`, `check`, `push`,
  `presence`. PID tagging lets the user `grep "\[pid 12345\]"` to
  follow one OpenCode instance when multiple are open.
- `src/plugin/local-presence.js`. Renders the presence payload
  (template + variables) and logs the result as a `would-push`
  entry. Phase 2 will replace the log call with a daemon send
  call; the render logic stays unchanged.
- **Per-instance state files** at
  `~/.config/opencode/presence-state-pid<pid>.txt`. Each OpenCode
  instance writes its own file with its own snapshot, so
  multi-instance runs do not race on a single shared file.
- `opencode-rpc info` now tails the last 30 activity-log entries
  inline and lists per-instance state files. This makes the
  activity log the de facto diagnostic surface.
- `opencode-rpc restart` now rotates the activity log (renames to
  `.prev`) so the user can start fresh. Phase 2 will redefine it
  to manage the daemon subprocess.
- `opencode-rpc uninstall` now removes the activity log, all
  per-instance state files, and the legacy lock file.

### Changed

- All event handlers in `src/plugin/index.js` (`chat.message`,
  `session.created/updated/deleted/status/idle`,
  `message.updated/part.updated`, `permission.asked/replied`) now
  log every event with key fields and only log state transitions
  on actual state changes (no spam on every event).
- `src/shared/logger.js` adds an `activity(tag, message)` helper
  for structured log entries. Existing `log()` continues to write
  to the debug log for backward compatibility.
- `src/cli/install.js` no longer adds `@xhayper/discord-rpc` to
  `~/.config/opencode/package.json`. There are no runtime
  dependencies in Phase 1.
- `src/cli/uninstall.js` no longer prunes `@xhayper` from
  `~/.config/opencode/node_modules/`. Phase 1 has no runtime deps
  to clean up.
- `src/cli/restart.js` no longer kills a worker subprocess (there
  is no worker). It now rotates the activity log.

### Documentation

- `AGENTS.md` rewritten for Phase 1. Documents the activity log
  format, the per-instance state file naming, the rationale for
  removing the per-session worker, and the lessons learned from
  the v2.0.x -> v3 redesign effort.
- `docs/ARCHITECTURE.md` rewritten for Phase 1. Documents the
  no-subprocess design, the multi-instance behavior, the activity
  log format, and a Phase 2 preview of the daemon architecture.
- `docs/TROUBLESHOOTING.md` adds a Phase 1 section on how to read
  the activity log, plus Phase-1-specific root causes (events
  seen but no state transition, activity log empty even though
  OpenCode is running, etc.).
- `README.md` updated to reflect the Phase 1 status (no Discord
  push yet) and the install command for the redesign branch.

## [2.1.1] - 2026-07-04

Patch release. v2.1.0 was tagged with a broken `src/cli/update.js` (see "Fixed" below), so this release also ships the originally-intended fix plus the four features that landed on `main` between the v2.1.0 tag and this commit: the `--stable` flag, the `.install-channel` marker written by `update`, the channel suffix in `version` output, and the marker bootstrap in `bin/opencode-rpc.js`.

### Added

- `opencode-rpc update --stable` flag. Skips version comparison and always installs the latest stable release tag. Use this to switch back to the stable channel when you have been running on `update --dev` mode and want to pin to a tagged release without manually looking up the tag yourself. `--stable` and `--dev` are mutually exclusive: passing both exits with code 2 and a clear error message, following POSIX Guideline 11 and modern CLI conventions (cargo, kubectl, npm).
- `opencode-rpc update` (all paths: default, `--stable`, `--dev`) writes a `.install-channel` marker file inside the installed package recording the install channel (`stable` for tag installs, `dev` for SHA installs), the ref used, and the install timestamp.
- `opencode-rpc version` reads the marker and appends the channel info to its output: e.g. `opencode-rich-presence v2.1.1 (stable)` or `opencode-rich-presence v2.1.1 (dev: 0f39f8a)`. Pre-v2.0.9 installs without a marker still show just the version. The marker lives inside the package directory (resolved via `npm root -g` rather than `import.meta.url` because the package is replaced during install and `import.meta.url` keeps the pre-install path).
- `bin/opencode-rpc.js` bootstraps a `.install-channel` marker on every CLI invocation if one doesn't already exist (defaults to `channel: "stable"`). This ensures `opencode-rpc version` shows channel info even for users who installed via `npm install -g <tarball>` directly without going through `opencode-rpc update`, and for pre-v2.0.9 installs that were upgraded in place. `.gitignore` excludes `.install-channel` as a safety net in case the marker is ever written into the repo working directory.

### Fixed

- v2.1.0's `src/cli/update.js` was tagged with the broken implementation that called `npm install -g <repo>#<ref>` directly. The clone+pack+install-from-tarball fix was committed AFTER the v2.1.0 tag was cut, so users who installed v2.1.0 and then ran `opencode-rpc update --dev` (or any other update path) hit `ENOTDIR: not a directory, rename ...` on npm v11. v2.1.1's `update.js` contains the intended fix for all paths: clone the repo, check out the requested ref, run `npm pack`, and `npm install -g` the resulting local tarball. Tarballs are not affected by the npm-v11 git-dep symlink bug. Also cleans up any leftover broken symlink at `lib/node_modules/opencode-rich-presence` before the install, so users with a broken state from v2.0.x or v2.1.0 recover automatically.

### Changed

- `src/cli/update.js cleanExistingInstall()` now resolves the install path via `npm root -g` (authoritative, works for nvm/asdf/volta/custom prefixes) instead of guessing from `NVM_BIN` / `process.execPath` / `npm_config_prefix`. Also uses `rmSync(..., { recursive: true, force: true })` which handles real directories, broken symlinks, and stale files uniformly (previously only unlinked the target, which silently failed for real directories).
- `src/cli/help.js` Update section now includes the `opencode-rpc update --stable` example alongside the existing `--dev` example; install example uses v2.1.1.

### Documentation

- `docs/INSTALL.md` adds a zsh quoting callout. zsh interprets `#` as a glob qualifier, so `npm install -g Khip01/opencode-rich-presence#v2.1.1` errors with "no matches found". The URL must be single-quoted: `npm install -g 'Khip01/opencode-rich-presence#v2.1.1'`. bash and fish users are unaffected.
- `docs/TROUBLESHOOTING.md` adds a new section "`opencode-rpc`: command not found after install" documenting how to recover from a broken-symlink state left by v2.1.0 (or by manual `npm install -g <repo>` without a ref).

## [Unreleased]

(none yet; current work is in [2.1.1])

## [2.1.0] - 2026-07-04

### Changed

- **Install workflow changed**: end users now install via `npm install -g Khip01/opencode-rich-presence#v2.1.0` instead of downloading a tarball from a GitHub Release URL. The repo at a specific tag is the install source, so there is no separate artifact to keep in sync with the source. The GitHub Releases workflow is preserved but its job-level `if` condition skips any tag containing `-rc` / `-beta` / `-alpha`; only stable tags create a GitHub Release (which now points users to the git install command and provides the tarball as a fallback for offline installs).
- There is no longer a separate "pre-release" channel (`-rc`, `-beta`, `-alpha` tags). Use `opencode-rpc update --dev` to test a fix before tagging stable.

### Updated

- `opencode-rpc update` now runs `npm install -g Khip01/opencode-rich-presence#<latest-stable-tag>` instead of downloading a tarball from the GitHub Release API. The internal download / extract / install pipeline is gone.
- Added `opencode-rpc update --dev` for developers: fetches the latest commit SHA on `main` and runs `npm install -g Khip01/opencode-rich-presence#<sha>`. No more waiting for a release tag to test a fix.
- Removed the `--prerelease` / `--pre` flag from `opencode-rpc update` (no more pre-release channel exists).

### Documentation

- All install instructions across README.md, docs/INSTALL.md, docs/CLI-REFERENCE.md, docs/TROUBLESHOOTING.md, and CHANGELOG.md updated to use the git-based install command.
- docs/CLI-REFERENCE.md `opencode-rpc update` section rewritten with three examples (up-to-date, stable update, dev update).

## [2.0.9] - 2026-07-04

### Fixed

- `opencode-rpc update` (without `--prerelease`) reported "Already up-to-date" when the user was on a prerelease build (e.g. `v2.0.8-rc5`) and the latest GitHub release was the matching stable (`v2.0.8`). Root cause: the previous version-comparison logic skipped any update where the numeric versions matched, without considering prerelease-to-stable transitions as a normal upgrade path. v2.0.9 replaces the binary "sameBase -> skip" with explicit decision rules:
  - `cmp > 0` (strict numeric upgrade) -> update.
  - `cmp < 0` (current is newer) -> skip.
  - `cmp === 0`, current is prerelease, latest is stable -> update (prerelease -> stable is a normal upgrade; does not require `--prerelease`).
  - `cmp === 0`, current is stable, latest is prerelease -> only update with `--prerelease` (so a user on stable v2.0.8 is not auto-bumped to v2.0.8-rc9).
  - `cmp === 0`, both are prereleases, `--prerelease` set -> update only if the tag suffix differs (e.g. rc4 -> rc5).
  - Otherwise -> up-to-date.

## [2.0.8] - 2026-07-03

Stable release. Cumulative fixes since v2.0.7 across five pre-release candidates (rc1 through rc5), all of which the user confirmed working in multi-instance testing:

### Fixed

- `discord-service.js:shutdownWorker()` no longer signal-kills an already-exited worker (PID-reuse race that was killing the new leader's worker with `code=null sig=SIGKILL` / `SIGTERM` right after a handoff).
- Multi-instance leader oscillation is dampened with `LEADER_COOLDOWN_MS` and by restricting handoff requests to user-initiated events only (`chat.message`, `permission.asked`, `permission.replied`). Agent-side events still `markActive` but do not request leadership.
- Multi-instance handoff latency reduced from ~5-8 seconds to ~250ms-1s by removing the 2-second fixed IPC delay, dropping `LEADER_COOLDOWN_MS` to 3s, reducing `HEARTBEAT_INTERVAL` to 2s, adding `ACTIVE_HANDSHAKE_INTERVAL` (250ms fast-poll) for standbys that recently marked themselves active, and reducing Discord worker retry backoff (initial 500ms, cap 5000ms).
- `discord-service.js:destroy()` now uses the same poll-for-exit pattern as `shutdownWorker()`, fixing `Worker exited: code=null sig=SIGKILL` during plugin dispose.
- New leader now waits 2 seconds before connecting (REMOVED in rc5; the SIGTERM-after-exit fix made it unnecessary), and forces `checkAllSessionsActivity()` after gaining leadership to refresh stale in-memory session states.
- Discord presence was "stuck" after OpenCode exited. Worker shutdown now calls `clearActivity()` before destroying the Discord client, and `SIGINT`/`SIGTERM` signal handlers do the same.
- New leader pre-spawns its worker via `prepareConnect()` on user-initiated events when standby, eliminating the "display torn down and rebuilt" feeling during terminal switching.
- `opencode-rpc update --prerelease` was reporting "Already up-to-date" when upgrading stable v2.0.8 to a prerelease on the same base version, because `parseSemver` stripped the prerelease suffix. Now compares both numeric and tag.

### Added

- Worker log messages are now forwarded into the parent's debug log (`[worker] ...` lines).
- `opencode-rpc update --prerelease` (alias `--pre`) opts in to GitHub releases marked as prerelease. Tags containing `-rc`, `-beta`, or `-alpha` are marked prerelease in `.github/workflows/release.yml` so stable `opencode-rpc update` does not pick them up. Use this flag to test pre-release builds before they are promoted to stable.

## [2.0.8-rc5] - 2026-07-03

### Fixed

- `opencode-rpc update --prerelease` was reporting "Already up-to-date" when the user's installed package was `v2.0.8` (stable) and the latest GitHub release was `v2.0.8-rc4` (prerelease) because `parseSemver` strips the `-rc4` suffix and the numeric comparison returned `0` (equal). v2.0.8-rc5 compares both the numeric version AND the tag, so a stable-to-prerelease upgrade on the same base version is now detected and offered.
- Discord worker was hanging for >2s during shutdown. The `shutdown` command handler called `await clearActivity()` followed by `await client.destroy()`, both of which could hang indefinitely if Discord's IPC socket was in a bad state. Without timeouts, the parent's `destroy()` / `shutdownWorker()` polled for 2s and then sent `SIGKILL`. v2.0.8-rc5 bounds both calls with a 1s timeout each, so the worker always exits within ~2.2s of receiving the shutdown command.
- Removed the `SIGKILL`-after-grace fallback from `discord-service.js:destroy()` and `shutdownWorker()`. Even with the polling pattern added in v2.0.8-rc3, there is a window where the worker process has exited at the OS level but Node.js has not yet dispatched the `exit` event to the parent. `wp.exitCode` is still `null` during this window, the parent would still send `SIGKILL`, and Linux could have already recycled the PID to the next leader's worker. The user observed exactly this symptom: the new leader's worker dying with `code=null sig=SIGKILL` (or `SIGTERM`) right after a handoff. v2.0.8-rc5 leaves the worker to exit naturally on its own; if it does hang, it becomes an orphan that gets cleaned up when its parent eventually exits.

## [2.0.8-rc4] - 2026-07-03

### Fixed

- Multi-instance handoff no longer restarts the Discord presence. Previously, every time the standby instance took over leadership, it would kill the old worker's Discord IPC connection (Discord sees this as the user going offline), spawn a new worker, and reconnect from scratch. Discord would briefly show no presence, then re-show it after the new login completed (1-3 seconds). From the user's perspective this looked like the display was being torn down and rebuilt on every terminal switch.
- v2.0.8-rc4 adds `prepareConnect()` in `discord-service.js`. When a standby instance receives a user-initiated event (`chat.message`, `permission.asked`, `permission.replied`), it pre-spawns its worker BEFORE becoming leader. The worker immediately tries to log in to Discord, fails (the IPC socket is still held by the current leader), and retries with the fast backoff (initial 500ms, cap 5s) configured in `discord-worker.mjs`. When the standby eventually becomes leader, its worker is already running and the next retry tick lands on a free IPC socket, so the only remaining delay is the Discord IPC handshake itself.

## [2.0.8-rc3] - 2026-07-03

### Fixed

- Discord presence was "stuck" after OpenCode exited. The worker's shutdown handler called `client.destroy()` without first sending a `clearActivity` IPC frame, so Discord never received a clear-presence command and kept showing the last activity. The user had to quit and reopen Discord to clear it. v2.0.8-rc3 makes the worker's `shutdown` command handler and the `SIGINT`/`SIGTERM` signal handlers call `clearActivity()` first, then `client.destroy()`. A `shuttingDown` flag suppresses the resulting `disconnected` event's reconnect attempt so the worker exits cleanly instead of looping on a reconnect timer.
- `discord-service.js:destroy()` had the same SIGTERM-after-exit race as `shutdownWorker()` did pre-rc1: it sent `SIGTERM` 200ms after the shutdown command regardless of whether the worker had exited. Replaced with the same poll-for-exit pattern used by `shutdownWorker` (poll `child.exitCode` / `child.signalCode` for up to 2s, only force-kill if still alive). This was the source of `Worker exited: code=null sig=SIGKILL` logs appearing during plugin dispose.

### Added

- Worker log messages are now forwarded into the parent's debug log. The parent plugin's debug file now shows `[worker] ...` lines for "Worker started", "Activity sent", "Replay activity failed", "Shutdown requested", "Discord READY event", "Discord disconnected", etc. This makes it possible to diagnose connection problems without enabling extra debug flags.

## [2.0.8-rc2] - 2026-07-03

### Fixed

- Handoff latency reduced from ~5-8s to ~250ms-1s. v2.0.8-rc1 had a 2-second fixed delay before the new leader connected to Discord, plus an 8-second `LEADER_COOLDOWN_MS` window where the leader ignored handoff signals, plus a 5-second leader heartbeat that bounded how often the handoff check ran. v2.0.8-rc2 removes the fixed delay (the previous leader's worker exits in milliseconds via the shutdown command, so no extra wait is needed), drops `LEADER_COOLDOWN_MS` to 3 seconds (just enough to debounce rapid chat bursts from the same user), and reduces `HEARTBEAT_INTERVAL` to 2 seconds so the handoff check fires twice as often.
- Standby polling switches to a fast 250ms interval (`ACTIVE_HANDSHAKE_INTERVAL`) for 8 seconds after the standby marks itself active. An actively-requesting standby now acquires the lock within a fraction of a second of the leader releasing, instead of waiting up to 2 seconds on the slow `HANDOFF_CHECK_INTERVAL` poll.
- Discord worker retry backoff is now much faster. Initial retry dropped from 3000ms to 500ms, and the cap dropped from 30000ms to 5000ms. The previous values made the new leader's worker sit idle for 3+ seconds after a Discord IPC handshake failed before retrying, which compounded the visible presence gap during handoff.

## [2.0.8-rc1] - 2026-07-03

### Fixed

- `discord-service.js:shutdownWorker()` no longer SIGTERMs (or SIGKILLs) the old worker after it has already exited. The previous implementation sent `kill("SIGTERM")` 200ms after the shutdown command regardless of whether the worker had exited. Because Linux reuses PIDs, the new leader's worker could spawn with the same PID as the old one and then receive a stray SIGTERM from the old leader's cached ChildProcess reference, killing it with `code=null sig=SIGTERM`. The new implementation polls `child.exitCode` and `child.signalCode` for up to 2s and only force-kills if the worker is genuinely still alive. Removes the "display closes when leader changes" symptom.
- Multi-instance leader oscillation is dampened with a leader cooldown. Previously, every instance saw every SDK event (`message.part.updated`, `session.status`, etc.), so any active instance would write a handoff signal every event, and the leader would yield as soon as its standby's `lastActivity` was fresher. With multiple active windows, leadership ping-ponged back and forth, causing visible Discord presence flicker every 5 seconds. The leader now ignores handoff signals for `LEADER_COOLDOWN_MS` (8 seconds) after becoming leader, so the active window keeps Discord presence for at least that long.
- `chat.message`, `session.created/updated`, `session.status`, `message.updated`, and `message.part.updated` now opt out of the handoff request by default (`noteActivity({ requestHandoff: false })`). Only `chat.message`, `permission.asked`, and `permission.replied` request handoff, because those are the events that indicate the user is actively interacting with this instance. Agent-side events still mark the instance active but do not request leadership, which further reduces oscillation.
- The new leader now waits 2 seconds before connecting to Discord, so the previous leader's worker has time to fully release the Discord IPC socket. Without this delay, the new worker could race against the still-cleaning-up old connection and fail its first login (it retries with backoff, but the user sees a presence gap).
- The new leader now forces `checkAllSessionsActivity()` after gaining leadership, so the in-memory session states are refreshed from the server. Previously, standby instances did not poll for activity (only the leader did), so a freshly-promoted standby could be showing a stale `Typing` state even though the model had already finished.

### Added

- `opencode-rpc update --prerelease` (alias `--pre`) opts in to GitHub releases marked as prerelease. Tags containing `-rc`, `-beta`, or `-alpha` are now marked prerelease in `.github/workflows/release.yml` so stable `opencode-rpc update` does not pick them up. Use this flag to test pre-release builds before they are promoted to stable.

## [2.0.7] - 2026-07-01

### Fixed

- Multi-instance leader election now uses activity-based handoff. Previously, the first OpenCode instance to start held the leader lock until exit or 15s of staleness. Standby instances never pushed to Discord, even when actively chatting. Result: a previously idle leader kept showing stale presence while another instance was actively generating messages.
- When a standby instance receives a `chat.message` (or any other activity-implying event), it writes a handoff signal at `~/.config/opencode/.opencode-rich-presence-handoff`. The current leader's heartbeat loop reads the signal on each tick and releases the lock if it sees a fresher request from a different PID. The standby then acquires the lock on its next 2s poll and starts pushing to Discord.
- A leadership-change callback in `index.js` calls `startConnect()` on gain and `shutdownWorker()` on loss so the new leader's Discord worker actually starts and the old leader's worker actually stops (without permanently disposing the service, so the instance can re-acquire leadership later).
- Added `discord-service.js:shutdownWorker()` for temporary teardown on leadership loss. Distinct from `destroy()` which is permanent and used only on plugin dispose. The new function sets an `intentionalShutdown` flag that the worker `onExit` handler reads to skip its respawn/retry logic.
- Added `src/plugin/coordinator.js:requestHandoff()` for standby instances to signal they want leadership, and `markActive()` to record local activity timestamps. Standby instances also poll every 2s for lock release or staleness so they take over automatically when the leader yields or crashes.
- Lock file format now includes `lastActivity` (timestamp). The leader's heartbeat writes its current `lastActivity` on each tick; the heartbeat uses this to decide whether a handoff request is fresher than its own activity.

### Changed

- The plugin's event handlers (`chat.message`, `message.part.updated`, `permission.asked`, `permission.replied`, `session.status` when busy, etc.) now call a `noteActivity()` helper that updates the local `lastActivity` timestamp and triggers a handoff request if the instance is a standby. Previously these events updated only the per-session state.

## [2.0.6] - 2026-07-01

### Fixed

- `opencode-rpc install` no longer adds `opencode-rich-presence` to the `plugin` array in `~/.config/opencode/opencode.jsonc` (or `.json`). The v2.0.5 install path wrote that entry, but OpenCode reads the array as a list of npm packages to fetch on startup. The package is not published to npm (it is distributed via GitHub Releases tarballs only), so OpenCode returned a 404 notification on every launch. v2.0.6+ relies entirely on the symlink at `~/.config/opencode/plugins/opencode-rich-presence.js` for loading, which OpenCode does natively and which never triggers an npm fetch.
- `opencode-rpc install` now detects and offers to remove a stale `opencode-rich-presence` entry in `opencode.jsonc` left over from a v2.0.5-era install. Default Yes. This silences the 404 notification on the next OpenCode restart.
- `opencode-rpc uninstall` now auto-removes any stale `opencode-rich-presence` entry in `opencode.jsonc` as part of cleanup, so users uninstalling the plugin do not carry a noisy 404 notification afterwards.
- `opencode-rpc info` no longer reads `opencode.jsonc` to check plugin registration. It now reports the symlink status of `~/.config/opencode/plugins/opencode-rich-presence.js` (path, whether it is a symlink, target). The section was renamed from `OpenCode plugin registration` to `OpenCode plugin symlink` and is now always shown.
- Updated `docs/INSTALL.md`, `docs/CLI-REFERENCE.md`, `docs/ARCHITECTURE.md`, and `docs/TROUBLESHOOTING.md` to remove all references to the now-defunct `opencode.jsonc` plugin registration step and to describe the symlink-only loading mechanism.

### Changed

- The `OpenCode plugin registration` section in `opencode-rpc info` output has been replaced with `OpenCode plugin symlink`. Always shown (no longer conditional on `opencode.jsonc` parsing).

## [2.0.5] - 2026-06-23

### Fixed

- `opencode-rpc install` no longer hangs when the Discord config file already exists. The prompt helper now uses a single long-lived readline interface so prompts always receive input correctly.
- `opencode-rpc install` can now auto-register the plugin in `~/.config/opencode/opencode.jsonc` (or `.json`). The user is asked for confirmation before any modification; if the file cannot be parsed, the installer falls back to clear manual instructions.
- `opencode-rpc install` now symlinks the plugin entry into `~/.config/opencode/plugins/opencode-rich-presence.js` and ensures `@xhayper/discord-rpc` is installed under `~/.config/opencode/node_modules/`. This works around the fact that the plugin is not on the npm registry: OpenCode can load it directly from disk instead of trying to fetch it via Bun and getting a 404.
- The worker path in `src/shared/paths.js` was computed with the wrong number of `../` levels (resolving to `<pkg-root>/worker/...` instead of `<pkg-root>/src/worker/...`). The plugin would acquire the leader lock and stay "alive" but the worker subprocess it spawned failed instantly with `MODULE_NOT_FOUND`. Fixed to use `../worker/discord-worker.mjs` (one level up from `src/shared/`).
- `opencode-rpc uninstall` now also removes `@xhayper/discord-rpc` from `~/.config/opencode/package.json` and re-runs `npm install` there to prune the package from `node_modules`. Users no longer carry leftover presence plugin artifacts after uninstall.
- `opencode-rpc install` next-steps message no longer suggests editing the config when a Discord App ID is already set. Users with a working configuration see only the restart instruction.
- `opencode-rpc uninstall` now asks before deleting `discord-config.json` (default N), and backs up the file with a timestamp suffix when the user agrees. Previously the file was always left alone without explanation.
- `opencode-rpc uninstall` now prints an explicit code snippet showing the `"plugin"` array entry to remove from `opencode.jsonc` (with a `<-- DELETE THIS LINE` marker). Previously the file was mentioned but no concrete example was given.
- `opencode-rpc install` now manages `~/.config/opencode/package.json` (adds the dependency if missing) and runs `npm install` in that directory. Existing entries are preserved.
- `opencode-rpc uninstall` removes the local plugin symlink at `~/.config/opencode/plugins/opencode-rich-presence.js` (with confirmation).
- `opencode-rpc uninstall` no longer suggests the non-existent `/config` slash command. The Step 1 output now suggests using a text editor (`nano`) to edit `opencode.jsonc` or `opencode.json` directly.
- Backup files are now explained as persistent in the home directory, not in `/tmp`. The full backup path is printed so users can locate the backup.
- `opencode-rpc uninstall` now detects and offers to remove a leftover `~/.config/opencode/node_modules/` directory from older install scripts. The check is gated on the `@xhayper` scope being present, and the script now also recognises OpenCode's own runtime cache (`@opencode-ai` scope) and leaves it alone with a clear explanation.
- The JSONC parser used by both `opencode-rpc install` (auto-register) and `opencode-rpc info` (plugin registration status) no longer treats `://` inside URLs as a line comment. The regex now uses a negative lookbehind on `:` so URLs like `"https://example.com"` and `"http://127.0.0.1:8080"` parse correctly.
- The CLI process now exits cleanly after each command instead of hanging. `bin/opencode-rpc.js` calls `process.exit(0)` after a successful command so the readline interface (held by the prompt helper) does not keep the Node process alive after `Done.` is printed.

### Changed

- The prompt helper now supports multi-option prompts with a single long-lived readline interface, fixing both interactive hangs and piped input (e.g., `echo "b" | opencode-rpc uninstall`).
- The installer's "next steps" message no longer tells users to wait for OpenCode's "auto-install via Bun" (which fails because the package is not on the npm registry). It now points users to the symlink in `~/.config/opencode/plugins/`.
- `docs/TROUBLESHOOTING.md` adds a "Known Root Causes" section with seven failure modes observed during v2.0.x development (worker path, missing npm registry, stale ESM cache, JSONC `://` bug, install/uninstall hangs, npm registry workaround). Also adds a quick diagnostic checklist at the bottom for triaging "Discord presence not showing" reports.

## [2.0.4] - 2026-06-23

### Fixed (BREAKING CLI behavior)

- `opencode-rpc restart` no longer restarts Discord Desktop. It now only writes the restart signal and kills the worker subprocess (matches v1.0.0 `restart-discord.sh` behavior). Discord Desktop is left alone, so users in voice chat are not disrupted.
- CLI entry script now wraps execution in an async `main()` function. Eliminates the Node.js warning "Detected unsettled top-level await" that appeared in Node 22+ when running interactive commands like `install`, `restart`, and `uninstall`.
- `opencode-rpc info` can now read `~/.config/opencode/opencode.jsonc` files that use JSONC features (line comments, block comments, trailing commas). Previously only strictly valid JSON was accepted, causing the "OpenCode plugin registration" section to be skipped on JSONC configs.
- Documentation accuracy: replaced fabricated example outputs in `docs/CLI-REFERENCE.md` and `docs/TROUBLESHOOTING.md` with actual outputs captured from the running CLI. Section visibility notes added so users know when "Lock (leader instance)" and "OpenCode plugin registration" sections appear or are absent.
- Documentation updated across README, CLI-REFERENCE, TROUBLESHOOTING, and ARCHITECTURE to reflect the new restart behavior.

## [2.0.2] - 2026-06-23

### Changed

- Documentation polish: standardized punctuation and phrasing across README, CHANGELOG, and all docs files. No functional changes.

## [2.0.1] - 2026-06-23

### Changed

- **CLI command renamed**: `rich-presence` -> `opencode-rpc` for clearer namespace ownership (this is an OpenCode ecosystem tool, not a generic rich presence tool).
- Package name stays `opencode-rich-presence` (unchanged).
- Bin file renamed: `bin/rich-presence.js` -> `bin/opencode-rpc.js`.
- CLI debug env var renamed: `RICH_PRESENCE_DEBUG` -> `OPENCODE_RPC_DEBUG`.

### Migration from v2.0.0

The npm package name is unchanged (`opencode-rich-presence`), so `npm update -g opencode-rich-presence` upgrades both v2.0.0 and v2.0.1 users. Only the CLI command name changed:

- v2.0.0: `rich-presence install`
- v2.0.1: `opencode-rpc install`

## [2.0.0] - 2026-06-23

### Changed (BREAKING)

- **Install via npm + GitHub Releases tarball** instead of bash scripts.
- **Cross-platform**: Linux, macOS, Windows. Replaces Linux-only v1.0.0.
- **Plugin code refactored** into modular structure (`src/plugin/`, `src/shared/`, `src/cli/`).
- **Config paths** standardized to OpenCode's `~/.config/opencode/` across all platforms (OpenCode normalizes this on Windows too).
- **CLI replaces bash scripts**: `opencode-rpc install/uninstall/restart/update/info/help`.
- **Plugin name renamed** from `opencode-dc-too-rich-presence` to `opencode-rich-presence`.
- **Lock file renamed** from `.opencode-dc-too-rich-presence.lock` to `.opencode-rich-presence.lock`.
- **Debug log** moved from hardcoded `/tmp/plugin-debug.log` to OS temp directory via `os.tmpdir()`.
- **Debug env var** renamed from `OPENCODE_DC_TOO_RICH_DEBUG` to `OPENCODE_RICH_PRESENCE_DEBUG`.

### Added

- CLI tool with subcommands: `install`, `uninstall`, `restart`, `update`, `info`, `help`, `version`.
- `opencode-rpc update` fetches latest release from GitHub API and self-updates.
- Cross-platform Discord restart logic (`pkill`/`osascript`/`taskkill`).
- Windows path detection in `findNodeExecutable` (`%ProgramFiles%`, `%LOCALAPPDATA%`).
- CI matrix testing on Linux, macOS, Windows across Node 18/20/22.
- Automated GitHub Release workflow (`.github/workflows/release.yml`).
- `docs/PLATFORM-NOTES.md` and `docs/CLI-REFERENCE.md`.

### Removed

- Bash install/uninstall/restart scripts.
- Hardcoded Linux paths.
- GNU sed/awk dependency.

### Migration from v1.0.0

v1.0.0 is preserved as `opencode-rich-presence-v1.0.0-legacy-linux-only` on the GitHub releases page. To migrate:

1. Back up `~/.config/opencode/discord-config.json`.
2. Install v2.0.0:
   ```bash
   npm install -g Khip01/opencode-rich-presence#v2.0.0
   ```
3. Run `opencode-rpc install`.
4. Restore your settings into the new config (App ID, presence templates).
5. Restart OpenCode.

## [1.0.0] - 2026-06-22

### Added

- Initial release.
- Linux-only Discord Rich Presence plugin for OpenCode.
- Bash install/uninstall/restart scripts.
- Template engine with variables, conditionals, fallbacks.
- Multi-instance coordinator (leader election via file lock).
- Discord subprocess worker (bypasses Bun IPC issues).
- 2-second IPC release delay on intentional restart.
- Configurable via `discord-config.json` + env vars.
- Documentation: README, SETUP, ARCHITECTURE, CUSTOMIZATION, TROUBLESHOOTING.

[2.0.7]: https://github.com/Khip01/opencode-rich-presence/releases/tag/v2.0.7
[2.1.0]: https://github.com/Khip01/opencode-rich-presence/releases/tag/v2.1.0
[2.0.9]: https://github.com/Khip01/opencode-rich-presence/releases/tag/v2.0.9
[2.0.8]: https://github.com/Khip01/opencode-rich-presence/releases/tag/v2.0.8
[2.0.8-rc5]: https://github.com/Khip01/opencode-rich-presence/releases/tag/v2.0.8-rc5
[2.0.8-rc4]: https://github.com/Khip01/opencode-rich-presence/releases/tag/v2.0.8-rc4
[2.0.8-rc3]: https://github.com/Khip01/opencode-rich-presence/releases/tag/v2.0.8-rc3
[2.0.8-rc2]: https://github.com/Khip01/opencode-rich-presence/releases/tag/v2.0.8-rc2
[2.0.8-rc1]: https://github.com/Khip01/opencode-rich-presence/releases/tag/v2.0.8-rc1
[2.0.7]: https://github.com/Khip01/opencode-rich-presence/releases/tag/v2.0.7
[2.0.5]: https://github.com/Khip01/opencode-rich-presence/releases/tag/v2.0.5
[2.0.0]: https://github.com/Khip01/opencode-rich-presence/releases/tag/v2.0.0
[1.0.0]: https://github.com/Khip01/opencode-rich-presence/releases/tag/v1.0.0
