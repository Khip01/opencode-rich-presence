# Architecture

## Overview (Phase 2)

```
                OpenCode instance 1 (pid A)
                       |
                       | local IPC
                       v
                OpenCode instance 2 (pid B)  ---+--> [daemon (long-lived subprocess)]
                       |                        |    |
                       | local IPC              |    | Discord IPC
                       v                        |    v
                OpenCode instance 3 (pid C) ---+   Discord Desktop
                                                 |
                                       one Discord connection
                                       for the whole machine;
                                       no reconnect on terminal switch
```

Phase 2 of the v3 redesign. A long-lived daemon (subprocess) holds
the single Discord IPC connection for the whole machine. All
OpenCode plugin instances connect to it via the local IPC endpoint
(a Unix socket file on Linux/macOS, a named pipe on Windows), send
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
    index.js          V1 plugin entry, event handlers, orchestration
    index.v2.js       V2 adapter and native event normalization
    config-resolver.js  load discord-config.json + env vars
    session-state.js  per-session token/cost/state tracking
    template-engine.js variables, conditionals, render, format helpers
    local-presence.js render payload + send to daemon
    daemon-client.js  local IPC client to the daemon
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
OpenCode v1 startup
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
OpenCode v2 uses the same renderer and daemon, but `index.v2.js`
registers the V2 `prompt`, `context`, and tool hooks plus one public event
subscription. Native V2 events such as `session.step.*`,
`session.execution.*`, `session.usage.updated`, `session.text.*`,
`session.reasoning.*`, `session.tool.*`, and `session.compaction.*` are
normalized into the shared `SessionState`. Multiple V2 plugin locations in
one service share one event subscription and polling loop.

### V2 execution-state arbitration

The V2 adapter has two data paths: native events and a periodic context
refresh. Native events are authoritative for execution state. When a prompt
is pending or an execution is active, the refresh may update usage, cost,
prompt counts, and message statistics, but it cannot select `Waiting for
command`, `Typing`, or another state from history.

This guard is necessary because `session.context()` can briefly return the
previous assistant message, including its completed timestamp, while the new
execution is starting. Without the guard, a new prompt could render as
`Completed!` until `session.step.started` arrived.

The normal V2 state sequence is:

1. `prompt` or `session.execution.started` selects `Working`.
2. `session.step.started` and `session.reasoning.*` select `Thinking`.
3. `session.text.*` selects `Typing`; tool events select `Working`.
4. A normal stopped model step keeps the current `Thinking` or `Typing`
   state. A tool-call step selects `Working`.
5. `session.execution.succeeded`, `failed`, or `interrupted` selects
   `Waiting for command`.

This arbitration is implemented only in `src/plugin/index.v2.js`. The V1
entry in `src/plugin/index.js` is unchanged.

### V2 event stream resilience and guard recovery

The shared event subscription lives in a restartable loop
(`restartEventLoop`). If the stream ends cleanly or errors (location
shutdown, service restart), the loop resubscribes with backoff instead of
silently losing every native execution event. On dispose the subscription
is handed to a surviving plugin location, so multiple locations in one
service keep exactly one live subscription.

Native terminal events remain the authority for clearing the execution
guard. Because a lost terminal event can otherwise strand the presence on
`Working`, a guarded poll may release the guard on timestamp evidence:

1. `poll: terminal event recovered` when the latest assistant answer is
   completed at or after the turn start and the server idle stamp
   (`time.idle` from `session.get`, monotonic) is at or after that
   completion. The idle stamp only advances on a real idle transition, so
   it doubles as proof that the turn ended.
2. `poll: watchdog released` when the guard has been stuck longer than the
   watchdog timeout (`ORP_STUCK_GUARD_MS`, default 2 minutes), no answer is
   in progress, and the idle stamp is absent or at/after the turn start.

Stale history whose completion predates the turn start never satisfies rule
1, so a long-running turn (which only shows an old idle stamp) cannot be
released into a false `Waiting for command`. Native events, tool hook
activity, and server message updates all count as activity evidence that
keeps the watchdog quiet.

V1 vs V2 session storage (important for prompt counting)
---------------------------------------------------------

OpenCode V1 and V2 use separate SQLite tables for session data:

  | Aspect       | V1                    | V2                      |
  |--------------|-----------------------|-------------------------|
  | Session      | `session` table       | `session_v2` table      |
  | Messages     | `message` table       | `session_message` table |
  | Message type | JSON `data.role`      | column `type`           |

Database location: `~/.local/share/opencode/opencode.db`

When a user migrates from V1 to V2 via `/update`, the session entry is
created in `session_v2` but the messages remain in the V1 `message` table.
New sessions created in V2 store messages in `session_message`. Therefore
prompt counting must check BOTH tables:

  V2 sessions: SELECT COUNT(*) FROM session_message
               WHERE session_id = ? AND type = 'user'

  V1 sessions: SELECT COUNT(*) FROM message
               WHERE session_id = ?
               AND json_extract(data, '$.role') = 'user'

The `countAllUserMessages()` function in `index.v2.js` implements this
dual-table query. It runs once per session on first load (since it reads
the database), then incremental counting from events takes over.

The `session.context` API is NOT suitable for prompt counting: it only
returns the context window (~100 messages that fit in the model's
context), not the full message history. For sessions with hundreds or
thousands of prompts, `session.context` severely undercounts.

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

Newline-delimited JSON over the local IPC endpoint
(`~/.config/opencode/.opencode-rich-presence.sock` on Linux/macOS,
`\\.\pipe\opencode-rich-presence-<userhash>` on Windows). Node's `net`
module addresses both through the same `listen()` / `createConnection()`
API, so the protocol is identical.

### Daemon liveness

Whether a daemon is serving is answered from the PID file plus
`process.kill(pid, 0)`, never from `existsSync()` on the address. On
Windows the address is a named pipe, not a filesystem entry, so
`existsSync` would report every running daemon as absent. A stale socket
file is likewise not proof of a healthy daemon, so liveness requires
both a readable PID file and a living process. `EPERM` counts as alive
(process exists, owned by another user); only `ESRCH` means dead.

`src/shared/daemon-liveness.js` is the only module that answers this
question. Removing a stale address is `unlinkSocketPath()`, a no-op on
Windows because the pipe entry dies with its process.

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

{"type": "set-enabled", "enabled": true|false}
    Runtime toggle from `opencode-rpc on/off`. When false the daemon
    stops pushing and clears the current activity; when true it
    resets the push fingerprint and resumes. No daemon restart, no
    Discord reconnect: the single IPC connection is reused, so `on`
    is instant. If `on` arrives within ~1.5s of a `clearActivity`,
    the first push is delayed past Discord's silent-drop window.
```

Daemon -> Plugin:

```json
{"type": "ack", "capabilities": ["set-enabled"]}
    Acknowledgement (always sent in response to client messages). The
    hello ack advertises the daemon's protocol capabilities; the
    plugin recycles a daemon that does not list a capability it needs
    (e.g. one started before `set-enabled` existed, which would
    silently ignore `off`/`on`).

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

## Presence Control (on/off/kill/spawn)

Control state lives in a marker file, not in `discord-config.json`:

```
~/.config/opencode/.opencode-rich-presence.state.json
{"presenceEnabled": true, "daemonStopped": false, "updatedAt": 1234567890}
```

- Written atomically (tmp file + rename) by `src/shared/presence-state.js`.
- Missing, empty, or corrupt file falls back to enabled=true, stopped=false.
- `presenceEnabled=false` (from `opencode-rpc off`): the plugin still
  renders locally for the activity log but skips `sendStateToDaemon`;
  a running daemon is told `set-enabled:false` and clears the activity.
- `daemonStopped=true` (from `opencode-rpc kill`): both
  `ensureDaemonAndConnect` (plugin) and `ensureDaemonRunning`
  (spawner) refuse to spawn, so the user's kill survives the next
  chat.message. `opencode-rpc spawn` (and `on`, which means
  "resume now") clear the flag. The gate only suppresses spawning:
  a daemon that is already listening is always reused.
- The plugin re-reads the marker on every `REFRESH_INTERVAL` tick, so a
  toggle made in another terminal takes effect without restarting
  OpenCode.
- **Daemon singleton**: only one daemon may hold the socket and the
  Discord IPC connection. `daemon.mjs` `main()` exits when the PID
  file names a live process, and `opencode-rpc spawn` refuses with
  "already running". Without this a second daemon unlinked the first
  one's socket, `off`/`on` landed on the new daemon while pushes kept
  flowing through the old one, and presence looked hung until the
  plugin reconnected.

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

The template engine (`src/plugin/template-engine.js`) derives vars in `getTemplateVars(session, replacements)`:

- **Model variants:** `model` (raw), `modelCode` (after last `/`, any provider level stripped), `modelName` (from code: `-`/`_`/`:` -> space, `.` preserved, Title Cased), `modelNameLower` (lowercased). Example `oc/muse-spark-1.2-contributor-free` -> `modelCode=muse-spark-1.2-contributor-free`, `modelName=Muse Spark 1.2 Contributor Free`.
- **Replacements:** wildcard rules from `replacements` (top-level, see CUSTOMIZATION.md) are applied to the derived vars before they are substituted into templates. `*` only at the edges of `from` (`Free`, `*Free`, `Free*`, `*Free*`), literal and case-sensitive, chaining in order, duplicates deduped. Config validation lives in `config-resolver.js` (`normalizeReplacements`), render path is `local-presence.js: getTemplateVars(session, config.replacements)`.

The template engine supports:

1. **Variables:** `{model}`, `{modelCode}`, `{modelName}`, `{modelNameLower}`, `{context}`, etc.
2. **Fallbacks:** `{var|fallback}` is used if var is undefined/null.
3. **Boolean conditionals:** `{{#if thinking}}...{{else}}...{{/if}}`
4. **Comparison conditionals:** `{{#if contextPercent > 50}}...{{else}}...{{/if}}`
5. **Per-state templates:** `byState.Typing.state`, etc.

Template set selection (in `local-presence.js` `renderPresence`):
- **No session at all** (queue empty, nothing displayed) -> the
  `idle` template set.
- **Any existing session** (including `"Waiting for command"`) ->
  `chooseTemplates(config.templates, state)`, which prefers
  `byState[state]` and falls back to the top-level templates.

This means a session in `"Waiting for command"` (shown as
"Completed!" in user configs) is NOT routed through `idle`. It
keeps its real accumulated cost and tokens, so
`byState["Waiting for command"]` (e.g. a dynamic `{costCompact}`
expression) takes effect. Using the `idle` set for a finished
session would shadow that entry and (in configs that hardcode
`$0 spent` in `idle.details`) make the displayed cost reset to $0
even though the session data is correct.

Variable substitution handles edge cases:
- `{var}` (typo missing `}` matches, returns fallback or "?")
- `{var}}` (extra `}` matches, returns var value)
- Missing var -> fallback or "?"

## CLI Subcommands

| Command | Purpose |
|---------|---------|
| `install` | Create config; migrate any v2.0.5-era opencode.jsonc entry; create symlink. |
| `uninstall` | Stop daemon; remove runtime files, per-instance state files, activity log, socket, PID file, presence state marker; optional config backup. |
| `restart` | Kill running daemon (SIGTERM + 2s grace + SIGKILL); rotate activity log. Auto-respawns on next chat.message. |
| `on` / `off` | Toggle presence via the state marker + a `set-enabled` socket message. The daemon stays alive, so `on` never pays a Discord reconnect. `on` also clears a leftover kill lock. |
| `kill` | Stop the daemon permanently. Sets `daemonStopped` so the auto-spawn on chat.message does not undo it. |
| `spawn` | Clear `daemonStopped`, start the daemon, wait for the socket, resume pushing. Refuses when a daemon is already running (singleton). |
| `update` | Check GitHub, self-update |
| `info` | Diagnostics dump + daemon status (socket presence, PID, alive) + presence state + activity log tail |
| `help`, `version` | Usage info |

CLI is zero-dependency (built-in `readline/promises` for confirmations).

## Cross-Platform Considerations

| Concern | Linux | macOS | Windows |
|---------|-------|-------|---------|
| Config dir | `~/.config/opencode/` | `~/.config/opencode/` | `%USERPROFILE%\.config\opencode\` |
| Activity log | `~/.config/opencode/presence-activity.log` (append-only) | same | same |
| Debug log | `/tmp/opencode-rich-presence-debug.log` | `/var/folders/.../T/opencode-rich-presence-debug.log` | `%TEMP%\opencode-rich-presence-debug.log` |
| Daemon IPC | Unix socket `~/.config/opencode/.opencode-rich-presence.sock` | Unix socket same | Named pipe `\\.\pipe\opencode-rich-presence-<userhash>` |
| Discord IPC | Unix socket `/run/user/1000/discord-ipc-0` | Unix socket `/tmp/discord-ipc-0` | Named pipe `\\.\pipe\discord-ipc-N` (ids 0-9, both `\\.\pipe\` and `\\?\pipe\` forms) |

The plugin code itself is fully cross-platform thanks to:
- `os.homedir()` + `path.join()` for paths
- `os.tmpdir()` for debug log
- libuv-supported stdlib APIs
- `process.platform === "win32"` for pipe path handling

## Plugin Loading

OpenCode loads plugins from `~/.config/opencode/plugins/`. The
`opencode-rich-presence` package is NOT published to the npm
registry. v2.0.6+ relies entirely on symlinks into the user's npm
prefix. V2 installs use a plugin directory at
`~/.config/opencode/plugins/opencode-rich-presence/` whose manifest
exports resolve the two plugin parts: `index.js` (server part, the V2
entry) and `tui.js` (TUI part, the client heartbeat). V1 installs and
older V2 installs use a single-file symlink at
`~/.config/opencode/plugins/opencode-rich-presence.js`; `opencode-rpc
install` migrates that form to the directory.

The package has zero runtime dependencies. The V2 entry inlines the
`Plugin.define` identity helper from the `@opencode/plugin` SDK, so a
fresh `npm install -g` resolves no dependency tree at all and cannot
be broken by upstream dependency churn (a `@opencode/plugin@2.2.0`
peer-set change crashed npm 10.8.x installs; see
`docs/TROUBLESHOOTING.md`).

## Client Presence (heartbeat + auto-clear)

OpenCode's background service keeps running (and keeps the server part
loaded) after the last client window closes, and it emits no client
disconnect event. The plugin therefore cannot ask the server whether a
window is open. Instead, the TUI part runs inside every client window
and touches `~/.config/opencode/.opencode-rich-presence.heartbeat`
every 10 seconds; the server part reads that file's mtime.

The push loop shows the presence while any of these hold:

- a client window is attached (heartbeat mtime within
  `ORP_CLIENT_TIMEOUT_MS`, default 30 seconds),
- server-side work is running (an execution guard or a non-idle,
  non-ASKING session state), covering headless `opencode run` usage and
  turns that finish after the user quit,
- no heartbeat file exists at all (older clients without TUI parts),
  which keeps the legacy always-on behavior.

When none hold, the server part sends a goodbye to the daemon (which
clears the Discord activity) and suppresses pushes until a client or
new activity reappears. An ASKING session (pending permission) counts
as no work: it cannot advance without a client, so it must not pin the
presence forever. The heartbeat is the only "user is gone" signal, so
the client timeout is the detection window between closing the last
window and clearing the presence.

**Do not add `"opencode-rich-presence"` to the `plugin` array in
`opencode.jsonc` or `opencode.json`.** OpenCode reads that array as
a list of npm packages to fetch on startup via Bun, and the package
does not exist on npm. The entry causes a 404 notification on every
OpenCode launch. Phase 2 never writes this entry; v2.0.5-era
installs that did write it are migrated on next `opencode-rpc
install` (offered, default Y) and on `opencode-rpc uninstall`
(auto-removed).
