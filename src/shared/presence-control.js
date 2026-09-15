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
import { existsSync } from "node:fs";
import { DAEMON_SOCKET } from "./paths.js";

function socketPathForPlatform(p) {
    if (process.platform === "win32") {
        return `\\\\.\\pipe\\${p.split("/").pop()}`;
    }
    return p;
}

// Send a single JSON line to the daemon. Returns true if the write
// landed, false if the daemon was not reachable. Never throws.
export function sendControl(msg, { timeoutMs = 1000 } = {}) {
    if (!existsSync(DAEMON_SOCKET)) return Promise.resolve(false);
    return new Promise((resolve) => {
        let settled = false;
        const finish = (ok) => {
            if (settled) return;
            settled = true;
            try { sock.destroy(); } catch {}
            resolve(ok);
        };
        const sock = net.createConnection(socketPathForPlatform(DAEMON_SOCKET));
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