# Architecture

## Overview (Phase 1)

```
              OpenCode AI
                  |
                  | SDK events (chat.message, message.*, session.*, ...)
                  v
   +--------------------------------------------------+
   |  OpenCodeRichPresence plugin (in-process)        |
   |  - index.js: event handlers, orchestration       |
   |  - session-state.js: per-session token/cost/state|
   |  - template-engine.js: variables, conditionals   |
   |  - local-presence.js: render + push (no-op stub) |
   |  - config-resolver.js: load config + env vars    |
   |                                                  |
   |  Outputs:                                        |
   |    - ~/.config/opencode/presence-activity.log    |
   |      (append-only chronological event/state log) |
   |    - ~/.config/opencode/presence-state-pid<pid>.txt
   |      (per-instance snapshot of current state)    |
   +--------------------------------------------------+
```

Phase 1 has NO subprocess, NO Discord IPC, NO leader election.
Everything runs inside the OpenCode process. This is intentional:
Phase 1 is the diagnostic phase. The user verifies that the
plugin's local state machine (event handling, state transitions,
template renders) matches reality by reading the activity log.
Once that is solid, Phase 2 adds a daemon subprocess that owns the
single Discord connection machine-wide and the same render code
goes to it instead of the log.

## Module Structure

```
src/
  shared/
    paths.js          cross-platform paths
                      (OPENCODE_DIR, CONFIG_PATH, OUTPUT_FILE,
                       ACTIVITY_LOG, DEBUG_LOG)
    constants.js      STATE enum, defaults, model limits,
                      DEFAULT_PRESENCE_TEMPLATES
    logger.js         debug log + activity log helpers
  plugin/
    index.js          plugin entry, event handlers, orchestration
    config-resolver.js  load discord-config.json + env vars
    session-state.js  per-session token/cost/state tracking
    template-engine.js variables, conditionals, render, format helpers
    local-presence.js render presence payload, push stub
  cli/
    dispatcher.js     route subcommands
    install.js, uninstall.js, restart.js, update.js,
    info.js, help.js, version.js
    prompt.js         zero-dep readline confirmation
    platform/
      linux.js, macos.js, windows.js, index.js
```

`src/worker/` does not exist in Phase 1. Phase 2 introduces
`src/worker/daemon.mjs` (the long-lived subprocess that owns the
Discord connection) and `src/worker/discord-ipc.mjs` (a minimal
inline IPC client for the daemon).

## Plugin Lifecycle

```
OpenCode startup
    |
    v
OpenCodeRichPresence({ client, directory }) called
    |
    +--> loadConfig()                          (config-resolver.js)
    +--> loadFallbackLimits()                  (constants.js)
    +--> loadConfigLimits() for each candidate opencode.json(c)
    +--> mkdir OPENCODE_DIR if needed
    +--> restoreFromServer(client, directory)  (background)
    +--> startPresence()                       (local-presence.js, no-op)
    +--> scheduleWrite()                       (renders + writes pid-suffixed state file)
    +--> activityTimer (REFRESH_INTERVAL=5s)   polls OpenCode SDK
    +--> refreshTimer (REFRESH_INTERVAL=5s)    restores messages for displayed session
    +--> return { event, dispose, chat.message }
                |
                v
         event handlers update SessionState, log to activity log
                |
                v
         scheduleWrite() re-renders + rewrites pid-suffixed state file
                |
                v
OpenCode shutdown
    |
    v
dispose() called
    |
    +--> clear timers
    +--> stopPresence()  (local-presence.js, no-op)
```

## Multi-instance Behavior

Phase 1 does not coordinate OpenCode instances with each other.
Each instance is independent:

- Each instance writes its own `presence-state-pid<pid>.txt` so
  multi-instance runs do not race on a single file.
- All instances append to the same `presence-activity.log`. Each
  entry is tagged with the writer's PID so the user can `grep`
  by instance.
- Display logic is local: each instance picks the most-recently-
  active session in its own queue.

This means in a multi-instance Phase 1 setup, two OpenCode windows
each write their own state file with their own most-recently-active
session. The user sees both via the activity log, but no single
"merged" view exists yet. Phase 2 fixes this by having all
instances send their state to the daemon, which picks the global
most-recently-active session and shows it on Discord.

## Activity Log (Phase 1 diagnostic surface)

Format (one line per event):

```
[2026-07-05 14:30:25.789] [pid 12345] [tag] message
```

PID tagging lets the user `grep "\[pid 12345\]"` to follow one
instance. Tags:

| Tag | When |
|-----|------|
| `load` | plugin lifecycle events |
| `config` | config resolution |
| `models` | model limits loaded (provider, fallback, config) |
| `restore` | sessions restored from OpenCode on startup |
| `event` | raw SDK event received |
| `state` | session state transition (only when state actually changes) |
| `session` | session metadata updated |
| `stats` | session stats (cost, tokens, context%) updated |
| `queue` | session added/removed from local tracking queue |
| `display` | displayed session changed |
| `template` | template render (source -> output) |
| `check` | periodic activity check (low frequency, no spam) |
| `push` | presence payload (Phase 1: `would-push`) |
| `presence` | presence lifecycle (start/stop) |

The activity log is append-only and grows monotonically. The user
rotates it via `opencode-rpc restart` (renames to `.prev`) or
manually.

## Phase 2 preview: Daemon architecture

Phase 2 (next) replaces this design with a daemon that owns the
Discord connection machine-wide:

```
                OpenCode AI (instance 1)
                      |
                      | local socket
                      v
                OpenCode AI (instance 2)  ---+--> [daemon (long-lived subprocess)]
                      |                      |     |
                      | local socket          |     | Discord IPC
                      v                      |     v
                OpenCode AI (instance N)  ---+   Discord Desktop
                                            |
                                  (one Discord connection
                                   for the whole machine;
                                   no reconnect on terminal switch)
```

The Phase 2 daemon:

- Is spawned by the first OpenCode instance that fires a chat
  message (the user picked this trigger; spawning on OpenCode
  launch is intentionally avoided because most launches do not
  need a Discord connection).
- Listens on `~/.config/opencode/.opencode-rich-presence.sock`
  (Unix socket on Linux/macOS, named pipe on Windows).
- Holds a single Discord IPC connection for its entire lifetime.
- Receives state updates from any OpenCode instance over the
  local socket, picks the global most-recently-active session,
  and pushes its rendered presence via SET_ACTIVITY on the
  existing Discord connection (no reconnect, no handshake).
- Exits when the last OpenCode instance disposes. The next
  firing OpenCode spawns a fresh daemon.

Phase 1's render + log code stays unchanged in Phase 2. Only
`local-presence.js`'s push function becomes a daemon-client
send call.

## Config Resolution Order

App ID priority: env var > config file > fallback (developer's verified App ID).

```
1. process.env.DISCORD_APP_ID         (highest)
2. discord-config.json: discordAppId  (medium)
3. FALLBACK_APP_ID (1512803991300476989)  (out-of-box default)
```

Same precedence applies to:
- `discordLargeImageKey` / `DISCORD_LARGE_IMAGE_KEY`
- `discordLargeImageText` / `DISCORD_LARGE_IMAGE_TEXT`

## Template Engine

The template engine supports:

1. **Variables:** `{model}`, `{context}`, etc.
2. **Fallbacks:** `{var|fallback}` is used if var is undefined/null.
3. **Boolean conditionals:** `{{#if thinking}}...{{else}}...{{/if}}`
4. **Comparison conditionals:** `{{#if contextPercent > 50}}...{{else}}...{{/if}}`
5. **Per-state templates:** `byState.Typing.state`, etc.

Variable substitution handles edge cases:
- `{var}` (typo missing `}` matches, returns fallback or "?")
- `{var}}` (extra `}` matches, returns var value)
- Missing var -> fallback or "?"

## CLI Subcommands

| Command | Purpose |
|---------|---------|
| `install` | Create config; migrate any v2.0.5-era opencode.jsonc entry; create symlink. No deps installed (Phase 1 has none). |
| `uninstall` | Remove runtime files, per-instance state files, symlink, optional config backup. |
| `restart` | Phase 1: rotate activity log. Phase 2: respawn daemon. |
| `update` | Check GitHub, self-update |
| `info` | Diagnostics dump + activity log tail |
| `help`, `version` | Usage info |

CLI is zero-dependency (built-in `readline/promises` for confirmations).

## Cross-Platform Considerations

| Concern | Linux | macOS | Windows |
|---------|-------|-------|---------|
| Config dir | `~/.config/opencode/` | `~/.config/opencode/` | `%USERPROFILE%\.config\opencode\` |
| Activity log | `~/.config/opencode/presence-activity.log` (append-only) | same | same |
| Debug log | `/tmp/opencode-rich-presence-debug.log` | `/var/folders/.../T/opencode-rich-presence-debug.log` | `%TEMP%\opencode-rich-presence-debug.log` |
| Phase 2 local IPC | Unix socket `~/.config/opencode/.opencode-rich-presence.sock` | Unix socket same | Named pipe `\\.\pipe\opencode-rich-presence` |

The plugin code itself is fully cross-platform thanks to:
- `os.homedir()` + `path.join()` for paths
- `os.tmpdir()` for debug log
- libuv-supported stdlib APIs

## Plugin Loading

OpenCode loads plugins from `~/.config/opencode/plugins/`. The
`opencode-rich-presence` package is NOT published to the npm
registry. v2.0.6+ relies entirely on a symlink at
`~/.config/opencode/plugins/opencode-rich-presence.js` pointing to
the plugin entry file in the user's npm prefix. OpenCode loads the
plugin directly from disk via this symlink.

**Do not add `"opencode-rich-presence"` to the `plugin` array in
`opencode.jsonc` or `opencode.json`.** OpenCode reads that array as
a list of npm packages to fetch on startup via Bun, and the package
does not exist on npm. The entry causes a 404 notification on every
OpenCode launch. Phase 1 never writes this entry; v2.0.5-era
installs that did write it are migrated on next `opencode-rpc
install` (offered, default Y) and on `opencode-rpc uninstall`
(auto-removed).
