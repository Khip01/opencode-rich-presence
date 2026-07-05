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
// - Handshake recv: in practice, Discord sends DISPATCH READY as a FRAME
//   (opcode 1) with payload `{cmd: "DISPATCH", evt: "READY", data: {...}}`.
//   Some docs describe opcode 0 for the READY reply but real Discord
//   does not send that; it sends the READY event as a normal frame.
//   pypresence, @xhayper/discord-rpc, and jagrosh/DiscordIPC all wait
//   for opcode 1 (FRAME), not opcode 0. We do the same.
// - RPC command: `{cmd, args, nonce}` (opcode 1)
// - RPC response: `{cmd, data|error, nonce}` (opcode 1)
// - Error reply: `{code: <int>, message: <string>}` (opcode 1)
//
// This implementation is fire-and-forget for SET_ACTIVITY (we do not wait for
// the response). For our use case (push presence, not interact), we only
// care that the connection is alive and the frame was sent.

import net from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { EventEmitter } from "node:events";

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

export class DiscordIPC extends EventEmitter {
    constructor({ clientId, timeoutMs = 30000 } = {}) {
        super();
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

    // Mark the current connection as dead and notify any listeners. Called
    // when the socket closes/errors OR when a write fails (proactive cleanup
    // so subsequent isConnected() checks return false even before the OS
    // close event fires). After this returns, the worker should call
    // disconnect() + connect() to re-establish.
    _markDisconnected(reason) {
        if (!this.connected && !this.socket) return;
        this.connected = false;
        const sock = this.socket;
        this.socket = null;
        if (sock) {
            try { sock.removeAllListeners(); } catch {}
            try { sock.destroy(); } catch {}
        }
        if (reason) this.lastError = reason;
        try { this.emit("disconnected", reason); } catch {}
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
                // v2.1.2: hook socket close/error and emit 'disconnected'
                // so the worker can schedule a reconnect. Previously we
                // just nulled local state on close, but the worker did
                // not know the socket died and kept trying setActivity on
                // a dead pipe, with each call silently failing until the
                // parent's periodic retry happened to land on a clean
                // window. Emitting the event lets the worker's existing
                // `client.on("disconnected", ...)` handler trigger an
                // immediate reconnect via scheduleReconnect.
                socket.on("close", () => {
                    this._markDisconnected("socket closed");
                });
                socket.on("error", (err) => {
                    this._markDisconnected(`socket error: ${err?.message || err}`);
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

                    // Discord sends DISPATCH READY as a regular FRAME
                    // (opcode 1) after our HANDSHAKE. Some docs describe
                    // opcode 0 for the READY reply, but real Discord
                    // does not send opcode 0; it sends the READY event
                    // as opcode 1. pypresence and @xhayper both wait for
                    // opcode 1 here. We accept either 0 or 1 to be
                    // defensive against future Discord behavior changes.
                    if (opcode === 0 || opcode === 1) {
                        let parsed = null;
                        try { parsed = JSON.parse(dataBuf.toString("utf-8")); } catch {}
                        // Discord returns errors as `{code, message}`.
                        // Surface those distinctly from a silent timeout so
                        // the user can tell "App ID rejected" from
                        // "Discord not responding".
                        if (parsed && typeof parsed.code === "number" && parsed.message) {
                            finishErr(new Error(`Discord RPC rejected handshake: ${parsed.code} ${parsed.message}`));
                            return;
                        }
                        finishOk();
                        return;
                    }
                    // For opcodes 3/4 (PING/PONG) we ignore during
                    // handshake. Continue parsing.
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
            // v2.1.2: if the socket is null (we disconnected via close/error)
            // or no longer writable, fail fast. The previous code only
            // checked writable and returned false silently, leaving the
            // worker retrying without ever triggering a reconnect.
            if (!this.socket || this.socket.destroyed) {
                resolve(false);
                return;
            }
            const socket = this.socket;
            const payload = JSON.stringify(data);
            const buf = Buffer.alloc(8 + Buffer.byteLength(payload));
            buf.writeUInt32LE(opcode, 0);
            buf.writeUInt32LE(Buffer.byteLength(payload), 4);
            buf.write(payload, 8);
            try {
                socket.write(buf, (err) => {
                    if (err) {
                        // Write failed (typically EPIPE because Discord
                        // closed the connection). Mark the socket as dead
                        // and emit 'disconnected' so the worker reconnects
                        // immediately, instead of retrying against a dead
                        // pipe for the next 2.5s+ parent-retry interval.
                        this._markDisconnected(`write error: ${err?.message || err}`);
                        resolve(false);
                        return;
                    }
                    if (!socket.writable) {
                        // Write was queued but socket is not writable. Mark
                        // dead so the worker reconnects (a stuck not-
                        // writable socket will never drain).
                        this._markDisconnected("socket not writable after write");
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
        try { this.emit("disconnected", "manual disconnect"); } catch {}
    }
}

export default DiscordIPC;
