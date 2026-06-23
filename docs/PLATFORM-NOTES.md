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

The restart command uses `osascript -e 'tell application "Discord" to quit'` for graceful shutdown. macOS prompts the user the first time an app is quit via AppleScript.

If AppleScript fails (Discord already crashed, permission issue), the CLI falls back to `pkill -x Discord`.

### IPC transport

Same as Linux: Unix domain sockets at `/tmp/discord-ipc-{0..9}`.

### Apple Silicon vs Intel

- Apple Silicon: Discord runs natively. No issues.
- Intel: Same.
- Rosetta: Not needed for Discord or Node.js plugins.

### Process management

- Detection: `pkill -x Discord` (macOS ships `pkill` via BSD)
- Quit: `osascript` (preferred), `pkill` (fallback)
- Relaunch: `open -a Discord`

---

## Windows

### Installation paths

Discord is installed in `%LOCALAPPDATA%\Discord\`. The CLI restart command uses `cmd /c start "" Discord` which lets Windows resolve the app via PATH/registry.

### IPC transport

Discord IPC uses **named pipes** at `\\.\pipe\discord-ipc-{0..9}` (not Unix sockets). The `@xhayper/discord-rpc` library handles this transparently, so no code changes are needed in the plugin.

### File system

OpenCode normalizes to `~/.config/opencode/` even on Windows (XDG-style via `%USERPROFILE%\.config\opencode\`). The plugin follows this convention.

### Process management

- Detection: `tasklist /FI "IMAGENAME eq Discord.exe"` (CLI uses `ps`-equivalent via shell)
- Kill: `taskkill /IM Discord.exe /T /F` (`/T` for tree, `/F` for force)
- Relaunch: `cmd /c start "" Discord`

### Windows-specific notes

- **No `pgrep`/`pkill`**: Windows uses `tasklist`/`taskkill`. The CLI has a separate Windows implementation.
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
