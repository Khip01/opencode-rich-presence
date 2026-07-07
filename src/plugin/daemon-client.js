// Daemon client: plugin-side connection to the long-lived daemon.
//
// The plugin (one per OpenCode process) uses this client to:
//   1. Connect to the daemon's local Unix socket
//   2. Send "hello" to register itself
//   3. Send "state" updates whenever local session state changes
//   4. Send "goodbye" when the plugin disposes
//
// The client is stateless: it just queues messages and lets the daemon
// decide what to display. If the daemon is not running, the client
// can return an error so the plugin can spawn a new one.
//
// On Linux/macOS this is a Unix domain socket.
// On Windows this would be a named pipe (`\\.\pipe\<name>`); the
// `connectToDaemonSocket` function applies the right prefix.

import net from "node:net";
import { existsSync } from "node:fs";
import { DAEMON_SOCKET } from "../shared/paths.js";
import { log } from "../shared/logger.js";

// Returns the socket path for the current platform. On Linux/macOS,
// the path is already correct. On Windows, named pipes need the
// `\\.\pipe\` prefix.
function socketPathForPlatform(p) {
    if (process.platform === "win32") {
        return `\\\\.\\pipe\\${p.split("/").pop()}`;
    }
    return p;
}

// Quick check: is the daemon socket present? Fast (no connect attempt).
export function isDaemonSocketPresent() {
    return existsSync(DAEMON_SOCKET);
}

export class DaemonClient {
    constructor({ timeoutMs = 2000 } = {}) {
        this.timeoutMs = timeoutMs;
        this.socket = null;
        this.connected = false;
        this.helloSent = false;
        this.bufferedLines = [];
        this.lastError = null;
        this.onDisconnected = null;
    }

    isConnected() {
        return this.connected && this.socket?.writable === true;
    }

    async connect(pid) {
        if (this.connected) return true;
        if (!existsSync(DAEMON_SOCKET)) {
            this.lastError = "daemon socket not present";
            return false;
        }
        const socketPath = socketPathForPlatform(DAEMON_SOCKET);

        return new Promise((resolve) => {
            let settled = false;
            const sock = net.createConnection(socketPath);
            this.socket = sock;
            let buf = "";
            sock.setEncoding("utf-8");

            const finish = (ok) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(ok);
            };

            const timer = setTimeout(() => {
                if (!settled) {
                    try { sock.destroy(); } catch {}
                    this.lastError = `daemon connect timeout after ${this.timeoutMs}ms`;
                    finish(false);
                }
            }, this.timeoutMs);

            sock.once("connect", () => {
                this.connected = true;
                // Send hello so the daemon registers us.
                const hello = JSON.stringify({ type: "hello", pid }) + "\n";
                sock.write(hello);
                this.helloSent = true;
                finish(true);
            });

            sock.on("data", (chunk) => {
                buf += chunk;
                let idx;
                while ((idx = buf.indexOf("\n")) !== -1) {
                    const line = buf.slice(0, idx);
                    buf = buf.slice(idx + 1);
                    if (!line.trim()) continue;
                    // We do not currently consume acks/state messages;
                    // future enhancement: track daemon-reported Discord
                    // status for the user's `info` output.
                }
            });

            sock.once("error", (e) => {
                this.lastError = e?.message || String(e);
                this.connected = false;
                finish(false);
            });

            sock.once("close", () => {
                this.connected = false;
                if (this.onDisconnected) this.onDisconnected();
            });
        });
    }

    // Send a single message. Returns true if the socket is writable.
    // Fire-and-forget: we do not wait for an ack (the daemon acks
    // on the next line read; we just need the write to land).
    send(msg) {
        if (!this.socket?.writable) return false;
        try {
            this.socket.write(JSON.stringify(msg) + "\n");
            return true;
        } catch (e) {
            this.lastError = e?.message || String(e);
            return false;
        }
    }

    sendState(pid, session, rendered) {
        return this.send({
            type: "state",
            pid,
            session: session || null,
            rendered: rendered || null,
        });
    }

    sendGoodbye(pid) {
        return this.send({ type: "goodbye", pid });
    }

    disconnect() {
        if (!this.socket) return;
        try { this.socket.end(); } catch {}
        try { this.socket.destroy(); } catch {}
        this.socket = null;
        this.connected = false;
    }
}

export default DaemonClient;
