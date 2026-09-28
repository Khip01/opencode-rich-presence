# Platform Notes

Per-OS behavior and quirks.

## Linux

### Installation paths

Discord is auto-detected from these common locations:

- `/usr/bin/discord`
- `/usr/local/bin/discord`
- `/opt/discord/discord`
- `/snap/bin/discord` (Snap)
- `/var/lib/flatpak/exports/bin/com.discordapp.Discord` (system Flatpak)
- `~/.local/share/flatpak/exports/bin/com.discordapp.Discord` (user Flatpak)

If your Discord is installed elsewhere, the CLI restart command will warn and ask you to start Discord manually.

### File system

OpenCode uses `~/.config/opencode/` on Linux regardless of distro. Plugin code follows this convention.

### IPC transport

Discord IPC uses Unix domain sockets at `/tmp/discord-ipc-{0..9}`. The `@xhayper/discord-rpc` library handles this transparently.

### Process management

- Detection: `ps -eo pid,comm`
- Kill: `kill -TERM` (graceful), `kill -KILL` (force)
- Relaunch: spawn with `detached: true` and unref

---

## macOS

### Installation paths

Discord Desktop is installed as `/Applications/Discord.app`. The CLI uses `open -a Discord` which invokes Launch Services (no need to know the path explicitly).

### AppleScript quit

`opencode-rpc restart` does NOT touch Discord Desktop. The plugin worker is killed and respawned by the plugin itself, leaving any active Discord session (including voice chat) running.

### IPC transport

Same as Linux: Unix domain sockets at `/tmp/discord-ipc-{0..9}`.

### Apple Silicon vs Intel

- Apple Silicon: Discord runs natively. No issues.
- Intel: Same.
- Rosetta: Not needed for Discord or Node.js plugins.

---

## Windows

### Installation paths

Discord is installed in `%LOCALAPPDATA%\Discord\`. `opencode-rpc restart` does not touch Discord Desktop, so there is no relaunch behavior to worry about.

### IPC transport

Windows has no Unix domain sockets, so both IPC endpoints on this
platform are **named pipes**:

| Endpoint | Address |
|---|---|
| Plugin -> daemon | `\\.\pipe\opencode-rich-presence-<userhash>` |
| Daemon -> Discord | `\\.\pipe\discord-ipc-N` (ids 0-9) |

`<userhash>` is a short hash of the OS username. Windows named pipes
are machine-global, so without it two accounts on one PC would fight
over a single daemon.

Two consequences fall out of this:

- **`existsSync()` cannot see a pipe.** It always returns false for a
  named-pipe address, so any code that asks "does the socket exist?"
  would report every running daemon as absent. All liveness checks go
  through `src/shared/daemon-liveness.js` instead, which answers from
  the PID file plus `process.kill(pid, 0)`.
- **A pipe cannot be unlinked.** The pipe entry is owned by the
  process that created it and vanishes when that process exits.
  Cleanup paths use `unlinkSocketPath()`, a no-op on Windows.

The client is our own `src/worker/discord-ipc.mjs` (the v3 rewrite
dropped `@xhayper/discord-rpc` over its fixed 10s handshake timeout).
It probes both the `\\.\pipe\` and `\\?\pipe\` spellings, since both
resolve to the same pipe.

### File system

OpenCode normalizes to `~/.config/opencode/` even on Windows (XDG-style via `%USERPROFILE%\.config\opencode\`). The plugin follows this convention.

### Worker process management

The `restart` command uses `pgrep` on Linux/macOS and `wmic` + `taskkill` on Windows to find and kill the `discord-worker.mjs` subprocess. After the kill, the plugin respawns the worker after a 2-second IPC socket release delay.

### Windows-specific notes

- **No `pgrep`/`pkill`**: Windows uses `wmic` + `taskkill` for worker process management.
- **No `read -p`**: The CLI uses Node.js built-in `readline/promises` (zero-dep) instead of bash read.
- **No GNU sed/awk**: All text processing is in JavaScript.
- **Path separators**: All paths use `path.join()` which handles `\` on Windows.

### WSL

OpenCode itself runs natively on Windows, but the [official docs](https://opencode.ai/docs/windows-wsl) recommend WSL for the best experience. If you run OpenCode via WSL, the plugin's `~/.config/opencode/` lives inside the WSL filesystem at `\\wsl$\Ubuntu\home\<user>\.config\opencode\`.

---

## Cross-cutting

### Node.js paths

The plugin searches for Node.js in this order (cross-platform):

1. `process.execPath` if it's `node`/`node.exe`/`bun`/`bun.exe`
2. Unix: `~/.nvm/versions/node/v<ver>/bin/node`
3. Unix: `/usr/bin/node`, `/usr/local/bin/node`, `/opt/homebrew/bin/node`
4. Windows: `%ProgramFiles%\nodejs\node.exe`, `%ProgramFiles(x86)%\nodejs\node.exe`, `%LOCALAPPDATA%\Programs\nodejs\node.exe`
5. PATH fallback: just `"node"`

### Lock file

Stored at `~/.config/opencode/.opencode-rich-presence.lock`. JSON-encoded with `{pid, started}`.

### Debug log

Stored in OS temp directory:

- Linux: `/tmp/opencode-rich-presence-debug.log`
- macOS: `/var/folders/.../opencode-rich-presence-debug.log`
- Windows: `%TEMP%\opencode-rich-presence-debug.log`

Enable verbose logging:
```bash
OPENCODE_RICH_PRESENCE_DEBUG=true opencode
```

### Signals

The worker subprocess handles `SIGINT` and `SIGTERM` (libuv on Windows simulates these). The plugin's parent process uses `SIGTERM` for graceful worker shutdown (200ms timeout), then `SIGKILL` (500ms timeout).
