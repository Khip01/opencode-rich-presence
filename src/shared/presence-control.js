// Presence control helper: send a one-shot control message to the
// running daemon over the local socket. Used by the on/off CLI
// commands to toggle presence without restarting the daemon (and
// therefore without a Discord reconnect, which can hit Discord's
// App-ID cooldown window).
//
// Fire-and-forget by design: if the daemon is not running, the caller
// still persists the intent to the state marker and the daemon picks
// it up on its next start. We never fail the CLI on a missing daemon.

import net from "node:net";
import { DAEMON_SOCKET } from "./paths.js";
import { isDaemonAlive } from "./daemon-liveness.js";

// Send a single JSON line to the daemon. Returns true if the write
// landed, false if the daemon was not reachable. Never throws.
export function sendControl(msg, { timeoutMs = 1000 } = {}) {
    if (!isDaemonAlive()) return Promise.resolve(false);
    return new Promise((resolve) => {
        let settled = false;
        const finish = (ok) => {
            if (settled) return;
            settled = true;
            try { sock.destroy(); } catch {}
            resolve(ok);
        };
        // DAEMON_SOCKET is already the full address for this platform
        // (a `.sock` path on POSIX, a `\\.\pipe\...` name on Windows).
        // It used to be passed through a local socketPathForPlatform()
        // that prepended the pipe prefix here too, which produced
        // `\\.\pipe\\.\pipe\opencode-rich-presence` once the pipe name
        // moved into paths.js and made on/off silently miss the daemon.
        const sock = net.createConnection(DAEMON_SOCKET);
        const timer = setTimeout(() => finish(false), timeoutMs);
        timer.unref?.();
        sock.once("connect", () => {
            try {
                sock.write(JSON.stringify(msg) + "\n", () => finish(true));
            } catch {
                finish(false);
            }
        });
        sock.once("error", () => {
            clearTimeout(timer);
            finish(false);
        });
    });
}