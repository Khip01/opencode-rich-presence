// Minimal Discord IPC client.
//
// Replaces @xhayper/discord-rpc to avoid its hardcoded 10-second IPC handshake
// timeout (Client.connect() in @xhayper sets `setTimeout(..., 10e3)` with no
// way to override). On slow networks or when Discord's IPC server is busy,
// the 10s timeout fires before the handshake READY frame is processed, even
// though the IPC socket responded in milliseconds. We saw this in the user's
// setup: Discord IPC responds in <10ms but @xhayper rejects at exactly
// 10006ms with "Connection timed out".
//
// Discord IPC protocol (from discord.com/developers/docs/topics/rpc):
// - Each frame: [opcode: u32 LE][length: u32 LE][data: utf-8 JSON]
// - Opcodes: 0 = HANDSHAKE, 1 = FRAME, 2 = CLOSE, 3 = PING, 4 = PONG
// - Handshake send: `{v: 1, client_id: "..."}` (opcode 0)
// - Handshake recv: READY frame (opcode 0) with `{v: 1, config, user}` payload
// - RPC command: `{cmd, args, nonce}` (opcode 1)
// - RPC response: `{cmd, data|error, nonce}` (opcode 1)
//
// This implementation is fire-and-forget for SET_ACTIVITY (we do not wait for
// the response). For our use case (push presence, not interact), we only
// care that the connection is alive and the frame was sent.

import net from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

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
    for (const tmp of tmpDirs) {
        const p = path.join(tmp, `discord-ipc-${pipeId}`);
        if (!seen.has(p)) {
            seen.add(p);
            out.push(p);
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
    }

    isConnected() {
        return this.connected && this.socket?.writable === true;
    }

    async connect() {
        if (this.connected) return;
        if (this.connecting) {
            // Wait for the in-flight connect to settle.
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
                // Setup ongoing handlers. We ignore incoming data after
                // handshake (we are fire-and-forget), but watch for close/error.
                socket.on("close", () => {
                    this.connected = false;
                    this.socket = null;
                });
                socket.on("error", () => {
                    this.connected = false;
                    this.socket = null;
                });
                socket.on("data", () => {
                    // discard: we do not parse RPC responses
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
                    if (opcode === 0) {
                        // READY frame. Payload is informational; we just
                        // care that handshake completed.
                        finishOk();
                        return;
                    }
                    // For opcodes 1/3/4 (FRAME/PING/PONG), we do not care
                    // during handshake. Continue parsing.
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
                    timestamps: { start: Date.now() },
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
                        this.lastError = err.message;
                        resolve(false);
                    } else {
                        resolve(true);
                    }
                });
            } catch (e) {
                this.lastError = e.message;
                resolve(false);
            }
        });
    }

    async disconnect() {
        if (this.socket) {
            try {
                const closeBuf = Buffer.alloc(8);
                closeBuf.writeUInt32LE(2, 0);
                closeBuf.writeUInt32LE(0, 4);
                this.socket.write(closeBuf);
            } catch {}
            try {
                this.socket.end();
            } catch {}
            try {
                this.socket.destroy();
            } catch {}
            this.socket = null;
        }
        this.connected = false;
    }
}

export default DiscordIPC;
