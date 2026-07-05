# opencode-rich-presence

Custom instructions for AI agents working on this project.
General writing/workflow rules are in `~/.config/opencode/AGENTS.md`.
This file covers project-specific details that future agents will
need to navigate this codebase safely.

## Project Facts

- **Plugin name**: `opencode-rich-presence`
- **CLI command**: `opencode-rpc`
- **Phase**: v3 redesign. Currently on **Phase 1**: local state
  collector + activity log (no Discord push yet). Phase 2 adds the
  daemon architecture that holds a single Discord connection for the
  whole machine.
- **Latest stable release**: v2.1.1 (tag `v2.1.1`). v2.x is the
  pre-redesign line and uses per-session worker + leader election.
- **Node.js**: 18+ required, tested with 24.x
- **npm registry**: package is NOT published there. Distributed
  via `npm install -g <repo>#<ref>` (see Distribution Workflow below).
- **Repository**: github.com/Khip01/opencode-rich-presence
- **Plugin author Discord App ID** (default fallback in
  config-resolver.js): `1512803991300476989`
- **Asset key** (Discord rich presence image):
  `opencode-logo-too-rich-presence`

## Current Phase: 1 (local state + activity log)

Phase 1 is a deliberate step back from v2.x to fix a class of bug
that the per-session worker design cannot avoid: every leadership
handoff tears down and rebuilds the Discord IPC connection, so the
display always disappears for 1-3 seconds during terminal switching,
and aggressive recovery code on top of that (force-restart, self-heal
watchdog, internal retry) makes it worse by triggering more reconnects.

Phase 1 deliberately does NOT push to Discord. It only:

1. Receives OpenCode SDK events in-process (no subprocess worker)
2. Maintains per-session state (model, mode, state, cost, tokens)
3. Renders the presence payload (templates + variables)
4. Logs every event, state transition, and render to the activity log
5. Writes a per-instance snapshot to `presence-state-pid<pid>.txt`

The user verifies that the activity log captures reality correctly
(state transitions on the right events, rendered values sensible,
multi-instance display decisions reasonable). Once that is solid,
Phase 2 introduces a daemon that holds the Discord connection
machine-wide, and the same render code goes to it instead of the log.

This split lets us debug two concerns independently:
- "Did the plugin see the event and pick the right state?" (Phase 1
  question, answered by reading the activity log)
- "Did the daemon push the rendered payload to Discord?" (Phase 2
  question, answered by reading daemon logs + Discord)

## Project Structure (Phase 1)

- `src/plugin/`: Main plugin code
  - `index.js`: plugin entry, event handlers, orchestration
  - `config-resolver.js`: load discord-config.json + env vars
  - `local-presence.js`: render + push presence (push is a no-op
    stub in Phase 1; replaced by daemon send in Phase 2)
  - `session-state.js`: per-session token/cost/state tracking
  - `template-engine.js`: variables, conditionals, render helpers
- `src/cli/`: CLI commands
  - `install.js`, `uninstall.js`, `restart.js`, `update.js`
  - `info.js`, `help.js`, `version.js`, `dispatcher.js`, `prompt.js`
- `src/cli/platform/`: per-OS helpers (`linux.js`, `macos.js`, `windows.js`)
- `src/shared/`: `paths.js`, `constants.js`, `logger.js`
- `bin/opencode-rpc.js`: CLI entry point
- `docs/`: documentation
  - `CLI-REFERENCE.md`, `INSTALL.md`, `ARCHITECTURE.md`
  - `PLATFORM-NOTES.md`, `TROUBLESHOOTING.md`, `CUSTOMIZATION.md`
- `.github/workflows/`: CI
  - `test.yml`: runs matrix on linux/macos/windows x node 18/20/22
  - `release.yml`: runs on tag push, builds tarball + GitHub Release
- `scripts/`: `smoke-test.js`, `syntax-check.js`, `check-pkg.js`

There is no `src/worker/` directory in Phase 1. The Phase 2 daemon
lives there.

## Activity Log (Phase 1's primary diagnostic surface)

`~/.config/opencode/presence-activity.log`. Append-only. Format:

```
[2026-07-05 14:30:25.789] [pid 12345] [tag] message
```

PID tagging lets the user `grep "\[pid 12345\]"` to follow one
OpenCode instance when multiple are open.

Tag legend:

| Tag | Meaning |
|-----|---------|
| `load` | plugin lifecycle (loaded, disposing) |
| `config` | config resolution summary |
| `models` | provider / fallback / config model limits loaded |
| `restore` | sessions restored from OpenCode on startup |
| `event` | raw SDK event received (chat.message, message.updated, etc.) |
| `state` | session state transition (`WAITING -> WORKING`, etc.) |
| `session` | session metadata (model, provider, mode) updated |
| `stats` | session stats (cost, tokens, context%) updated |
| `queue` | session added/removed from local tracking queue |
| `display` | which session is displayed changed |
| `template` | template render (input -> output) |
| `check` | periodic activity check (low frequency, no spam) |
| `push` | presence payload (Phase 1: `would-push`; Phase 2: real push) |
| `presence` | presence lifecycle (start/stop) |

`opencode-rpc info` shows the last 30 lines of the activity log so
the user can see what the plugin did without tailing the file.
`tail -f ~/.config/opencode/presence-activity.log` works for live
monitoring.

## Distribution Workflow

Since v2.1.0, this project is distributed via `npm install -g <repo>#<ref>`
directly from the GitHub repo.

**Install paths**:

| Audience | Command |
|----------|---------|
| End user (stable, v2.1.1) | `npm install -g Khip01/opencode-rich-presence#v2.1.1` |
| End user (auto-resolve latest stable) | `npm install -g Khip01/opencode-rich-presence#semver:^2.0.0` |
| Developer (Phase 1 branch) | `npm install -g Khip01/opencode-rich-presence#redesign/v3-daemon` |
| Developer (specific commit) | `npm install -g Khip01/opencode-rich-presence#abc1234` |

The five CLI commands are:

1. `npm install -g <spec>`: install the package (see the table above).
2. `opencode-rpc install`: one-time setup. Symlink the plugin into
   `~/.config/opencode/plugins/`, write the example config. Phase 1
   no longer adds any npm dependency under `~/.config/opencode/`
   (the v2.x `@xhayper/discord-rpc` install step is gone).
3. `opencode-rpc update`: upgrade an existing installation to the
   latest stable release tag.
4. `opencode-rpc update --dev`: developer-only upgrade. Always
   installs the latest commit on `main`. Phase 1 uses
   `redesign/v3-daemon` as the developer branch.
5. `opencode-rpc update --stable`: force install latest stable tag,
   for switching back from --dev mode. `--stable` and `--dev` are
   mutually exclusive (exit 2 if both passed).
6. `opencode-rpc uninstall` plus `npm uninstall -g
   Khip01/opencode-rich-presence`. Full removal. Phase 1 uninstall
   also clears `presence-activity.log` and any
   `presence-state-pid*.txt`.

**Why git install is the primary install path**:

- Single source of truth (the repo); no separate tarball to keep in
  sync with source.
- Avoids cluttering the GitHub Releases sidebar with `-rc` pre-release
  tags while iterating.
- npm's git URL install (`<owner>/<repo>#<ref>`) supports tag / branch
  / commit / semver-range refs natively.

**GitHub Releases (stable only, fallback)**:

`.github/workflows/release.yml` builds a `.tgz` and creates a GitHub
Release for STABLE tags only. Tags containing `-rc`, `-beta`, or
`-alpha` are skipped. The tarball is for offline / air-gapped installs;
the git URL is the primary install path.

## Critical Implementation Details (Phase 1)

### Plugin Loading

OpenCode loads the plugin from
`~/.config/opencode/plugins/opencode-rich-presence.js`. This is a
symlink created by `opencode-rpc install` pointing to the npm
global install location. The package is NOT on the npm registry, so
OpenCode's default auto-install via Bun returns 404. The symlink
bypasses this entirely.

**NEVER add `opencode-rich-presence` to the `plugin` array in
`~/.config/opencode/opencode.jsonc` (or `.json`).** OpenCode reads
that array as a list of npm packages to fetch on startup, and the
package is not on npm. The entry would cause a 404 notification on
every OpenCode launch. Phase 1 never writes the entry; v2.0.5-era
stale entries are migrated on next install (offered, default Y) and
auto-removed on uninstall.

### Worker Path (REMOVED in Phase 1)

Phase 1 has no worker subprocess. All SDK event handling and template
rendering happens in-process inside the plugin. Phase 2 reintroduces
a subprocess (the daemon) but it lives at a new path and serves a
different purpose (holding the Discord connection machine-wide, not
per-session).

### JSONC Parser

Use negative lookbehind on `:` so URLs are not treated as line
comments:
```
/(?<!:)\/\/.*$/gm
```

This handles URLs like `"https://opencode.ai/config.json"` correctly.

### Per-Instance State File

Phase 1 writes `~/.config/opencode/presence-state-pid<pid>.txt`
instead of the shared `presence-state.txt`. This avoids a race when
multiple OpenCode instances run: each instance writes its own file,
and they never overwrite each other.

`opencode-rpc info` lists all per-instance state files it finds.
The activity log (shared, append-only) is the unified diagnostic
surface; the per-instance state files are snapshots of one process.

### Activity Log Rotation

The activity log is append-only and grows monotonically. The user
can rotate it manually (truncate, move aside) or via
`opencode-rpc restart`, which renames `presence-activity.log` to
`presence-activity.log.prev` so the next OpenCode launch starts
fresh. The user is responsible for deleting `.prev` when they no
longer need it.

### Environment Variables

- `DISCORD_APP_ID`: override Discord App ID (highest priority)
- `DISCORD_LARGE_IMAGE_KEY`: override Discord asset key
- `DISCORD_LARGE_IMAGE_TEXT`: override asset hover text
- `OPENCODE_RICH_PRESENCE_DEBUG`: enable verbose plugin logging
- `OPENCODE_RPC_DEBUG`: print CLI stack traces on errors
- `OPENCODE_CONFIG_DIR`: override OpenCode config dir

## Build, Test, and Verify

Before proposing any commit:
1. `node scripts/syntax-check.js`: verifies all JS/MJS files parse
2. `node scripts/smoke-test.js`: verifies 32 files, package, CLI
3. Manual end-to-end test of changed behavior:
   - Open OpenCode, fire a message, check activity log
   - Verify state transitions log on the right events
   - Verify per-instance state file shows rendered presence
4. Documentation matches actual code behavior

## Commit Message Convention

In addition to the global rules in `~/.config/opencode/AGENTS.md`:
- Body sections use `Fix:`, `Feat:`, `Chore:`, `Docs:` for what
  changed
- Point to `CHANGELOG.md` for detailed info, do not duplicate it

## Known Bugs to Avoid Reintroducing

These are lessons from the v2.0.x -> v3 redesign effort. Future
agents working on this project should keep them in mind.

### Handoff kills Discord display

Per-session worker design (v2.0.7+): every leadership handoff means
the previous worker's IPC socket closes, Discord drops the
presence, the new worker's IPC socket opens, login handshake, push.
This is 1-3 seconds of "display gone" per terminal switch. Users
called this "mati dulu baru nyalain kembali". The v2.0.8-rc4
pre-spawn approach shortened the gap but did not eliminate it.

Phase 1 deliberately removes the per-session worker so the symptom
is no longer reproducible. Phase 2 introduces a daemon that owns
ONE Discord connection for the whole machine, so the question of
"handoff" disappears entirely; state updates are in-place SET_ACTIVITY
on the existing connection.

### Force-restart / self-heal watchdog / internal retry

The v2.1.2 line added three layers of automatic recovery to mask
handoff slowness / Discord IPC staleness:
- force-restart worker 4s after leader gain
- self-heal watchdog that killed and respawned stuck workers
- internal setActivity retry chain in the worker

Each fix introduced new failure modes (PID reuse races, reconnect
loops, rate-limit false positives). The user's verdict ("kalo gabisa
jangan dipaksakan") was clear: when a problem cannot be solved by
layering complexity, the right move is to remove the cause, not to
patch the symptom. Phase 1 does this by removing the per-session
worker entirely; Phase 2 keeps the daemon simple (no internal
retry, no self-heal) and reconnects only when the IPC socket
actually dies.

### Document the redesign, do not paper over it

The earlier iteration (v2.1.2) accumulated undocumented patches
that fixed one symptom while introducing another. AGENTS.md and
CHANGELOG.md drifted behind the code. When the redesign question
came up, the only honest answer was "revert and start over".

Phase 1 commits keep AGENTS.md, CHANGELOG.md, ARCHITECTURE.md,
TROUBLESHOOTING.md aligned with the code in the same commit so
the docs can never lie about what is running. When changing behavior,
update docs in the SAME commit.

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

## Lessons Learned (across v2.0.x and v3 design)

### Study prior versions before redesigning

When the user reports a regression after a redesign, the FIRST thing
to do is `git log --oneline` and read the previous design (use
`gh release view <tag>` or `git show <tag>:path`). The user
explicitly asked the v2.0.8 author to look at v2.0.6 because the
simpler design worked better for their use case. Several rounds of
"smart" complex fixes later, we ended up with the simple design
plus a small set of targeted improvements. If the user pushes back
on complexity, the answer is usually less, not more.

### Build the diagnostic surface before fixing the bug

When debugging integration code, build a local-first log of what
the plugin INTENDS to do (events seen, state transitions, rendered
payloads) BEFORE pushing anything to the external service. The
local log lets the user and the agent distinguish "plugin bug"
from "service bug" without guessing. Phase 1 of this project is
exactly that: local log only, no Discord push, until the user
confirms the log captures reality correctly.

### User's UX expectations beat clever engineering

The user explicitly said: "v2.0.6 was smooth, v2.0.7+ flickers."
That is the most important feedback. Smoothness of state
transitions matters more than the technical correctness of
leader election. If the user's UX expectation is "state updates
should feel real-time without display restart", work backward
from there. The Phase 2 daemon is the architectural answer.

### Discord IPC is single-connection per Application ID

This is a hard constraint set by Discord. Phase 1 sidesteps it
entirely by not pushing. Phase 2 sidesteps it by holding the single
connection in a daemon shared by all OpenCode instances, with
SET_ACTIVITY updates happening in place on the existing connection
(no reconnect, no handshake).

### Always surface architectural limits early

The v2.0.x -> v2.1.2 -> v3 effort spent multiple commits trying
to mask the "per-session worker + handoff = display flicker" limit
with clever coordination. The limit was architectural and cannot
be patched. The right move was to call it out at the start
("this is inherent to the design"), not to keep adding fix layers
that introduced new bugs. When the user pushes back hard ("kalo
gabisa jangan dipaksakan"), that is the signal that you have hit
an architectural limit, not a transient bug. Stop iterating and
propose the redesign.
