# Architecture

## Overview

```
                           OpenCode AI
                                |
                                | events (chat.message, session.*, message.*, ...)
                                v
   +-------------------------------------------------------------+
   |  OpenCodeRichPresence plugin  (src/plugin/index.js)         |
   |  - receives events, tracks SessionState                     |
   |  - coordinator: leader election via file lock               |
   |  - discord-service: pushes activity via worker              |
   |  - writes ~/.config/opencode/presence-state.txt             |
   +----------------------------+--------------------------------+
                                | stdin (NDJSON commands)
                                v
   +-------------------------------------------------------------+
   |  discord-worker.mjs  (src/worker/)                          |
   |  - uses @xhayper/discord-rpc                                |
   |  - handles reconnect with exponential backoff               |
   +----------------------------+--------------------------------+
                                | Discord IPC
                                v
                       Discord Desktop Client
```

## Module Structure

```
src/
  shared/
    paths.js          cross-platform paths (uses os.homedir + .config/opencode)
    constants.js      STATE enum, defaults, fallback model limits
    logger.js         debug log to os.tmpdir()
  plugin/
    index.js          main entry, event handlers, orchestration
    config-resolver.js  load discord-config.json + env vars
    coordinator.js    leader election (file lock + heartbeat)
    session-state.js  per-session token/cost/state tracking
    template-engine.js variables, conditionals, render, format helpers
    worker-spawner.js cross-platform node binary discovery, spawn worker
    discord-service.js  worker lifecycle + activity push
  worker/
    discord-worker.mjs  Node.js subprocess using @xhayper/discord-rpc
  cli/
    dispatcher.js     route subcommands
    install.js, uninstall.js, restart.js, update.js, info.js, help.js, version.js
    prompt.js         zero-dep readline confirmation
    platform/
      linux.js, macos.js, windows.js, index.js   cross-platform restart
```

## Multi-instance Coordinator

Discord IPC allows only one active connection per Application ID. When multiple OpenCode instances run, only one should push to Discord.

**Algorithm** (in `coordinator.js`):

1. Try to create `~/.config/opencode/.opencode-rich-presence.lock` with `wx` (exclusive).
2. If success: become leader. Start heartbeat (every 5s, rewrites lock).
3. If file exists: read it, check age. If fresh (< 15s) and not our PID: standby.
4. If stale: unlink and retry from step 1.

**Lock file format:**
```json
{ "pid": 12345, "started": 1719123456789 }
```

**Heartbeat:** Leader rewrites lock every 5s. Stale threshold: 15s (3x heartbeat).

**Cleanup:** Leader releases lock on dispose. Standby instances never touch the lock.

## Subprocess Worker

The worker is spawned as a Node.js subprocess (not loaded in-process) because:

- OpenCode runs on Bun, which has known issues with Discord IPC Unix sockets.
- Node.js has stable Discord RPC support via `@xhayper/discord-rpc`.
- Worker crash doesn't take down the plugin.

**Spawn:** `node src/worker/discord-worker.mjs` (or `bun`/`bun.exe` if available).

**IPC:** Newline-delimited JSON over stdin/stdout.

**Commands (parent -> worker):**
- `connect`: initiate Discord login
- `setActivity`: update presence
- `clearActivity`: clear presence
- `shutdown`: graceful disconnect
- `ping`: health check

**Events (worker -> parent):**
- `ready`: worker started
- `connected`: Discord READY
- `disconnected`: Discord disconnected
- `error`: connection error
- `attempt`: retry attempt with backoff
- `log`: log line

## Restart Flow

`opencode-rpc restart` triggers a coordinated reload:

1. Write `~/.config/opencode/.discord-restart-request` signal file.
2. Optionally kill + relaunch Discord desktop client (platform-specific).
3. Worker exits and sees the signal file → marks as intentional restart.
4. Worker waits 2 seconds (IPC socket release delay).
5. Plugin reloads config and respawns worker with new settings.

The 2s delay prevents a race where the new worker's connect() races with the old IPC socket still being released.

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
- Missing var → fallback or "?"

## CLI Subcommands

| Command | Purpose |
|---------|---------|
| `install` | Create config, print setup steps |
| `uninstall` | Interactive cleanup |
| `restart` | Restart Discord + trigger plugin reload |
| `update` | Check GitHub, self-update |
| `info` | Diagnostics dump |
| `help`, `version` | Usage info |

CLI is zero-dependency (built-in `readline/promises` for confirmations).

## Cross-Platform Considerations

| Concern | Linux | macOS | Windows |
|---------|-------|-------|---------|
| Config dir | `~/.config/opencode/` | `~/.config/opencode/` | `%USERPROFILE%\.config\opencode\` (normalized by OpenCode) |
| Discord IPC | Unix socket `/tmp/discord-ipc-N` | Unix socket `/tmp/discord-ipc-N` | Named pipe `\\.\pipe\discord-ipc-N` |
| Process detection | `ps -eo pid,comm` | `osascript` + `pkill` | `tasklist` |
| Kill signal | `kill -TERM/-KILL` | `osascript` quit, `pkill` | `taskkill /IM Discord.exe /T /F` |
| Relaunch | `spawn` (detached) | `open -a Discord` | `cmd /c start "" Discord` |

The plugin code itself is fully cross-platform thanks to:
- `os.homedir()` + `path.join()` for paths
- `os.tmpdir()` for debug log
- `@xhayper/discord-rpc` for cross-platform Discord IPC
- libuv simulating signals on Windows for `SIGTERM`/`SIGINT`

## Plugin Lifecycle

```
OpenCode startup
    |
    v
OpenCodeRichPresence({ client, directory }) called
    |
    +--> loadConfig()                (config-resolver.js)
    +--> coordinator.tryAcquire()    (coordinator.js)
    +--> loadProviderModels()        (async, via SDK)
    +--> if leader: spawn worker     (discord-service.js)
    +--> return { event, dispose, chat.message }
                |
                v
         event handlers update SessionState, schedule writes
                |
                v
         leader: push activity to Discord via worker
                |
                v
OpenCode shutdown
    |
    v
dispose() called
    |
    +--> clear timers
    +--> coordinator.release()
    +--> discordDestroy() (SIGTERM worker, then SIGKILL)
```
