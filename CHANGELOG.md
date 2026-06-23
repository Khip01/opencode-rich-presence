# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-06-23

### Changed (BREAKING)

- **Install via npm + GitHub Releases tarball** instead of bash scripts.
- **Cross-platform**: Linux, macOS, Windows. Replaces Linux-only v1.0.0.
- **Plugin code refactored** into modular structure (`src/plugin/`, `src/shared/`, `src/cli/`).
- **Config paths** standardized to OpenCode's `~/.config/opencode/` across all platforms (OpenCode normalizes this on Windows too).
- **CLI replaces bash scripts** — `rich-presence install/uninstall/restart/update/info/help`.
- **Plugin name renamed** from `opencode-dc-too-rich-presence` to `opencode-rich-presence`.
- **Lock file renamed** from `.opencode-dc-too-rich-presence.lock` to `.opencode-rich-presence.lock`.
- **Debug log** moved from hardcoded `/tmp/plugin-debug.log` to OS temp directory via `os.tmpdir()`.
- **Debug env var** renamed from `OPENCODE_DC_TOO_RICH_DEBUG` to `OPENCODE_RICH_PRESENCE_DEBUG`.

### Added

- CLI tool with subcommands: `install`, `uninstall`, `restart`, `update`, `info`, `help`, `version`.
- `rich-presence update` fetches latest release from GitHub API and self-updates.
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
3. Run `rich-presence install`.
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

[2.0.0]: https://github.com/Khip01/opencode-rich-presence/releases/tag/v2.0.0
[1.0.0]: https://github.com/Khip01/opencode-rich-presence/releases/tag/v1.0.0
