#!/usr/bin/env node
// Discord RPC worker - uses @xhayper/discord-rpc.
// Runs as Node.js subprocess so Bun's Unix socket issues are bypassed.
// Cross-platform: @xhayper/discord-rpc handles Unix sockets (Linux/macOS) and named pipes (Windows).

import { Client } from "@xhayper/discord-rpc";
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
let clientGeneration = 0;
let disposed = false;
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

    const myGeneration = ++clientGeneration;

    try {
        if (client) {
            try { client.destroy?.(); } catch {}
        }
        client = new Client({ clientId: appId });
        client.on("ready", () => {
            if (myGeneration !== clientGeneration) return;
            connected = true;
            retryCount = 0;
            log("Discord READY event");
            send({ type: "connected" });
            if (pendingActivity) {
                client.user?.setActivity(pendingActivity).catch((err) => {
                    log("Replay activity failed:", err?.message || err);
                });
            }
        });
        client.on("disconnected", () => {
            if (myGeneration !== clientGeneration) return;
            connected = false;
            log("Discord disconnected");
            send({ type: "disconnected" });
            scheduleReconnect();
        });

        client.login().catch((err) => {
            if (myGeneration !== clientGeneration) return;
            const msg = err?.message || String(err);
            log("Login failed:", msg);
            send({ type: "error", error: msg });
            scheduleReconnect();
        });
    } catch (err) {
        log("Connect sync error:", err?.message || err);
        send({ type: "error", error: err?.message || String(err) });
        scheduleReconnect();
    }
}

function pushActivity(activity) {
    pendingActivity = activity;
    if (!connected || !client?.user) return;
    if (pushDebounceTimer) return;
    pushDebounceTimer = setTimeout(() => {
        pushDebounceTimer = null;
        if (connected && pendingActivity && client?.user) {
            client.user.setActivity(pendingActivity).then(() => {
                log("Activity sent");
            }).catch((err) => {
                log("setActivity failed:", err?.message || err);
            });
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
    if (connected && client?.user) {
        try {
            await client.user.clearActivity();
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
        if (client) {
            try { await client.destroy(); } catch {}
        }
        process.exit(0);
    }
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

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
