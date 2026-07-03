# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.8] - 2026-07-03

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
   npm install -g https://github.com/Khip01/opencode-rich-presence/releases/latest/download/opencode-rich-presence-latest.tgz
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
[2.0.7]: https://github.com/Khip01/opencode-rich-presence/releases/tag/v2.0.7
[2.0.5]: https://github.com/Khip01/opencode-rich-presence/releases/tag/v2.0.5
[2.0.0]: https://github.com/Khip01/opencode-rich-presence/releases/tag/v2.0.0
[1.0.0]: https://github.com/Khip01/opencode-rich-presence/releases/tag/v1.0.0
