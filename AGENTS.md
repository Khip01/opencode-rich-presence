# opencode-rich-presence

Custom instructions for AI agents working on this project.
General writing/workflow rules are in `~/.config/opencode/AGENTS.md`.
This file covers project-specific details that future agents will
need to navigate this codebase safely.

## Project Facts

- **Plugin name**: `opencode-rich-presence`
- **CLI command**: `opencode-rpc`
- **Latest version**: v2.0.6
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
