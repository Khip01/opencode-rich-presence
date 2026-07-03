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

Discord IPC allows only one active connection per Application ID. When multiple OpenCode instances run, only one should push to Discord. v2.0.7+ uses **activity-based leader election**: the actively-chatting instance wins leadership, regardless of which OpenCode window opened first.

**Algorithm** (in `coordinator.js`):

1. Try to create `~/.config/opencode/.opencode-rich-presence.lock` with `wx` (exclusive). Payload: `{pid, started, lastActivity}`.
2. If success: become leader. Start heartbeat (every 5s, rewrites lock with current `lastActivity`).
3. If file exists and is fresh (< 15s) and owned by a different PID: become standby. Start polling (every 2s).
4. If file is stale (>= 15s old): unlink and retry from step 1.

**Activity handoff** (v2.0.7+):

When a standby instance receives an event that implies user/agent activity (`chat.message`, `message.part.updated`, `permission.asked`, `permission.replied`, etc.), it:

1. Writes a handoff signal to `~/.config/opencode/.opencode-rich-presence-handoff` containing `{pid, requestedAt: timestamp}`.
2. Tries to acquire the lock immediately in case the leader has already released.

The leader's heartbeat loop reads the handoff signal on each tick. If it sees a request from a different PID with a `requestedAt` newer than its own `lastActivity`, the leader releases the lock. The standby's next poll (within 2s) acquires it. A leadership-change callback in `index.js` calls `startConnect()` / `shutdownWorker()` so the new leader starts pushing to Discord.

**Standby polling** (v2.0.7+):

Every 2s, a standby instance checks the lock. If the lock is missing (leader released) or stale (leader died), the standby attempts to acquire it. This handles the "leader crashed without releasing" case as well as the handoff case.

**Lock file format:**
```json
{ "pid": 12345, "started": 1719123456789, "lastActivity": 1719123500000 }
```

**Heartbeat:** Leader rewrites lock every 5s. Stale threshold: 15s (3x heartbeat).

**Cleanup:** Leader releases lock on dispose. Standby instances never touch the lock, only the handoff signal and the polling loop.

## Subprocess Worker

The worker is spawned as a Node.js subprocess (not loaded in-process) because:

- OpenCode runs on Bun, which has known issues with Discord IPC Unix sockets.
- Node.js has stable Discord RPC support via `@xhayper/discord-rpc`.
- Worker crash doesn't take down the plugin.

**Spawn:** `node src/worker/discord-worker.mjs` (or `bun`/`bun.exe` if available).

The worker path is computed in `src/shared/paths.js` via `fileURLToPath(new URL("../worker/discord-worker.mjs", import.meta.url))`. This resolves relative to the location of the plugin entry file, so it follows symlinks correctly whether the plugin is loaded from the npm global install, a local source checkout, or the symlinked `~/.config/opencode/plugins/opencode-rich-presence.js`.

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

`opencode-rpc restart` triggers a coordinated worker reload:

1. Write `~/.config/opencode/.discord-restart-request` signal file.
2. CLI kills the `discord-worker.mjs` subprocess (`pgrep` + `kill -TERM` on Linux/macOS, `wmic` + `taskkill` on Windows).
3. Worker exits and sees the signal file, marks it as intentional restart.
4. Worker waits 2 seconds (IPC socket release delay).
5. Plugin reloads config and respawns worker with new settings.

Discord Desktop is not touched by `restart`. If Discord itself is stuck, close and reopen it manually.

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

## Plugin Loading

OpenCode loads plugins from `~/.config/opencode/plugins/` and `.opencode/plugins/`. The `opencode-rich-presence` package is NOT published to the npm registry (only distributed via GitHub Releases tarballs). v2.0.6+ relies entirely on a symlink at `~/.config/opencode/plugins/opencode-rich-presence.js` pointing to the plugin entry file in the user's npm prefix. OpenCode loads the plugin directly from disk via this symlink.

**Do not add `"opencode-rich-presence"` to the `plugin` array in `opencode.jsonc` or `opencode.json`.** OpenCode reads that array as a list of npm packages to fetch on startup via Bun, and the package does not exist on npm. The entry causes a 404 notification on every OpenCode launch. v2.0.6+ never writes this entry; v2.0.5-era installs that did write it are migrated on next `opencode-rpc install` (offered, default Y) and on `opencode-rpc uninstall` (auto-removed).

The symlink target is computed at install time based on the install location (global `npm install -g` or local `npm link`), so it works for both end users and developers.

For the worker's `@xhayper/discord-rpc` dependency, the installer also adds it to `~/.config/opencode/package.json` and runs `npm install` there so the dependency is resolvable via Node's module resolution (walking up from the worker's location).

## CLI Subcommands

| Command | Purpose |
|---------|---------|
| `install` | Create config; migrate any v2.0.5-era opencode.jsonc entry; create symlink; install dep |
| `uninstall` | Remove runtime files, symlink, dependency, and any stale opencode.jsonc entry; ask Y/N for config |
| `restart` | Reload plugin worker (does NOT touch Discord Desktop) |
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
