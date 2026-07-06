# Architecture

## Overview (Phase 2)

```
                OpenCode instance 1 (pid A)
                       |
                       | local Unix socket
                       v
                OpenCode instance 2 (pid B)  ---+--> [daemon (long-lived subprocess)]
                       |                        |    |
                       | local Unix socket      |    | Discord IPC
                       v                        |    v
                OpenCode instance 3 (pid C) ---+   Discord Desktop
                                                 |
                                       one Discord connection
                                       for the whole machine;
                                       no reconnect on terminal switch
```

Phase 2 of the v3 redesign. A long-lived daemon (subprocess) holds
the single Discord IPC connection for the whole machine. All
OpenCode plugin instances connect to it via local Unix socket, send
their rendered session state, and the daemon pushes to Discord via
SET_ACTIVITY on the existing connection (no reconnect, no handshake).

## Why daemon (not per-session worker like v2.x)

Discord IPC allows only one connection per Application ID. Per-session
workers force a reconnect on every leadership handoff (1-3 seconds
of "display gone"). The daemon keeps one connection forever and
pushes state updates in place.

The user does not have to manually restart anything when switching
OpenCode windows; the same Discord connection just keeps showing
the most-recently-active session.

## Spawn trigger: first firing

The daemon spawns on the FIRST `chat.message` from any OpenCode
instance, not on plugin load. The user picked this trigger
specifically: spawning on OpenCode launch would start Discord
connections for sessions that never need them.

## Module Structure

```
src/
  shared/
    paths.js          cross-platform paths
                      (OPENCODE_DIR, CONFIG_PATH, OUTPUT_FILE,
                       ACTIVITY_LOG, DAEMON_SOCKET, DAEMON_PID_FILE,
                       DEBUG_LOG)
    constants.js      STATE enum, defaults, model limits,
                      DEFAULT_PRESENCE_TEMPLATES
    logger.js         debug log + activity log helpers
  plugin/
    index.js          plugin entry, event handlers, orchestration
    config-resolver.js  load discord-config.json + env vars
    session-state.js  per-session token/cost/state tracking
    template-engine.js variables, conditionals, render, format helpers
    local-presence.js render payload + send to daemon
    daemon-client.js  local Unix socket client to the daemon
    daemon-spawner.js spawns the daemon on first firing
  worker/
    daemon.mjs        long-lived subprocess, holds Discord IPC connection
    discord-ipc.mjs   inline Discord IPC client
  cli/
    dispatcher.js     route subcommands
    install.js, uninstall.js, restart.js, update.js,
    info.js, help.js, version.js
    prompt.js         zero-dep readline confirmation
    platform/
      linux.js, macos.js, windows.js, index.js
```

## Plugin Lifecycle

```
OpenCode startup
    |
    v
OpencodeRichPresence({ client, directory }) called
    |
    +--> loadConfig()                          (config-resolver.js)
    +--> loadFallbackLimits()                  (constants.js)
    +--> loadConfigLimits() for each candidate opencode.json(c)
    +--> mkdir OPENCODE_DIR if needed
    +--> restoreFromServer(client, directory)  (background)
    +--> startPresence()                       (local-presence.js)
    +--> scheduleWrite()                       (renders + writes pid-suffixed state file)
    +--> activityTimer (REFRESH_INTERVAL=5s)   polls OpenCode SDK
    +--> refreshTimer (REFRESH_INTERVAL=5s)    restores messages for displayed session
    +--> return { event, dispose, chat.message }
                |
                v
         event handlers update SessionState, log to activity log
                |
                v
         First chat.message:
           ensureDaemonAndConnect() -> daemon-spawner.js spawns daemon
                                    -> daemon-client.js connects
         Subsequent events:
           sendStateToDaemon()      -> writes to daemon socket
                |
                v
         Daemon picks global most-recently-active instance,
         pushes its rendered payload to Discord via SET_ACTIVITY
                |
                v
OpenCode shutdown
    |
    v
dispose() called
    |
    +--> clear timers
    +--> stopPresence() -> disconnectFromDaemon() -> sends goodbye
    |
Daemon receives goodbye, removes instance, schedules exit
if last one. After EXIT_GRACE_MS (2s) daemon shuts down:
    |
    +--> clearActivity (send to Discord)
    +--> disconnect Discord IPC
    +--> close local server
    +--> unlink socket + PID file
    +--> process.exit(0)
```

## IPC Protocol

Newline-delimited JSON over the local Unix socket
(`~/.config/opencode/.opencode-rich-presence.sock`).

Plugin -> Daemon:

```json
{"type": "hello", "pid": 12345}
    Register a new OpenCode instance.

{"type": "state", "pid": 12345,
 "session": {"sessionID": "ses_x", "state": "Working", "lastActivity": 1234567890},
 "rendered": {"details": "...", "state": "...", "largeImageKey": "...",
              "largeImageText": "...", "smallImageText": "..."}}
    Update this instance's session state. The plugin renders the
    payload locally and ships the rendered result. The daemon
    uses lastActivity + state to pick the global most-recently-
    active instance. (JSON serialization over the socket loses
    class methods/getters on SessionState, so getTemplateVars
    would break on a deserialized object.)

{"type": "goodbye", "pid": 12345}
    Unregister. Daemon may exit if this was the last instance.
```

Daemon -> Plugin:

```json
{"type": "ack"}
    Acknowledgement (always sent in response to client messages).

{"type": "discord-state", "connected": true|false}
    Status of the Discord IPC connection. Sent on change.

{"type": "log", "level": "info|warn|error", "msg": "..."}
    Daemon log lines for the plugin to forward to the user's
    activity log.
```

## Multi-instance Behavior

- Each OpenCode instance has its own `SessionState` Map and its
  own per-instance state file at
  `~/.config/opencode/presence-state-pid<pid>.txt`.
- All instances connect to the same daemon via the local socket.
- The daemon tracks each instance's lastActivity + state, picks
  the global most-recently-active one, and pushes its payload
  to Discord.
- The user does NOT see "display gone" during terminal switching:
  Discord keeps showing the same connection, just with a new
  payload.

## Push Throttling

`DISCORD_PUSH_INTERVAL_MS = 4000`. The throttle prevents flooding
Discord (which limits to 5 updates per 20 seconds). It is RESET
when the picked instance changes (legitimate switch), so the user
sees the new state immediately when they switch terminals, not
after a 4-second lag.

## Discord-side Behavior

- SET_ACTIVITY is fire-and-forget. The daemon does not wait for
  the response; missing one update is harmless (the next state
  change will land).
- Reconnect to Discord only on socket death. Backoff: 5s to 30s cap.
- If multiple OpenCode instances push at the same time, the
  throttled daemon picks the most-recently-active one and pushes
  that one.

## Activity Log

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
| `push` | presence payload (`sent rendered payload to daemon`) |
| `daemon` | daemon connection events |
| `presence` | presence lifecycle (start/stop) |

The activity log is append-only and grows monotonically. The user
rotates it via `opencode-rpc restart` (renames to `.prev`) or
manually.

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
| `install` | Create config; migrate any v2.0.5-era opencode.jsonc entry; create symlink. |
| `uninstall` | Stop daemon; remove runtime files, per-instance state files, activity log, socket, PID file; optional config backup. |
| `restart` | Kill running daemon (SIGTERM + 2s grace + SIGKILL); rotate activity log. |
| `update` | Check GitHub, self-update |
| `info` | Diagnostics dump + daemon status (socket presence, PID, alive) + activity log tail |
| `help`, `version` | Usage info |

CLI is zero-dependency (built-in `readline/promises` for confirmations).

## Cross-Platform Considerations

| Concern | Linux | macOS | Windows |
|---------|-------|-------|---------|
| Config dir | `~/.config/opencode/` | `~/.config/opencode/` | `%USERPROFILE%\.config\opencode\` |
| Activity log | `~/.config/opencode/presence-activity.log` (append-only) | same | same |
| Debug log | `/tmp/opencode-rich-presence-debug.log` | `/var/folders/.../T/opencode-rich-presence-debug.log` | `%TEMP%\opencode-rich-presence-debug.log` |
| Daemon socket | Unix socket `~/.config/opencode/.opencode-rich-presence.sock` | Unix socket same | Named pipe `\\.\pipe\opencode-rich-presence` |
| Discord IPC | Unix socket `/run/user/1000/discord-ipc-0` | Unix socket `/tmp/discord-ipc-0` | Named pipe `\\.\pipe\discord-ipc-0` |

The plugin code itself is fully cross-platform thanks to:
- `os.homedir()` + `path.join()` for paths
- `os.tmpdir()` for debug log
- libuv-supported stdlib APIs
- `process.platform === "win32"` for pipe path handling

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
OpenCode launch. Phase 2 never writes this entry; v2.0.5-era
installs that did write it are migrated on next `opencode-rpc
install` (offered, default Y) and on `opencode-rpc uninstall`
(auto-removed).
