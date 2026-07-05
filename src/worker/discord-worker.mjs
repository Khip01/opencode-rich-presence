#!/usr/bin/env node
// Discord RPC worker - uses our minimal DiscordIPC client (replaced
// @xhayper/discord-rpc to avoid its 10s hardcoded IPC handshake timeout).
// Runs as Node.js subprocess so Bun's Unix socket issues are bypassed.
// Cross-platform: DiscordIPC handles Unix sockets (Linux/macOS) and named
// pipes (Windows).

import { DiscordIPC } from "./discord-ipc.mjs";
import { readFile } from "node:fs/promises";
import { CONFIG_PATH } from "../shared/paths.js";

const CONNECT_TIMEOUT = 30000;
const MAX_RETRIES = 100;
// v2.0.8-rc2: reduced initial and max backoff so the new leader's worker
// reconnects faster after a handoff. Previous values (3000ms initial,
// 30000ms max) made the user wait several seconds per leadership change.
const INITIAL_RETRY_MS = 500;
const MAX_RETRY_MS = 5000;

let appId = null;
let client = null;
let connected = false;
let retryCount = 0;
let reconnectTimer = null;
let disposed = false;
// Set by gracefulExit() and the shutdown command so that the
// `disconnected` event (which fires after clearActivity) does not trigger
// scheduleReconnect() and keep the worker alive past the point where we want
// to exit.
let shuttingDown = false;
let pushDebounceTimer = null;
let pendingActivity = null;

function send(msg) {
    try {
        if (!process.stdout.writable || process.stdout.destroyed) return;
        process.stdout.write(JSON.stringify(msg) + "\n");
    } catch {}
}

process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

function log(...args) {
    send({ type: "log", level: "info", msg: args.join(" ") });
}

async function loadAppId() {
    if (process.env.DISCORD_APP_ID) return process.env.DISCORD_APP_ID;

    try {
        const raw = await readFile(CONFIG_PATH, "utf-8");
        const cfg = JSON.parse(raw);
        if (cfg.discordAppId) return cfg.discordAppId;
    } catch (err) {
        log(`Could not read config file ${CONFIG_PATH}: ${err?.message || err}`);
    }

    const msg = `No Discord App ID found. Set DISCORD_APP_ID env var or add discordAppId to ${CONFIG_PATH}`;
    log(msg);
    send({ type: "error", error: msg });
    throw new Error(msg);
}

// Bound a Discord IPC call so a slow / hung Discord side cannot keep the
// worker alive past the parent's grace window. Returns the wrapped
// promise's resolved value, or "timeout" if it does not settle in `ms`.
function withTimeout(promise, ms, label) {
    return Promise.race([
        promise.then((v) => ({ ok: true, value: v })).catch((e) => ({ ok: false, error: e })),
        new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: new Error(`${label || "operation"} timed out after ${ms}ms`) }), ms)),
    ]);
}

function scheduleReconnect() {
    if (reconnectTimer || disposed) return;
    if (retryCount >= MAX_RETRIES) {
        send({ type: "error", error: `Max retries (${MAX_RETRIES}) reached` });
        return;
    }
    retryCount++;
    // Exponential backoff capped at MAX_RETRY_MS. Starts fast (INITIAL_RETRY_MS)
    // so handoff reconnects feel snappy, then slows down if Discord is genuinely
    // unreachable so we do not hammer it.
    const backoff = Math.min(MAX_RETRY_MS, INITIAL_RETRY_MS * Math.pow(1.5, Math.min(retryCount - 1, 8)));
    send({ type: "attempt", retryCount, maxRetries: MAX_RETRIES, backoffMs: backoff });
    log(`Reconnect in ${backoff}ms (${retryCount}/${MAX_RETRIES})`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!disposed) connect();
    }, backoff);
    if (reconnectTimer.unref) reconnectTimer.unref();
}

async function connect() {
    if (disposed || connected) return;
    send({ type: "connecting", retryCount });

    if (!appId) {
        try {
            appId = await loadAppId();
            log(`Using App ID: ${appId}`);
        } catch (err) {
            scheduleReconnect();
            return;
        }
    }

    try {
        if (client) {
            try { await client.disconnect(); } catch {}
        }
        client = new DiscordIPC({ clientId: appId, timeoutMs: CONNECT_TIMEOUT });
        await client.connect();
        connected = true;
        retryCount = 0;
        log("Discord connected");
        send({ type: "connected" });
        if (pendingActivity) {
            // v2.1.2: eager clear-then-set on reconnect. When the
            // previous leader's worker died without successfully
            // completing clearActivity (race between clearActivity and
            // SIGKILL), Discord keeps showing the stale activity.
            // Sending a fresh clearActivity from the new connection
            // before our setActivity wipes whatever Discord retained.
            try { await client.clearActivity(); } catch (e) {
                log("Eager clearActivity failed:", e?.message || e);
            }
            const ok = await client.setActivity(pendingActivity);
            if (ok) log("Activity sent (replay)");
            else log("Activity replay failed");
        }
    } catch (err) {
        const msg = err?.message || String(err);
        log("Login failed:", msg);
        send({ type: "error", error: msg });
        client = null;
        scheduleReconnect();
    }
}

// v2.1.2: internal retry for setActivity. The first setActivity right
// after connect can fail with a socket-write error because the socket
// is "open" but not yet fully ready for write (Node.js race after
// handshake). Previously we logged "setActivity failed" and relied
// on the parent's 2.5s periodic retry to retry from the outside.
// That worked for steady state but the 2.5s gap left the display
// stale for several seconds after every connect/handoff. Now we
// retry inside the worker with a short backoff so the first
// successful push lands within ~1-2s of connect instead of ~2.5s.
function pushActivityWithRetry(activity, attempt = 0) {
    if (!connected || !client) return;
    client.setActivity(activity).then((ok) => {
        if (ok) {
            log("Activity sent");
            return;
        }
        if (attempt >= 5) {
            log(`setActivity failed after ${attempt + 1} attempts`);
            return;
        }
        const delay = [100, 250, 500, 1000, 2000][attempt] || 2000;
        log(`setActivity failed, retry in ${delay}ms (attempt ${attempt + 1})`);
        setTimeout(() => {
            if (connected && pendingActivity) {
                pushActivityWithRetry(pendingActivity, attempt + 1);
            }
        }, delay).unref?.();
    }).catch((err) => {
        log("setActivity threw:", err?.message || err);
    });
}

function pushActivity(activity) {
    pendingActivity = activity;
    if (!connected || !client) return;
    if (pushDebounceTimer) return;
    pushDebounceTimer = setTimeout(() => {
        pushDebounceTimer = null;
        if (connected && pendingActivity && client) {
            pushActivityWithRetry(pendingActivity);
        }
    }, 100);
    if (pushDebounceTimer.unref) pushDebounceTimer.unref();
}

async function clearActivity() {
    pendingActivity = null;
    if (pushDebounceTimer) {
        clearTimeout(pushDebounceTimer);
        pushDebounceTimer = null;
    }
    if (connected && client) {
        try {
            await client.clearActivity();
        } catch (err) {
            log("clearActivity failed:", err?.message || err);
        }
    }
}

process.stdin.setEncoding("utf-8");
let inputBuf = "";
process.stdin.on("data", (chunk) => {
    inputBuf += chunk;
    let idx;
    while ((idx = inputBuf.indexOf("\n")) !== -1) {
        const line = inputBuf.slice(0, idx);
        inputBuf = inputBuf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
            const msg = JSON.parse(line);
            handleCommand(msg);
        } catch (err) {
            send({ type: "error", error: `Parse: ${err?.message || err}` });
        }
    }
});
process.stdin.on("error", () => {});

async function handleCommand(msg) {
    const { cmd, activity } = msg;
    if (cmd === "connect") {
        if (retryCount >= MAX_RETRIES) retryCount = 0;
        connect();
    } else if (cmd === "setActivity") {
        pushActivity(activity);
    } else if (cmd === "clearActivity") {
        await clearActivity();
    } else if (cmd === "ping") {
        send({ type: "pong", connected, retryCount });
    } else if (cmd === "shutdown") {
        log("Shutdown requested");
        shuttingDown = true;
        // v2.1.2: kill switch. Guarantees the worker exits within 2s even
        // if clearActivity and client.destroy both hang. Without this, an
        // orphaned worker keeps the Discord IPC socket bound after the
        // plugin has disposed (e.g. user closed OpenCode with /exit), and
        // Discord continues showing the last activity because the IPC
        // client never disconnected. Self-targeted process.exit() is safe
        // (no PID-reuse concerns like the parent's SIGKILL fallback that
        // v2.0.8-rc5 removed). The unref() lets Node exit even if this
        // timer somehow keeps the loop alive.
        const killSwitch = setTimeout(() => {
            log("Shutdown kill switch (2s elapsed, forcing exit)");
            process.exit(0);
        }, 2000);
        if (killSwitch.unref) killSwitch.unref();
        // v2.0.8-rc3: explicitly tell Discord to clear the presence BEFORE
        // destroying the client. Without this, Discord keeps showing the
        // last activity after the worker exits because it never received a
        // clear-presence command. The user sees a "stuck" presence until
        // they manually quit+reopen Discord.
        //
        // v2.0.8-rc5: bound clearActivity and client.destroy with a 1s
        // timeout each. Without this, a hung Discord IPC connection would
        // keep the worker alive past the parent's 2s grace window, after
        // which the parent sends SIGKILL (PID-reuse race risk).
        //
        // v2.1.2: try clearActivity up to twice (1000ms then 500ms). The
        // first attempt's IPC frame may be dropped if Discord is busy
        // (e.g. mid-rendering the previous activity update); a quick retry
        // usually lands cleanly. If both fail, the kill switch above will
        // still force the worker to exit so the IPC socket is released.
        let r1 = await withTimeout(clearActivity(), 1000, "clearActivity");
        if (!r1.ok) {
            log("clearActivity on shutdown (attempt 1):", r1.error?.message || r1.error);
            r1 = await withTimeout(clearActivity(), 500, "clearActivity");
            if (!r1.ok) log("clearActivity on shutdown (attempt 2):", r1.error?.message || r1.error);
        }
        if (client) {
            const r2 = await withTimeout(client.disconnect(), 1000, "client.disconnect");
            if (!r2.ok) log("client.disconnect on shutdown:", r2.error?.message || r2.error);
        }
        process.exit(0);
    }
}

// Best-effort clear on signal: Discord would otherwise keep showing the
// last activity. We do not await because the signal handler should return
// quickly, and the in-flight clearActivity IPC frame usually lands before
// the process exits within the 200ms grace the parent gives us.
//
// v2.1.2: kill switch bumped from 150ms to 1500ms so clearActivity (1s
// timeout) has time to land before we force-exit. Without this, an
// abrupt exit could skip the clear and leave Discord with the activity.
function gracefulExit() {
    shuttingDown = true;
    try {
        withTimeout(clearActivity(), 1000, "clearActivity").catch(() => {});
        if (client) withTimeout(client.disconnect(), 1000, "client.disconnect").catch(() => {});
    } catch {}
    setTimeout(() => process.exit(0), 1500).unref?.();
}
process.on("SIGINT", gracefulExit);
process.on("SIGTERM", gracefulExit);

async function main() {
    try {
        appId = await loadAppId();
        log(`Worker started, APP_ID=${appId}`);
        send({ type: "ready", pid: process.pid, appId });
        connect();
    } catch (err) {
        log(`Fatal: ${err?.message || err}`);
        process.exit(1);
    }
}

main();
