import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

// OpenCode standardizes ~/.config/opencode/ across all platforms (Linux, macOS, Windows).
// See: https://opencode.ai/docs/config#global
//
// We honor OPENCODE_CONFIG_DIR env var if set (per OpenCode convention).
export const OPENCODE_DIR = process.env.OPENCODE_CONFIG_DIR
    ? process.env.OPENCODE_CONFIG_DIR
    : join(homedir(), ".config", "opencode");

export const CONFIG_PATH = join(OPENCODE_DIR, "discord-config.json");
export const OUTPUT_FILE = join(OPENCODE_DIR, "presence-state.txt");

// Directory holding the per-instance state snapshots that each OpenCode
// plugin process writes. One file per PID, cleaned up by
// shared/presence-gc.js on plugin init (dead PIDs / age cap). Lives in a
// subfolder so `ls ~/.config/opencode/` stays readable.
export const PRESENCE_STATE_DIR = join(OPENCODE_DIR, "presence-states");
// Internal control state for the on/off/kill/spawn commands. Separate from
// discord-config.json on purpose: it is program state, not user configuration,
// and must never be hand-edited by users. Written atomically (tmp + rename).
export const PRESENCE_STATE = join(OPENCODE_DIR, ".opencode-rich-presence.state.json");
// Phase 1 redesign: comprehensive chronological activity log. Append-only so the
// user can `tail -f` it while running OpenCode and see exactly what the plugin
// did and what it WOULD have pushed to Discord (Phase 2 adds the actual push).
// Each entry: [ISO timestamp] [tag] message. Tags let you grep for one kind
// of event: state transitions, template renders, SDK events, etc.
export const ACTIVITY_LOG = join(OPENCODE_DIR, "presence-activity.log");

// Phase 2: local IPC endpoint the daemon listens on. OpenCode plugin
// instances connect here to register themselves and send state updates.
//
// Linux/macOS: Unix domain socket file at this path.
// Windows: named pipe. A `.sock` file cannot work on Windows, because
// Node cannot bind AF_UNIX there, so we use a named pipe
// (`\\.\pipe\<name>`). Node's net module drives both through the exact
// same `listen()` / `createConnection()` API, so the rest of the
// codebase needs no platform branch to talk to it.
//
// Windows named pipes are machine-global, so a fixed name would let two
// accounts on one PC fight over the same daemon. Mix the username into a
// short hash: it keeps the pipe name within the character set Windows
// accepts for pipe names and stays short.
export const IS_WINDOWS = process.platform === "win32";

const PIPE_SCOPE = (() => {
    let raw = "default";
    try { raw = userInfo().username || raw; } catch {}
    return createHash("sha256").update(raw).digest("hex").slice(0, 8);
})();

// This value is the single source of truth for the daemon IPC address.
// Do NOT prepend `\\.\pipe\` anywhere else. That used to live in
// per-module `socketPathForPlatform()` helpers, and once the full pipe
// name moved here those helpers double-prefixed the path
// (`\\.\pipe\\.\pipe\opencode-rich-presence`), which broke on/off.
export const DAEMON_SOCKET = IS_WINDOWS
    ? `\\\\.\\pipe\\opencode-rich-presence-${PIPE_SCOPE}`
    : join(OPENCODE_DIR, ".opencode-rich-presence.sock");

// File written by the first OpenCode instance when it spawns the daemon.
// Subsequent OpenCode instances see this file and know the daemon is
// already running. Used as a quick check before trying to connect to
// the socket (the socket itself is the authoritative source of truth).
export const DAEMON_PID_FILE = join(OPENCODE_DIR, ".opencode-rich-presence.pid");

// Debug log uses OS temp directory (cross-platform: /tmp on Linux, /var/folders/... on macOS, %TEMP% on Windows).
export const DEBUG_LOG = join(tmpdir(), "opencode-rich-presence-debug.log");
