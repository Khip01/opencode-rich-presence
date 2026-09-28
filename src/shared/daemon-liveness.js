// Cross-platform "is a daemon listening?" checks.
//
// The daemon IPC address is a Unix domain socket file on Linux/macOS
// and a named pipe on Windows. That difference breaks the obvious
// implementation. `existsSync(DAEMON_SOCKET)` is the cheap way to ask
// "is a daemon already there?", and it works on POSIX, but on Windows a
// named pipe is not a filesystem entry: `existsSync` always returns
// false, so every such check reports "no daemon" even while one is
// serving requests.
//
// Consequences before this module existed, all Windows-only:
//   - the plugin never reused a live daemon and kept spawning more,
//   - the spawner waited forever for a socket file that never appears,
//   - `opencode-rpc info` always printed "[absent]",
//   - `kill` / `restart` / `uninstall` could not clean up.
//
// The fix: on Windows, answer liveness from the PID file plus
// `process.kill(pid, 0)`, which works identically on every platform.
// On POSIX keep `existsSync`, which is both cheap and the more direct
// signal, but still cross-check the PID so a crashed daemon that left
// its socket file behind is not mistaken for a healthy one.

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import process from "node:process";
import { DAEMON_PID_FILE, DAEMON_SOCKET, IS_WINDOWS } from "./paths.js";

// True when the OS says a process with this pid exists.
//
// `process.kill(pid, 0)` performs the permission and existence check
// without delivering a signal. It throws ESRCH when nothing is running
// and EPERM when the process exists but belongs to another user. EPERM
// therefore means "alive, just not ours to signal", so it counts as
// alive; only ESRCH means dead.
export function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e?.code === "EPERM";
    }
}

// Read the recorded daemon pid, or null when there is no readable
// PID file. A malformed or empty file is treated as absent.
export function readDaemonPid() {
    try {
        if (!existsSync(DAEMON_PID_FILE)) return null;
        const pid = parseInt(readFileSync(DAEMON_PID_FILE, "utf-8").trim(), 10);
        return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
        return null;
    }
}

// Is a daemon currently serving? Requires both the PID file and a
// living process, so neither a stale PID file nor a stale socket file
// is enough on its own.
export function isDaemonAlive() {
    const pid = readDaemonPid();
    if (pid === null) return false;
    return isPidAlive(pid);
}

// Has the daemon finished starting, i.e. is it actually accepting
// connections?
//
// This is one step stricter than isDaemonAlive() and it matters right
// after a spawn: main() writes the PID file BEFORE calling startServer(),
// so for a brief window the process is alive but not yet bound. Whoever
// only checks isDaemonAlive() can try to connect and get ECONNREFUSED.
//
// On POSIX the socket file is created by listen(), so requiring it is
// exact, and it also preserves the pre-Windows-support behavior.
// On Windows a pipe cannot be stat'd, so the PID is the only synchronous
// signal available; the caller's post-detection settle delay covers the
// remaining window.
export function isDaemonReady() {
    if (!isDaemonAlive()) return false;
    if (IS_WINDOWS) return true;
    return existsSync(DAEMON_SOCKET);
}

// Remove the IPC address if it is a filesystem entry.
//
// A named pipe is not a file: the pipe namespace entry is owned by the
// process that created it and disappears when that process exits, so
// there is nothing to unlink. Calling unlinkSync on a pipe path throws
// ENOENT/EPERM and, worse, the error message is misleading in logs.
// Deliberately a no-op on Windows.
export function unlinkSocketPath() {
    if (IS_WINDOWS) return false;
    if (!existsSync(DAEMON_SOCKET)) return false;
    try {
        unlinkSync(DAEMON_SOCKET);
        return true;
    } catch {
        return false;
    }
}
