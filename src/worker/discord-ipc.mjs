// Minimal Discord IPC client for the daemon.
//
// Replaces @xhayper/discord-rpc because that library has a hardcoded
// 10-second IPC handshake timeout that we cannot configure. On slow
// networks or when Discord's IPC server is busy, the 10s timeout
// fires before Discord's READY frame is processed, even though the
// IPC socket responded in milliseconds. The daemon uses this client
// instead, with a 30-second timeout.
//
// Discord IPC protocol (from discord.com/developers/docs/topics/rpc):
//   - Frame: [opcode: u32 LE][length: u32 LE][data: utf-8 JSON]
//   - Opcodes: 0 = HANDSHAKE, 1 = FRAME, 2 = CLOSE, 3 = PING, 4 = PONG
//   - Handshake send: {v: 1, client_id: "..."} (opcode 0)
//   - Handshake recv: in practice Discord sends DISPATCH READY as a
//     FRAME (opcode 1) with payload {cmd: "DISPATCH", evt: "READY",
//     data: {...}}. pypresence and @xhayper both wait for opcode 1
//     here, not opcode 0. We do the same.
//   - RPC command: {cmd, args, nonce} (opcode 1)
//   - RPC response: {cmd, data|error, nonce} (opcode 1)
//
// Design choices for the daemon:
//   - Fire-and-forget SET_ACTIVITY: we do not wait for the response.
//     The daemon writes presence often enough that missing one
//     update is harmless (the next update will land within 5s).
//   - Reconnect is the daemon's job, not the IPC client's. The
//     client just exposes `connect()` / `disconnect()` / `setActivity()`.
//     The daemon watches for socket death and calls connect() again
//     with backoff. The IPC client does not retry internally; this
//     keeps the failure modes predictable and observable.
//   - No nonce tracking. We send SET_ACTIVITY fire-and-forget; we do
//     not care about the response.

import net from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

// Locate the Discord IPC socket. Discord Desktop opens
// /tmp/discord-ipc-0 (or pipe-equivalent on Windows) on launch.
// Multiple pipe IDs (0-9) are tried in order; older Discord versions
// sometimes pick a higher ID.
function getSocketPaths(pipeId = 0) {
    const tmpDirs = [
        process.env.XDG_RUNTIME_DIR,
        process.env.TMPDIR,
        process.env.TMP,
        process.env.TEMP,
        "/tmp",
    ].filter(Boolean);
    const seen = new Set();
    const out = [];
    // Try the requested pipe ID first, then increment in case Discord
    // is using a higher one. In practice pipe 0 is always correct on
    // a single-Discord install.
    for (const id of [pipeId, pipeId + 1, pipeId + 2]) {
        for (const tmp of tmpDirs) {
            const p = path.join(tmp, `discord-ipc-${id}`);
            if (!seen.has(p)) {
                seen.add(p);
                out.push(p);
            }
        }
    }
    return out;
}

export class DiscordIPC {
    constructor({ clientId, timeoutMs = 30000 } = {}) {
        if (!clientId) throw new Error("clientId required");
        this.clientId = String(clientId);
        this.timeoutMs = timeoutMs;
        this.socket = null;
        this.connected = false;
        this.connecting = false;
        this.lastError = null;
        // Timestamp of the most recent PONG frame Discord sent back.
        // The daemon pings periodically and considers the connection
        // dead if no pong arrives within the expected window. This
        // catches silently-dead sockets where the OS has not yet
        // surfaced close/error (e.g. Discord process killed).
        this.lastPongAt = 0;
        this._disconnectedHandler = null;
    }

    isConnected() {
        return this.connected && this.socket?.writable === true;
    }

    // onDisconnected is called once when the socket dies. The daemon
    // uses this to trigger reconnect with backoff.
    onDisconnected(handler) {
        this._disconnectedHandler = handler;
    }

    async connect() {
        if (this.connected) return;
        if (this.connecting) {
            while (this.connecting) {
                await new Promise((r) => setTimeout(r, 50));
            }
            if (this.connected) return;
        }
        this.connecting = true;
        this.lastError = null;
        try {
            const paths = getSocketPaths();
            let lastErr;
            for (const socketPath of paths) {
                try {
                    if (!existsSync(socketPath)) continue;
                    await this._connectToPath(socketPath);
                    return;
                } catch (e) {
                    lastErr = e;
                }
            }
            throw lastErr ?? new Error("No usable Discord IPC socket path found");
        } finally {
            this.connecting = false;
        }
    }

    _connectToPath(socketPath) {
        return new Promise((resolve, reject) => {
            const socket = net.createConnection(socketPath);
            let buf = Buffer.alloc(0);
            let settled = false;

            const cleanup = () => {
                socket.removeAllListeners();
            };

            const finishOk = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                cleanup();
                // After handshake: we discard incoming data (we are
                // fire-and-forget for SET_ACTIVITY) but watch for
                // socket close/error so the daemon can reconnect.
                socket.on("close", () => {
                    this.connected = false;
                    this.socket = null;
                    if (this._disconnectedHandler) this._disconnectedHandler("socket closed");
                });
                socket.on("error", (e) => {
                    this.connected = false;
                    this.socket = null;
                    if (this._disconnectedHandler) this._disconnectedHandler(`socket error: ${e?.message || e}`);
                });
                // Post-handshake data handler. We mostly discard
                // frames (we are fire-and-forget for SET_ACTIVITY),
                // but we DO track PONG (opcode 4) so the daemon can
                // detect a silently-dead socket (e.g. Discord process
                // killed without the OS surfacing close/error).
                socket.on("data", (chunk) => {
                    let off = 0;
                    while (off + 8 <= chunk.length) {
                        const opcode = chunk.readUInt32LE(off);
                        const length = chunk.readUInt32LE(off + 4);
                        if (off + 8 + length > chunk.length) break;
                        if (opcode === 4) this.lastPongAt = Date.now();
                        off += 8 + length;
                    }
                });
                this.socket = socket;
                this.connected = true;
                resolve();
            };

            const finishErr = (err) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                cleanup();
                try { socket.destroy(); } catch {}
                this.lastError = err;
                reject(err);
            };

            const timer = setTimeout(
                () => finishErr(new Error(`Discord IPC connect timeout after ${this.timeoutMs}ms`)),
                this.timeoutMs,
            );

            socket.once("connect", () => {
                const payload = JSON.stringify({ v: 1, client_id: this.clientId });
                const handshake = Buffer.alloc(8 + payload.length);
                handshake.writeUInt32LE(0, 0);
                handshake.writeUInt32LE(Buffer.byteLength(payload), 4);
                handshake.write(payload, 8);
                socket.write(handshake, (err) => {
                    if (err) finishErr(err);
                });
            });

            socket.on("data", (chunk) => {
                buf = Buffer.concat([buf, chunk]);
                while (buf.length >= 8) {
                    const opcode = buf.readUInt32LE(0);
                    const length = buf.readUInt32LE(4);
                    if (buf.length < 8 + length) return;
                    const dataBuf = buf.subarray(8, 8 + length);
                    buf = buf.subarray(8 + length);

                    if (opcode === 0 || opcode === 1) {
                        let parsed = null;
                        try { parsed = JSON.parse(dataBuf.toString("utf-8")); } catch {}
                        if (parsed && typeof parsed.code === "number" && parsed.message) {
                            finishErr(new Error(`Discord RPC rejected handshake: ${parsed.code} ${parsed.message}`));
                            return;
                        }
                        finishOk();
                        return;
                    }
                }
            });

            socket.once("error", (err) => finishErr(err));
        });
    }

    async setActivity(activity) {
        if (!this.isConnected()) return false;
        const payload = {
            cmd: "SET_ACTIVITY",
            args: {
                pid: process.pid,
                activity: {
                    ...activity,
                    timestamps: { start: activity.start || Date.now() },
                },
            },
            nonce: randomUUID(),
        };
        return this._sendFrame(1, payload);
    }

    async clearActivity() {
        if (!this.isConnected()) return false;
        const payload = {
            cmd: "SET_ACTIVITY",
            args: { pid: process.pid },
            nonce: randomUUID(),
        };
        return this._sendFrame(1, payload);
    }

    _sendFrame(opcode, data) {
        return new Promise((resolve) => {
            if (!this.socket?.writable) {
                resolve(false);
                return;
            }
            const payload = JSON.stringify(data);
            const buf = Buffer.alloc(8 + Buffer.byteLength(payload));
            buf.writeUInt32LE(opcode, 0);
            buf.writeUInt32LE(Buffer.byteLength(payload), 4);
            buf.write(payload, 8);
            try {
                this.socket.write(buf, (err) => {
                    if (err) {
                        // Write failed -- the socket is dead. Treat
                        // this the same as a 'close' event so the
                        // daemon reconnects. Without this, writes to
                        // a dead socket silently buffer in the OS and
                        // we never know Discord stopped receiving.
                        this._markDisconnected(`write error: ${err?.message || err}`);
                        resolve(false);
                        return;
                    }
                    resolve(true);
                });
            } catch (e) {
                this._markDisconnected(`write threw: ${e?.message || e}`);
                resolve(false);
            }
        });
    }

    // Send a PING frame (opcode 3) with no payload. Discord replies
    // with a PONG (opcode 4) on the same socket. We track the most
    // recent pong timestamp; if it goes stale the connection is
    // considered dead and we trigger the disconnected handler.
    ping() {
        return this._sendFrame(3, {});
    }

    // Returns true if we have heard a pong from Discord within
    // `maxAgeMs`. Used by the daemon to detect silently-dead
    // connections that the OS has not surfaced yet (e.g. Discord
    // process was killed and the socket fd is still writable from
    // our side but no data flows back).
    isHealthy(maxAgeMs = 30000) {
        if (!this.connected) return false;
        return Date.now() - (this.lastPongAt || 0) < maxAgeMs;
    }

    async disconnect() {
        if (this.socket) {
            try {
                const closeBuf = Buffer.alloc(8);
                closeBuf.writeUInt32LE(2, 0);
                closeBuf.writeUInt32LE(0, 4);
                this.socket.write(closeBuf);
            } catch {}
            try { this.socket.end(); } catch {}
            try { this.socket.destroy(); } catch {}
            this.socket = null;
        }
        this.connected = false;
    }
}

export default DiscordIPC;
