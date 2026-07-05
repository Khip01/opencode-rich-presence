# opencode-rich-presence

Custom instructions for AI agents working on this project.
General writing/workflow rules are in `~/.config/opencode/AGENTS.md`.
This file covers project-specific details that future agents will
need to navigate this codebase safely.

## Project Facts

- **Plugin name**: `opencode-rich-presence`
- **CLI command**: `opencode-rpc`
- **Latest version**: v2.1.1
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
  - `release.yml`: runs on tag push, builds tarball + GitHub Release for STABLE tags only (skips `-rc` / `-beta` / `-alpha`)
- `scripts/`: `smoke-test.js`, `syntax-check.js`, `check-pkg.js`

## Distribution Workflow

Since v2.1.0, this project is distributed via `npm install -g <repo>#<ref>` directly from the GitHub repo, not via a `.tgz` asset attached to GitHub Releases.

**Install paths**:

| Audience | Command |
|----------|---------|
| End user (stable) | `npm install -g Khip01/opencode-rich-presence#v2.1.1` |
| End user (auto-resolve latest stable) | `npm install -g Khip01/opencode-rich-presence#semver:^2.0.0` |
| Developer (latest commit on main) | `npm install -g Khip01/opencode-rich-presence` |
| Developer (specific commit) | `npm install -g Khip01/opencode-rich-presence#abc1234` |

The five CLI commands are:

1. `npm install -g <spec>` — install the package (above table).
2. `opencode-rpc install` — one-time setup: symlink the plugin into `~/.config/opencode/plugins/`, write the example config, install `@xhayper/discord-rpc` under `~/.config/opencode/node_modules/`. Works after any of the npm install variants above. Does NOT touch npm.
3. `opencode-rpc update` — upgrade an existing installation to the latest stable release tag. Runs `npm install -g Khip01/opencode-rich-presence#<latest-tag>` and preserves the existing config / symlink / deps.
4. `opencode-rpc update --dev` — developer-only upgrade: skips the version check and always installs the latest commit on `main`. Runs `npm install -g Khip01/opencode-rich-presence#<latest-sha>`.
5. `opencode-rpc update --stable` — force install the latest stable tag, skipping version comparison. Use this to switch back to the stable channel after running on `--dev` mode (the regular `update` flow would say "already up-to-date" because the numeric version compares equal, even though the source is a different commit on `main`). `--stable` and `--dev` are mutually exclusive (exit 2 if both passed).
6. `opencode-rpc uninstall` + `npm uninstall -g Khip01/opencode-rich-presence` — full removal.

**Why git install is the primary install path**:

- The repo is the single source of truth; no separate tarball artifact to keep in sync with the source.
- Frequent pre-release tags (`-rc1`, `-rc2`, ...) cluttered the GitHub Releases sidebar and made it hard to find the latest stable version.
- npm's git URL install (`<owner>/<repo>#<ref>`) supports tag / branch / commit / semver-range refs natively.

**GitHub Releases (stable only, for fallback / offline installs)**:

`.github/workflows/release.yml` is preserved and runs on tag pushes, but with a job-level `if` condition that skips any tag containing `-rc`, `-beta`, or `-alpha`. It builds a `.tgz` and creates a GitHub Release whose install instructions point users to the git URL (the tarball is provided as a fallback for offline / air-gapped installs, not as the primary install path).

If you tag `v2.1.0`, the workflow runs and creates a stable GitHub Release.
If you tag `v2.1.0-rc1`, the workflow is skipped — no GitHub Release noise.

**Do NOT** tag every commit as `-rcN` or `-betaN` "to be safe". Pre-release channels are for actual pre-release channels (alpha software, beta testers). For "I want to test a fix locally before tagging stable", use `opencode-rpc update --dev`.

See the global `~/.config/opencode/AGENTS.md` "Git-Based NPM Install/Distribution Workflow" section for the general principles that apply to any npm project.

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
- Adding a `.github/workflows/release.yml` that builds a `.tgz`
  and attaches it to every GitHub Release, plus tagging every
  commit as `-rcN` / `-betaN` / `-alphaN`. Symptom was the GitHub
  Releases sidebar becoming unreadable (every "fixed one bug" tag
  showed up as a pre-release). Fixed in v2.1.0 by switching the
  CLI install path to `npm install -g <repo>#<ref>` from the
   GitHub repo (the tarball is now a fallback, not the primary
  path) AND by gating `release.yml` with an `if` condition that
  skips any tag containing `-rc` / `-beta` / `-alpha`. Do NOT
  remove that `if` condition; it is the only thing preventing
  the sidebar pollution. If you tag a prerelease by accident,
  no GitHub Release is created — clean.
- Letting two mutually-exclusive flags (`--stable` and `--dev` in
  `opencode-rpc update`) silently pick one. Symptom would be the
  user running `update --stable --dev` and getting unexpected
  behavior depending on argument-order parse rules. The fix
  applied here: detect both flags in the handler and exit with
  code 2 plus a clear error message before doing any work.
  Follows POSIX Guideline 11 ("unless the options are documented
  as mutually-exclusive") and matches the pattern used by
  `cargo`, `kubectl`, and `npm` for genuinely incompatible flags.
  When you add a new flag, check whether it conflicts with
  existing ones and reject with `process.exit(2)` plus a one-line
  explanation if so. Do NOT silently last-one-wins.
- Running `npm install -g <git_url>#<ref>` directly from the CLI
  for git deps on npm v11 (Node 24.x). Symptom was the install
  appearing to succeed but the bin symlink ending up broken
  (`opencode-rpc: command not found`), and the NEXT install of
  the same package failing with
  `ENOTDIR: not a directory, rename <lib>/node_modules/<name>
  -> <lib>/node_modules/.<name>-<rand>`. Root cause: npm v11
  installs git deps as a symlink under `lib/node_modules/<name>/`
  pointing to a clone dir under `~/.npm/_cacache/tmp/<id>/`.
  npm cleans up that temp dir at some point (cache pressure, idle
  eviction, or between operations), and the symlink becomes
  dangling. The next install tries to `rename()` the existing
  symlink to a backup name, which fails because the symlink's
  target does not exist (rename on a dangling symlink errors with
  ENOTDIR). Fix: in `src/cli/update.js`, do not call `npm install
  -g <repo>#<ref>` directly for git deps. Instead, `git clone`
  the repo to a temp dir, `git fetch --depth=1 origin <ref>` and
  `git checkout FETCH_HEAD` (works for both tags and SHAs), then
  `npm pack` to produce a real tarball, then
  `npm install -g <tarball>`. Tarballs are not affected by the
  git-dep symlink bug. Also clean up any existing broken symlink
  at the global install path before installing, so users with
  leftover broken state from earlier v2.0.8-rcX installs recover
  automatically. If you ever revisit this code, do NOT go back
  to the direct `npm install -g <repo>#<ref>` approach without
  verifying against the user's specific npm version: this bug
  is npm-version-dependent and may change in future npm releases.

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

### After-install state goes in a sidecar marker file, not `import.meta.url`

When `update.js` writes install-channel info (stable tag vs dev
SHA), it cannot use `import.meta.url` to find the install path:
the package directory was just replaced by `npm install`, so the
URL still points at the pre-install location. Resolve the install
location via `npm root -g` (or `process.execPath`-relative
fallback) and write the marker there. `version.js` then reads
the marker relative to its own `import.meta.url` (because it runs
in a fresh process after the install completes, and its URL
reflects the new file path). This split-resolve pattern is
asymmetric by design but is the correct way to bridge install-time
and runtime state.

### Bootstrap runtime state on first CLI run, not just at install

A sidecar marker file is only useful if it exists when the CLI
runs. `update.js` writes the marker when the user explicitly
upgrades or switches channel, but a user who installs via
`npm install -g <tarball>` directly bypasses `update.js` and
ends up with no marker. `version` then degrades gracefully (just
shows the version) but the user loses the channel info.

Fix: have the CLI entry point (`bin/opencode-rpc.js`) bootstrap the
marker on every invocation if it does not already exist. Default
to the most likely channel (here, "stable" since fresh tarball
installs are tagged releases). Explicit channels via `update --dev`
or `update --stable` overwrite the marker with the actual ref. The
bootstrap is best-effort and must NEVER fail the CLI invocation —
wrap it in try/catch and silently swallow filesystem errors. Apply
this pattern any time you have runtime state that depends on an
optional install-time write: prefer "compute if missing" at
runtime over "must exist or fail".

### Add `.gitignore` entries for runtime artifacts BEFORE they leak

When `update.js` writes the `.install-channel` marker via
`npm root -g`, it should never land in the repo's working directory.
But if the CLI is ever invoked from inside the repo (common during
development), `npm root -g` returns the global modules path which
normally does NOT match the cwd, so the marker goes to the
intended global location. Edge cases where the marker DOES end up
in the cwd (e.g. `npm root -g` returns a relative path, or a test
runs from the repo root) will cause a stray `.install-channel` file
to appear next to `package.json`. The fix is to add a
`.gitignore` entry for the marker filename as a safety net, before
that stray file gets committed by accident. Apply this pattern to
any runtime artifact a CLI might write from inside the repo:
install paths, log files, lock files, sockets, PIDs. Better to
gitignore the name proactively than to discover it via `git status`
after the fact.

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

### Discord IPC handshake: opcode 1 (FRAME), NOT opcode 0 (HANDSHAKE reply)

When writing or debugging a Discord IPC client, the success
signal for the handshake is the DISPATCH READY frame, which
arrives as opcode 1 (FRAME) with payload:

```
{cmd: "DISPATCH", evt: "READY", data: {v, config, user}}
```

The Discord IPC docs historically described the handshake reply
as opcode 0, but in practice real Discord never sends opcode 0
for READY. The READY event is sent as a regular FRAME (opcode
1). All proven-working libraries wait for opcode 1 here:
- `pypresence`: opcode 1 (FRAME) parsed as JSON, looks for
  `{code}` field for error replies
- `@xhayper/discord-rpc`: same
- `jagrosh/DiscordIPC`: same
- `discordjs/RPC`: same

If you write your own client and check `if (opcode === 0)` to
detect handshake success, it will NEVER match against current
Discord. The client will time out and retry forever, looking
like Discord is silently rejecting connections. It is not. Your
code is wrong.

Defensive approach: accept opcode 0 OR 1 as the connected
signal. Parse the payload as JSON; if it has a `{code, message}`
shape, surface it as a distinct error (e.g. `code 4000` = "Invalid
Client ID") so the user can tell rejection apart from timeout.

The bug existed in `src/worker/discord-ipc.mjs` introduced in
4abb9ed. Fixed in 695c455. The repo's CHANGELOG has the full
sequence; the lesson here is to verify the protocol at the byte
level when an existing library disagrees with your implementation.

### When something doesn't work, instrument the lowest layer FIRST

During the handshake opcode debugging, the user correctly
called out that I had blamed their verified Discord App ID for
being "silent rejected" without evidence. The user-pushed-back
moment was correct.

Lesson: when an integration is failing, do not jump to "the
external service is at fault" or "the credentials are bad". Run a
minimal repro at the protocol layer (in our case, raw bytes
through `net.createConnection` to `/run/user/1000/discord-ipc-0`)
and observe what actually happens. In our case the bug was in
our own code, not in Discord or in the App ID.

Anti-pattern I followed (do not repeat): I tested three different
App IDs to "prove" the issue was the user's verified one. That
testing was useful, but my interpretation ("the verified App ID
is silently rejected") was wrong. The raw-bytes test would have
shown immediately that Discord was responding normally to all
four App IDs in roughly the same time (~400ms). The reason the
plugin appeared stuck on the verified App ID specifically was
 luck of the test ordering; the symptom had nothing to do with
the App ID.

### Compare your implementation against reference implementations BEFORE debugging further

When the IPC client was timing out, the next-step instinct was
to keep tweaking our own code (timeout values, retry counts,
exponential backoff knobs). What actually cracked it was
side-by-side reading:

- Read `pypresence` IPC receive handler
- Read `@xhayper/discord-rpc` IPC receive handler
- Read `jagrosh/DiscordIPC` Java receive handler
- Notice ALL THREE accept opcode 1 (FRAME) for handshake
  completion, not opcode 0

The discrepancy with my own code (which checked opcode 0) was
visible immediately in this comparison. Lesson: when the
behavior of your code disagrees with multiple mature reference
implementations, your code is wrong, not the references and not
the external service.

### Test against multiple App IDs to distinguish code bugs from environment issues

During the debugging I ran four separate handshake tests against
four different App IDs (three alternative ones provided by the
user, plus the user's verified App ID). All four responded at
the protocol level. The user's verified App ID had appeared to
"not respond" earlier, but that was a test-ordering artifact, not
a real difference. Lesson: when you suspect an environment
issue, vary multiple inputs and check whether the symptom is
input-dependent. If the symptom disappears with a different
input, the cause is not the input but something else.

### "NO DATA" was the bug, not Discord

The misleading symptom during this debugging was that the worker's
`net.createConnection` would complete, the `socket.write(handshake)`
would succeed (return value undefined, no error), but then
`socket.on("data", ...)` would never fire for certain App IDs.
That made it look like Discord was silent / refusing / blacklisting.

What was actually happening: Discord WAS sending the DISPATCH
READY frame (opcode 1). Our code was receiving it but treating
opcode 1 as "not the handshake response, continue parsing" and
waiting for more data. Eventually timing out at 30s.

The test that revealed this: a raw-bytes Node script that
connected directly to the Discord IPC socket and logged the
first byte of every incoming frame. It showed opcode 1 arriving
in ~400ms for every App ID tested, including the user's verified
one. This single observation collapsed the whole "App ID is
being silently rejected" hypothesis.

### Do not commit a fix without verifying it end-to-end on a real Discord session

I committed commit `4abb9ed` (replace @xhayper with inline IPC
client) without testing whether the inline client actually
connected to Discord. The user had to push back ("emang anda
sudah fix problem nya?") to get me to run a standalone test
that exposed the opcode bug.

Lesson: the standalone test path (raw Node script that imports
the new client and tries to connect) is fast and obvious. Always
run it BEFORE asking for ACC on a commit. The plugin's debug log
shows timeouts clearly, but a standalone test shows them in
seconds without the rest of the plugin's complexity.
