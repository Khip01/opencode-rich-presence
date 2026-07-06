#!/usr/bin/env node
// Discord RPC daemon.
//
// Phase 2 of the v3 redesign. Holds a single Discord IPC connection
// for the whole machine. All OpenCode plugin instances connect to this
// daemon via local socket, send their session state, and the daemon
// renders + pushes to Discord. When the last OpenCode instance
// disposes, the daemon clears presence and exits.
//
// Why a daemon (not per-session worker like v2.x):
//   - Discord IPC allows only one connection per App ID. Per-session
//     workers force a reconnect on every leadership handoff (1-3s of
//     "display gone"). The daemon keeps one connection forever and
//     pushes state updates in place via SET_ACTIVITY.
//   - The user does not have to manually restart anything when
//     switching OpenCode windows; the same Discord connection just
//     keeps showing the most-recently-active session.
//
// Lifecycle:
//   - Spawned by the first OpenCode plugin instance that fires a
//     chat.message event (the user picked this trigger; spawning on
//     OpenCode launch would over-eagerly start Discord when most
//     launches don't need it).
//   - Listens on ~/.config/opencode/.opencode-rich-presence.sock
//     (Unix domain socket on Linux/macOS).
//   - Connects to Discord IPC at startup. Reconnects with backoff if
//     the Discord side drops the socket mid-session.
//   - Tracks connected plugin instances by PID. Receives state from
//     each. Picks the global most-recently-active session across all
//     instances for display.
//   - Exits when the last instance sends "goodbye" (clears Discord
//     presence first so Discord does not show stale activity).
//
// IPC protocol (newline-delimited JSON over the local socket):
//   Plugin -> Daemon:
//     {"type": "hello", "pid": 12345}
//         Register a new OpenCode instance.
//     {"type": "state", "pid": 12345, "session": {...}, "config": {...}}
//         Update this instance's session state. The daemon picks the
//         global most-recently-active session across all instances.
//     {"type": "goodbye", "pid": 12345}
//         Unregister. Daemon may exit if this was the last instance.
//   Daemon -> Plugin:
//     {"type": "ack"}
//         Acknowledgement (always sent in response to client messages).
//     {"type": "discord-state", "connected": true|false, "error": "..."}
//         Status of the Discord IPC connection. Sent on change.
//     {"type": "log", "level": "info|warn|error", "msg": "..."}
//         Daemon log lines for the plugin to forward to the user's
//         activity log.
//
// Discord-side behavior:
//   - SET_ACTIVITY is fire-and-forget. The daemon does not wait for
//     the response; missing one update is harmless (the next state
//     change will land).
//   - Throttled to at most one SET_ACTIVITY per DISCORD_PUSH_INTERVAL_MS
//     to respect Discord's 5-updates-per-20-seconds rate limit.
//   - Reconnect to Discord only on socket death. Backoff: 5s -> 30s cap.

import net from "node:net";
import { unlinkSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { appendFileSync } from "node:fs";
import {
    DAEMON_SOCKET,
    DAEMON_PID_FILE,
    OPENCODE_DIR,
    CONFIG_PATH,
    DEBUG_LOG,
    ACTIVITY_LOG,
} from "../shared/paths.js";
import { DiscordIPC } from "./discord-ipc.mjs";

const CONNECT_TIMEOUT_MS = 30000;
// Initial backoff after Discord IPC socket death. Grows exponentially
// up to MAX_RECONNECT_BACKOFF_MS. Discord silently blocks new
// connections from the same App ID after rapid disconnect/reconnect
// cycles, so we wait a while between attempts.
const INITIAL_RECONNECT_BACKOFF_MS = 5000;
const MAX_RECONNECT_BACKOFF_MS = 30000;
// Minimum interval between SET_ACTIVITY pushes. Discord limits to 5
// updates per 20 seconds; we throttle to once per 4s to stay safely
// under that.
const DISCORD_PUSH_INTERVAL_MS = 4000;
// The daemon stays alive indefinitely after the last client
// disconnects. It only exits when explicitly signaled (SIGINT/SIGTERM,
// sent by `opencode-rpc restart` or a manual kill). The rationale:
// every daemon exit requires a Discord reconnect, which can hit
// Discord's App-ID cooldown window. If the cooldown blocks the next
// push, the user's display stays blank until they run
// `opencode-rpc restart` again. Keeping the daemon alive avoids the
// reconnect entirely; new OpenCode instances connect to the existing
// daemon and reuse its Discord connection. When the last instance
// disconnects, the daemon sends clearActivity so Discord hides the
// stale presence; when a new instance fires, the daemon immediately
// pushes the new state without needing to re-handshake with Discord.
// Resource cost: ~30MB RAM, ~0% CPU when idle.

// ─── State ────────────────────────────────────────────────────────────────

let appId = null;
let discordClient = null;
let discordConnected = false;
let lastPushAt = 0;
let reconnectBackoffMs = INITIAL_RECONNECT_BACKOFF_MS;
let reconnectTimer = null;
let disposed = false;
// Pending delayed push to guarantee the final state lands on Discord
// even when rapid state changes (e.g. fast AI responses) hit the
// throttle window. Set when a push is throttled, fired after the
// throttle expires, and re-armed if a newer state arrives before it
// fires (we always push the LATEST state, not a stale intermediate).
let finalStateTimer = null;
// Hash of the payload currently displayed on Discord, used to decide
// whether the throttled delayed push would actually change anything.
// Without this, a delayed push could repeat the same Typing payload
// many times even after the user has fired another message.
let lastPushedFingerprint = null;

// Map of pid -> { lastSeen, sessionInfo, rendered }
// sessionInfo is the minimal {sessionID, state, lastActivity} the
// plugin sends. rendered is the pre-rendered presence payload the
// plugin sent. The daemon picks the global most-recently-active.
const instances = new Map();
// The instance whose rendered payload is currently on Discord.
let displayedPid = null;

// ─── Logging ──────────────────────────────────────────────────────────────

function logToFile(...args) {
    const line = `[daemon ${process.pid}] ${args.join(" ")}`;
    try { appendFileSync(DEBUG_LOG, line + "\n"); } catch {}
    try { appendFileSync(ACTIVITY_LOG, `[${new Date().toISOString().replace("T", " ").replace("Z", "")}] [pid ${process.pid}] [daemon] ${args.join(" ")}\n`); } catch {}
    try { process.stderr.write(line + "\n"); } catch {}
}

// ─── Discord lifecycle ────────────────────────────────────────────────────

async function loadAppId() {
    if (process.env.DISCORD_APP_ID) return process.env.DISCORD_APP_ID;
    if (!existsSync(CONFIG_PATH)) {
        throw new Error(`No Discord App ID. Set DISCORD_APP_ID or create ${CONFIG_PATH}`);
    }
    try {
        const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
        if (cfg.discordAppId) return cfg.discordAppId;
    } catch (e) {
        throw new Error(`Could not parse ${CONFIG_PATH}: ${e?.message || e}`);
    }
    throw new Error(`No discordAppId in ${CONFIG_PATH}`);
}

async function connectDiscord() {
    if (disposed) return;
    if (discordConnected) return;
    try {
        if (!appId) appId = await loadAppId();
        if (!discordClient) {
            discordClient = new DiscordIPC({ clientId: appId, timeoutMs: CONNECT_TIMEOUT_MS });
            discordClient.onDisconnected((reason) => {
                logToFile(`Discord IPC disconnected: ${reason}`);
                discordConnected = false;
                broadcastDiscordState();
                scheduleReconnect();
            });
        }
        await discordClient.connect();
        discordConnected = true;
        reconnectBackoffMs = INITIAL_RECONNECT_BACKOFF_MS;
        logToFile(`Discord connected (appId=${appId})`);
        broadcastDiscordState();
        // Push current state immediately after reconnect.
        pushCurrentPresence();
    } catch (e) {
        logToFile(`Discord connect failed: ${e?.message || e}`);
        discordConnected = false;
        broadcastDiscordState();
        scheduleReconnect();
    }
}

// Note: a previous version of this daemon ran a periodic PING-based
// health check that triggered reconnect after 30s without a PONG.
// That turned out to be too aggressive: Discord does not reliably
// reply to PING (or the reply is dropped at the OS layer), so the
// daemon was reconnecting every ~20-30s and clearing the display each
// time. We now trust write errors on the IPC socket to surface a
// real disconnect (the _sendFrame write callback invokes
// _markDisconnected, which calls our disconnected handler). The
// remaining risk: a "silently-dead" socket where writes buffer
// forever. In practice Discord does surface close/error quickly when
// the IPC socket dies, and the write-error fallback covers the rest.

function scheduleReconnect() {
    if (reconnectTimer || disposed) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectDiscord();
    }, reconnectBackoffMs);
    if (reconnectTimer.unref) reconnectTimer.unref();
    // Grow backoff for next time, capped.
    reconnectBackoffMs = Math.min(MAX_RECONNECT_BACKOFF_MS, Math.floor(reconnectBackoffMs * 1.5));
    logToFile(`Reconnect in ${reconnectBackoffMs}ms`);
}

async function disconnectDiscord() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (discordClient) {
        try { await discordClient.disconnect(); } catch {}
    }
    discordConnected = false;
}

// ─── State selection + push ───────────────────────────────────────────────

// Pick the global most-recently-active instance. "Active" = the
// instance's session state !== "Waiting for command". If no active
// instance exists, fall back to the most-recently-updated instance
// overall (idle display).
function pickDisplayedInstance() {
    let bestActive = null;
    let bestActiveActivity = -Infinity;
    let bestAny = null;
    let bestAnyActivity = -Infinity;
    for (const [pid, inst] of instances.entries()) {
        if (!inst.sessionInfo) continue;
        const activity = inst.sessionInfo.lastActivity || 0;
        const isActive = inst.sessionInfo.state && inst.sessionInfo.state !== "Waiting for command";
        if (isActive && activity > bestActiveActivity) {
            bestActiveActivity = activity;
            bestActive = pid;
        }
        if (activity > bestAnyActivity) {
            bestAnyActivity = activity;
            bestAny = pid;
        }
    }
    return { active: bestActive, any: bestAny };
}

// Compute a stable fingerprint for the rendered payload. Used to
// decide whether a delayed push would actually change what Discord
// shows. We compare by details + state text (the user-visible
// fields); largeImage/smallImage changes alone are not interesting.
function fingerprintRendered(r) {
    if (!r) return null;
    return `${r.details || ""}||${r.state || ""}`;
}

async function pushCurrentPresence() {
    if (!discordConnected || !discordClient) return;

    const picked = pickDisplayedInstance();
    const chosenPid = picked.active || picked.any;
    if (!chosenPid) return;
    const inst = instances.get(chosenPid);
    if (!inst || !inst.rendered) return;

    const sid = inst.sessionInfo?.sessionID ? inst.sessionInfo.sessionID.slice(-8) : "?";

    // Compute the fingerprint of what we WOULD push now. If it
    // matches what is already on Discord, skip entirely (no point
    // pushing the same text again even when the throttle has
    // expired).
    const fp = fingerprintRendered(inst.rendered);
    if (fp && fp === lastPushedFingerprint) return;

    // Reset the throttle when the displayed instance changes (user
    // switched terminals, or initial display). The 4s throttle is to
    // prevent flooding when a single instance fires many events in
    // quick succession; it should NOT delay a legitimate switch.
    if (chosenPid !== displayedPid) {
        lastPushAt = 0;
    }
    const now = Date.now();
    if (now - lastPushAt < DISCORD_PUSH_INTERVAL_MS) {
        // Throttled. Schedule a delayed push for the LATEST state
        // (we re-arm the timer so a stale intermediate never lands).
        // Without this, a fast AI response leaves Discord stuck on
        // Typing because the WAITING push never lands within the
        // 4s throttle window.
        scheduleFinalStatePush();
        return;
    }
    lastPushAt = now;

    logToFile(
        `push pid=${chosenPid} sid=${sid} ` +
        `details="${inst.rendered.details || ""}" ` +
        `state="${inst.rendered.state || ""}"`,
    );

    try {
        await discordClient.setActivity(inst.rendered);
        displayedPid = chosenPid;
        lastPushedFingerprint = fp;
        // A successful push satisfies any pending delayed push.
        if (finalStateTimer) {
            clearTimeout(finalStateTimer);
            finalStateTimer = null;
        }
    } catch (e) {
        logToFile(`setActivity failed: ${e?.message || e}`);
    }
}

// Schedule a delayed push that fires after the throttle window
// expires. The push will run pushCurrentPresence again, which will
// re-evaluate the latest state. If the state has not changed in the
// meantime (fingerprint matches lastPushedFingerprint), the push is
// skipped. If the displayed instance changed, the throttle is reset
// and the push fires immediately.
function scheduleFinalStatePush() {
    if (finalStateTimer) clearTimeout(finalStateTimer);
    const wait = DISCORD_PUSH_INTERVAL_MS - (Date.now() - lastPushAt);
    finalStateTimer = setTimeout(() => {
        finalStateTimer = null;
        pushCurrentPresence();
    }, Math.max(50, wait));
    if (finalStateTimer.unref) finalStateTimer.unref();
}

async function clearPresence() {
    if (!discordConnected || !discordClient) return;
    try {
        await discordClient.clearActivity();
        logToFile("clearActivity sent");
    } catch (e) {
        logToFile(`clearActivity failed: ${e?.message || e}`);
    }
}

// ─── Local socket server ──────────────────────────────────────────────────

let server = null;
const clients = new Map(); // pid -> socket

function broadcast(msg) {
    const line = JSON.stringify(msg) + "\n";
    for (const sock of clients.values()) {
        try { sock.write(line); } catch {}
    }
}

function broadcastDiscordState() {
    broadcast({ type: "discord-state", connected: discordConnected });
}

function handleClientMessage(msg, sock) {
    if (!msg || typeof msg !== "object") return;
    const pid = msg.pid;

    switch (msg.type) {
        case "hello":
            clients.set(pid, sock);
            instances.set(pid, { lastSeen: Date.now(), sessionInfo: null, rendered: null });
            // The daemon stays alive across all-exit, so a new
            // instance connecting here just resumes on the existing
            // Discord connection. No exit-cancel needed (the daemon
            // does not auto-exit anymore).
            logToFile(`instance registered: pid=${pid}`);
            try { sock.write(JSON.stringify({ type: "ack" }) + "\n"); } catch {}
            broadcastDiscordState();
            // Force a refresh cycle on Discord: send clearActivity to
            // wipe any stale display, then push whatever state the
            // instance sends. This handles the case where Discord has
            // silently stopped displaying the previous activity
            // (e.g. due to rate-limit cooldown or App-ID side
            // throttling) and a plain SET_ACTIVITY on the same
            // connection would also be ignored.
            if (discordConnected && discordClient) {
                logToFile(`refresh: clearActivity to reset Discord display`);
                clearPresence().then(() => {
                    // Reset fingerprint so the next setActivity from
                    // this new instance actually fires (it would be
                    // skipped otherwise because we just sent the same
                    // payload implicitly via clearActivity).
                    lastPushedFingerprint = null;
                });
            }
            break;

        case "state": {
            const inst = instances.get(pid);
            if (!inst) {
                logToFile(`state from unknown pid ${pid}, dropping`);
                return;
            }
            inst.lastSeen = Date.now();
            inst.sessionInfo = msg.session || inst.sessionInfo;
            inst.rendered = msg.rendered || inst.rendered;
            // Re-push if the picked session might have changed. Throttling
            // inside pushCurrentPresence prevents flooding.
            pushCurrentPresence();
            try { sock.write(JSON.stringify({ type: "ack" }) + "\n"); } catch {}
            break;
        }

        case "goodbye":
            logToFile(`instance goodbye: pid=${pid}`);
            instances.delete(pid);
            clients.delete(pid);
            try { sock.end(); } catch {}
            // If this was the instance whose payload is currently
            // on Discord, reset the fingerprint so the next push
            // (for whichever instance takes over) is not skipped as
            // a duplicate.
            if (displayedPid === pid) {
                displayedPid = null;
                lastPushedFingerprint = null;
            }
            pushCurrentPresence(); // re-pick global active session
            if (instances.size === 0) {
                // Last instance just disconnected. Hide the display
                // (clearActivity) so Discord does not show a stale
                // presence while we wait for a new instance. The
                // daemon itself STAYS ALIVE so a subsequent OpenCode
                // launch does not require a Discord reconnect (which
                // can hit Discord's App-ID cooldown window). The next
                // instance's hello + state immediately resumes pushing
                // on the existing Discord connection.
                logToFile("all instances disconnected; clearing Discord presence (daemon stays alive)");
                clearPresence();
            }
            break;

        default:
            logToFile(`unknown message type: ${msg.type}`);
    }
}

// scheduleExit was removed: the daemon now stays alive after the
// last client disconnects. See EXIT_GRACE_MS comment above for
// rationale. If you ever want the old behavior back, reintroduce
// this function and call it from the goodbye handler when
// instances.size === 0.

async function startServer() {
    if (existsSync(DAEMON_SOCKET)) {
        // Stale socket from a previous crash. Remove it.
        try { unlinkSync(DAEMON_SOCKET); } catch {}
    }
    server = net.createServer((sock) => {
        let buf = "";
        sock.setEncoding("utf-8");
        sock.on("data", (chunk) => {
            buf += chunk;
            let idx;
            while ((idx = buf.indexOf("\n")) !== -1) {
                const line = buf.slice(0, idx);
                buf = buf.slice(idx + 1);
                if (!line.trim()) continue;
                try {
                    const msg = JSON.parse(line);
                    handleClientMessage(msg, sock);
                } catch (e) {
                    logToFile(`parse error: ${e?.message || e}`);
                }
            }
        });
        sock.on("close", () => {
            // Find the pid this socket belonged to and remove it.
            // Note: we do NOT call scheduleExit here. The daemon stays
            // alive after the last client disconnects so a subsequent
            // OpenCode launch can reuse the existing Discord
            // connection. scheduleExit was removed in this commit;
            // see the EXIT_GRACE_MS comment for rationale.
            for (const [pid, s] of clients.entries()) {
                if (s === sock) {
                    clients.delete(pid);
                    instances.delete(pid);
                    logToFile(`client disconnected: pid=${pid}`);
                    break;
                }
            }
        });
        sock.on("error", (e) => {
            logToFile(`client socket error: ${e?.message || e}`);
        });
    });
    try {
        await new Promise((resolve, reject) => {
            const onError = (err) => {
                server.removeListener("listening", onListening);
                reject(err);
            };
            const onListening = () => {
                server.removeListener("error", onError);
                resolve();
            };
            server.once("error", onError);
            server.once("listening", onListening);
            try {
                server.listen(DAEMON_SOCKET);
            } catch (e) {
                server.removeListener("error", onError);
                server.removeListener("listening", onListening);
                reject(e);
            }
        });
        logToFile(`listening on ${DAEMON_SOCKET}`);
    } catch (e) {
        // EADDRINUSE means another daemon got here first. That is the
        // desired outcome for the second of two concurrent spawns;
        // exit cleanly so the plugin can connect to the existing one.
        if (e?.code === "EADDRINUSE") {
            logToFile(`socket in use, another daemon is already running; exiting`);
            // Clean up our PID file; the existing daemon owns it.
            try { unlinkSync(DAEMON_PID_FILE); } catch {}
            process.exit(0);
        }
        throw e;
    }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────

async function shutdown() {
    if (disposed) return;
    disposed = true;
    logToFile("shutting down");
    if (finalStateTimer) { clearTimeout(finalStateTimer); finalStateTimer = null; }
    if (instances.size === 0) {
        await clearPresence();
    }
    await disconnectDiscord();
    if (server) {
        for (const sock of clients.values()) {
            try { sock.end(); } catch {}
        }
        await new Promise((r) => server.close(() => r()));
    }
    try { unlinkSync(DAEMON_SOCKET); } catch {}
    try { unlinkSync(DAEMON_PID_FILE); } catch {}
    process.exit(0);
}

process.on("SIGINT", () => { logToFile("SIGINT"); shutdown(); });
process.on("SIGTERM", () => { logToFile("SIGTERM"); shutdown(); });

async function main() {
    try { await mkdirOpencodeDir(); } catch {}
    logToFile(`daemon starting (pid ${process.pid})`);
    writeFileSync(DAEMON_PID_FILE, String(process.pid));
    await startServer();
    await connectDiscord();
}

async function mkdirOpencodeDir() {
    const { mkdir } = await import("node:fs/promises");
    try { await mkdir(OPENCODE_DIR, { recursive: true }); } catch {}
}

main().catch((e) => {
    logToFile(`fatal: ${e?.message || e}`);
    process.exit(1);
});
