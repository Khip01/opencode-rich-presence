import { writeFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { OPENCODE_DIR, OUTPUT_FILE } from "../shared/paths.js";
import { STATE, REFRESH_INTERVAL, FILE_WRITE_DEBOUNCE_MS, FALLBACK_MODEL_LIMITS } from "../shared/constants.js";
import { log } from "../shared/logger.js";
import { loadConfig } from "./config-resolver.js";
import { coordinator } from "./coordinator.js";
import { SessionState } from "./session-state.js";
import { withTimeout, formatDuration } from "./template-engine.js";
import { pushActivity, destroy as discordDestroy, shutdownWorker, startConnect, prepareConnect, getStatus, checkWorkerHealth, forceRestartWorker } from "./discord-service.js";

// ─── Global State ──────────────────────────────────────────────────────────

const sessions = new Map();
const queue = [];
let displayedSessionID = null;
const providerModels = new Map();
let writeTimer = null;
let config = null;

// v2.1.2: aggressive presence-refresh for the first few seconds after
// becoming leader. When the previous leader's worker died without a
// clean clearActivity (e.g. SIGKILL during the 2.5s grace), Discord
// keeps showing the stale activity. The first pushActivity from the
// new leader may land before Discord has fully cleaned up, so the
// display stays stuck on the previous leader until something forces a
// re-send. Periodic retries during the first 30s after becoming
// leader cover that window. The interval is also cleared as soon as
// leadership is lost, so it never runs for a non-leader.
//
// v2.1.2: also force-restart the worker after 4s if we are still
// leader. This mirrors what `opencode-rpc restart` does: kill the
// existing worker, wait 2s for the Discord IPC socket to be fully
// released by the OS, then spawn a fresh worker on a fresh socket
// connection. Without this, an existing worker that is "connected"
// to Discord but whose socket has inherited stale state from the
// previous leader (after all terminals exited) will push SET_ACTIVITY
// that Discord silently ignores. Killing + respawning forces a fresh
// socket that Discord treats as a brand-new client. The 4s delay
// gives the first attempt time to succeed on its own (most handoffs
// work fine without this); only the stale-state case triggers a real
// force-restart.
let leaderRetryTimer = null;
let leaderRetryStartedAt = 0;
const LEADER_RETRY_INTERVAL_MS = 2500;
const LEADER_RETRY_DURATION_MS = 30000;
const LEADER_FORCE_RESTART_DELAY_MS = 4000;

function startLeaderPresenceRetry() {
    stopLeaderPresenceRetry();
    leaderRetryStartedAt = Date.now();
    leaderRetryTimer = setInterval(() => {
        if (!coordinator.isLeader || Date.now() - leaderRetryStartedAt > LEADER_RETRY_DURATION_MS) {
            stopLeaderPresenceRetry();
            return;
        }
        scheduleWrite();
    }, LEADER_RETRY_INTERVAL_MS);
    if (leaderRetryTimer.unref) leaderRetryTimer.unref();
    // v2.1.2: force-restart the worker after a short delay. The
    // existing worker's IPC socket may carry stale state from a
    // previous leader (e.g. after all terminals exited and one is
    // reopened). Killing + waiting + spawning fresh gives Discord a
    // clean IPC socket to bind to and ensures our pushActivity lands.
    setTimeout(() => {
        if (coordinator.isLeader) {
            log("Leader force-restart: refreshing worker IPC connection");
            forceRestartWorker().catch((e) => log("forceRestartWorker:", e?.message || e));
        }
    }, LEADER_FORCE_RESTART_DELAY_MS).unref?.();
}

function stopLeaderPresenceRetry() {
    if (leaderRetryTimer) {
        clearInterval(leaderRetryTimer);
        leaderRetryTimer = null;
    }
}

// Record that this instance is doing something. Updates the local lastActivity
// timestamp so the leader's heartbeat knows we are fresher than it. If we are
// a standby AND this is a user-initiated event, also request leadership so we
// push to Discord instead of the idle leader.
//
// opts.requestHandoff === false: agent-side events (typing, tool calls,
// message parts, etc.) only mark active, do NOT request handoff. Only
// user-initiated events (chat.message, permission.asked/replied) should
// request handoff; otherwise all instances see the same SDK events and
// ping-pong leadership back and forth.
function noteActivity(opts = {}) {
    coordinator.markActive();
    if (!coordinator.isLeader && opts.requestHandoff !== false) {
        coordinator.requestHandoff().catch((e) => log("requestHandoff:", e?.message || e));
    }
}

// ─── File Output ───────────────────────────────────────────────────────────

function scheduleWrite() {
    const d = displayedSessionID ? sessions.get(displayedSessionID) : null;
    pushActivity(d, config, coordinator.isLeader);
    if (!coordinator.isLeader) return;
    if (writeTimer) return;
    writeTimer = setTimeout(async () => {
        writeTimer = null;
        try { await writeFile(OUTPUT_FILE, formatOutput(), "utf-8"); } catch (e) { log("Write failed:", e?.message || e); }
    }, FILE_WRITE_DEBOUNCE_MS);
    writeTimer.unref?.();
}

function formatOutput() {
    const now = new Date();
    const d = displayedSessionID ? sessions.get(displayedSessionID) : null;
    const lines = [];
    lines.push("=".repeat(60));
    lines.push(` OpenCode Presence State - ${now.toISOString().replace("T", " ").substring(0, 19)} UTC`);
    lines.push("=".repeat(60));
    lines.push("");

    if (d) {
        const t = d.contextTokens.toLocaleString();
        const l = d.modelLimit ? d.modelLimit.toLocaleString() : "unknown";
        const ct = d.cost === 0 ? "$0.0000 (infinite)" : `$${d.cost.toFixed(4)}`;
        lines.push("DISPLAYED SESSION");
        lines.push(`  ID        : ${d.sessionID}`);
        lines.push(`  Provider  : ${d.provider}`);
        lines.push(`  Model     : ${d.model}`);
        lines.push(`  Mode      : ${d.mode}`);
        lines.push(`  State     : ${d.state}`);
        lines.push(`  Started   : ${new Date(d.startedAt).toISOString().substring(0, 19)} (${formatDuration(Date.now() - d.startedAt)})`);
        lines.push(`  Context   : ${t} / ${l} tokens (${d.contextPercent.toFixed(1)}%)`);
        lines.push(`  Cost      : ${ct}`);
        lines.push(`  Prompts   : ${d.promptCount}`);
    } else {
        lines.push("NO ACTIVE SESSION");
        lines.push("  (waiting for first prompt...)");
    }

    lines.push("");
    lines.push(`QUEUE (${queue.length} session${queue.length === 1 ? "" : "s"})`);
    if (queue.length === 0) {
        lines.push("  (empty)");
    } else {
        queue.forEach((s) => {
            const ss = sessions.get(s);
            if (!ss) return;
            const m = s === displayedSessionID ? "->" : " ";
            lines.push(`  ${m} [${ss.state.padEnd(20)}] ${ss.sessionID}  (${formatDuration(Date.now() - ss.startedAt)})`);
        });
    }

    lines.push("");
    const status = getStatus();
    lines.push("=".repeat(60));
    lines.push(` Application ID : ${config?.appId || "?"}`);
    lines.push(` Asset Key      : ${config?.largeImageKey || "?"}`);
    lines.push(` Asset Text     : ${config?.largeImageText || "?"}`);
    lines.push(` Phase          : 2 (State Collector + Discord RPC)`);
    lines.push(` Discord        : ${status.connected ? "connected" : "disconnected"}`);
    lines.push(` Discord Error  : ${status.lastError || "(none)"}`);
    lines.push(` Discord Retries: ${status.retryCount}`);
    lines.push(` Last Attempt   : ${status.lastAttemptAt ? formatDuration(Date.now() - status.lastAttemptAt) + " ago" : "never"}`);
    lines.push(` Models Loaded  : ${providerModels.size}`);
    lines.push(` Output File    : ${OUTPUT_FILE}`);
    lines.push("=".repeat(60));
    return lines.join("\n");
}

// ─── Display / Queue Logic ─────────────────────────────────────────────────

function updateDisplay() {
    for (const s of queue) {
        const ss = sessions.get(s);
        if (ss?.isActive()) { displayedSessionID = s; return; }
    }
    let lt = 0, li = null;
    for (const s of queue) {
        const ss = sessions.get(s);
        if (ss && ss.lastActivity > lt) { lt = ss.lastActivity; li = s; }
    }
    displayedSessionID = li;
}

function getModelLimit(mid) {
    if (!mid) return null;
    if (providerModels.has(mid)) return providerModels.get(mid);
    const st = mid.includes("/") ? mid.split("/").slice(1).join("/") : mid;
    if (providerModels.has(st)) return providerModels.get(st);
    return null;
}

function ensureSession(sid) {
    if (!sid) return null;
    let s = sessions.get(sid);
    if (!s) {
        s = new SessionState(sid);
        sessions.set(sid, s);
        if (!queue.includes(sid)) queue.push(sid);
    }
    return s;
}

// ─── SDK Calls ─────────────────────────────────────────────────────────────

async function restoreSessionMessages(client, sid, wd) {
    const s = ensureSession(sid);
    try {
        const o = { path: { id: sid } };
        if (wd) o.query = { directory: wd };
        const r = await withTimeout(client.session.messages(o), 5000, `messages(${sid})`);
        let msgs = Array.isArray(r?.data) ? r.data : (Array.isArray(r) ? r : null);
        if (!Array.isArray(msgs)) return;
        let lm = null, ac = 0;
        for (const m of msgs) {
            const i = m?.info ?? m;
            if (!i || i.role !== "assistant") continue;
            const wn = !s._messageMap.has(i.id);
            s.addOrUpdateMessage(i.id, i.cost, i.tokens, i.modelID, i.providerID, i.time?.completed, i.time?.created);
            if (wn) { s.promptCount++; ac++; }
            if (i.modelID) s.model = i.modelID;
            if (i.providerID) s.provider = i.providerID;
            if (i.mode) lm = i.mode;
        }
        if (lm) s.mode = lm;
        s.modelLimit = getModelLimit(s.model) ?? s.modelLimit;
        log(`Restored ${sid}: ${ac} msgs, $${s.cost.toFixed(4)}, model=${s.model}`);
    } catch (e) { log(`restoreMsg(${sid}): ${e?.message || e}`); }
}

async function checkAllSessionsActivity(client, wd) {
    try {
        const listOpts = wd ? { query: { directory: wd } } : undefined;
        const resp = await withTimeout(client.session.list(listOpts), 5000, "session.list");
        const list = resp?.data ?? resp;
        if (!Array.isArray(list)) return;

        const checks = list.filter(s => s?.id).map(async (si) => {
            const id = si.id;
            const state = sessions.get(id);
            if (!state) return;
            const opts = { path: { id } };
            if (wd) opts.query = { directory: wd, limit: 1 };
            try {
                const r = await withTimeout(client.session.messages(opts), 5000, `latest(${id})`);
                const msgs = Array.isArray(r?.data) ? r.data : (Array.isArray(r) ? r : null);
                if (!Array.isArray(msgs) || msgs.length === 0) return;
                const latest = msgs[msgs.length - 1];
                const info = latest?.info ?? latest;
                if (!info) return;
                const ts = info.time?.completed || info.time?.created || 0;
                if (ts > state.lastActivity) state.lastActivity = ts;
                if (info.role === "user") state.state = STATE.WORKING;
                else if (info.role === "assistant" && !info.time?.completed) state.state = STATE.TYPING;
                else if (info.role === "assistant" && info.time?.completed) state.state = STATE.WAITING;
            } catch {}
        });

        await Promise.allSettled(checks);

        const previousDisplayed = displayedSessionID;
        updateDisplay();
        if (displayedSessionID !== previousDisplayed) {
            log(`Switched display: ${previousDisplayed?.slice(-8) || "(none)"} -> ${displayedSessionID?.slice(-8) || "(none)"}`);
            scheduleWrite();
        }
    } catch (e) {
        log(`checkAllSessionsActivity: ${e?.message || e}`);
    }
}

async function loadProviderModels(client, wd) {
    try {
        const o = wd ? { query: { directory: wd } } : undefined;
        const r = await withTimeout(client.provider.list(o), 5000, "provider.list");
        const d = r?.data ?? r;
        const pl = d?.all ?? (Array.isArray(d) ? d : null);
        if (!Array.isArray(pl)) return;
        for (const p of pl) {
            if (!p?.models) continue;
            for (const [mid, m] of Object.entries(p.models)) {
                if (m?.limit?.context) {
                    providerModels.set(mid, m.limit.context);
                    if (p.id) providerModels.set(`${p.id}/${mid}`, m.limit.context);
                    const st = mid.includes("/") ? mid.split("/").slice(1).join("/") : mid;
                    if (st !== mid) providerModels.set(st, m.limit.context);
                }
            }
        }
        log(`Loaded ${providerModels.size} model limits`);
    } catch (e) { log(`loadModels: ${e?.message || e}`); }
}

async function restoreFromServer(client, wd) {
    try {
        await loadProviderModels(client, wd);
        const o = wd ? { query: { directory: wd } } : undefined;
        const r = await withTimeout(client.session.list(o), 5000, "session.list");
        const sl = r?.data ?? r;
        if (!Array.isArray(sl)) return log("No sessions to restore");
        const tasks = sl.filter(x => x?.id).map(async (si) => {
            const s = ensureSession(si.id);
            if (si.time?.created) s.startedAt = si.time.created;
            s.lastActivity = si.time?.updated || s.startedAt;
            try { await restoreSessionMessages(client, si.id, wd); } catch (e) { log(`Restore task ${si.id}: ${e?.message || e}`); }
        });
        await Promise.allSettled(tasks);
        updateDisplay();
        scheduleWrite();
        log(`Restored ${sessions.size} sessions`);
    } catch (e) { log(`restoreAll: ${e?.message || e}`); }
}

function loadFallbackLimits() {
    let c = 0;
    for (const [id, l] of Object.entries(FALLBACK_MODEL_LIMITS)) { providerModels.set(id, l); c++; }
    log(`Loaded ${c} fallback limits`);
}

async function loadConfigLimits(p) {
    if (!p) return;
    try {
        const raw = await readFile(p, "utf-8");
        const j = JSON.parse(raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""));
        const prs = j?.provider;
        if (!prs || typeof prs !== "object") return;
        let c = 0;
        for (const [pid, pd] of Object.entries(prs)) {
            if (!pd?.models) continue;
            for (const [mid, m] of Object.entries(pd.models)) {
                const l = m?.limit?.context;
                if (typeof l === "number" && l > 0) {
                    providerModels.set(mid, l);
                    providerModels.set(`${pid}/${mid}`, l);
                    const st = mid.includes("/") ? mid.split("/").slice(1).join("/") : mid;
                    if (st !== mid) providerModels.set(st, l);
                    c++;
                }
            }
        }
        log(`Loaded ${c} model limits from ${basename(p)}`);
    } catch (e) { log(`loadConfigLimits(${p}): ${e?.message || e}`); }
}

// ─── Main Plugin ───────────────────────────────────────────────────────────

export const OpencodeRichPresence = async ({ client, directory }) => {
    if (!client) { log("No client"); return {}; }

    log("=== Plugin loaded ===");
    log(`Output: ${OUTPUT_FILE}`);
    log(`Workdir: ${directory || "(none)"}`);

    config = await loadConfig();

    // React to leadership transitions: connect to Discord on gain, tear the
    // worker down on loss. This is what makes a standby instance that takes
    // over leadership via activity handoff actually start pushing presence.
    coordinator.setLeadershipChangeCallback(async (nowLeader) => {
        if (nowLeader) {
            log("Gained leadership, connecting to Discord");
            // v2.1.2: just startConnect, not startConnectAsLeader. The latter
            // forced a fresh worker on every handoff (kill + wait 2s IPC
            // release + spawn fresh), which made multi-terminal switching
            // feel like a restart under slow internet. Self-heal watchdog
            // (checkWorkerHealth, threshold 15s) handles genuinely stuck
            // workers, so we do not need to force-restart on every handoff.
            // The standby's prepareConnect() usually already spawned a
            // worker when the user fired their first message, so by the
            // time we run, the worker is already trying to connect. We just
            // send the connect command to keep it going.
            try { startConnect(config); } catch (e) { log("startConnect:", e?.message || e); }
            // Force a state refresh from the server so the new leader's
            // session states reflect reality, not stale in-memory snapshots
            // from when we were standby (standby does not poll for activity).
            try { await checkAllSessionsActivity(client, directory); } catch (e) { log("refresh:", e?.message || e); }
            scheduleWrite();
            // v2.1.2: aggressive presence-refresh for 15s after becoming
            // leader. See comment on startLeaderPresenceRetry for why.
            startLeaderPresenceRetry();
        } else {
            log("Lost leadership, disconnecting from Discord");
            stopLeaderPresenceRetry();
            try { await shutdownWorker(); } catch (e) { log("shutdownWorker:", e?.message || e); }
        }
    });

    await coordinator.tryAcquire();

    loadFallbackLimits();

    const cfgPaths = [
        directory ? join(directory, "opencode.json") : null,
        directory ? join(directory, "opencode.jsonc") : null,
        join(homedir(), ".config", "opencode", "opencode.json"),
        join(homedir(), ".config", "opencode", "opencode.jsonc"),
    ].filter(Boolean);
    for (const p of cfgPaths) { loadConfigLimits(p).catch(() => {}); }

    try { await mkdir(OPENCODE_DIR, { recursive: true }); } catch {}

    restoreFromServer(client, directory).catch(e => log(`Background restore error: ${e?.message || e}`));

    if (coordinator.isLeader) {
        coordinator.startHeartbeat();
        startConnect(config);
    } else {
        log("Standby - waiting for leadership opportunity");
        coordinator.startStandbyPolling();
    }

    scheduleWrite();

    const activityTimer = setInterval(() => {
        if (coordinator.isLeader) {
            checkAllSessionsActivity(client, directory).catch((e) => log(`Activity check failed: ${e?.message || e}`));
            // v2.1.2: self-heal stuck worker. If the leader's worker has been
            // failing to connect for STALE_WORKER_THRESHOLD_MS (Discord IPC
            // socket in a bad state the worker cannot recover from on its
            // own), kill and respawn it. Mirrors what `opencode-rpc restart`
            // does, but automatic.
            checkWorkerHealth();
        }
    }, REFRESH_INTERVAL);
    activityTimer.unref?.();

    const refreshTimer = setInterval(() => {
        const d = displayedSessionID ? sessions.get(displayedSessionID) : null;
        if (d && d.state !== STATE.WAITING) restoreSessionMessages(client, d.sessionID, directory).catch(() => {});
    }, REFRESH_INTERVAL);
    refreshTimer.unref?.();

    return {
        dispose: async () => {
            log("Disposing...");
            clearInterval(refreshTimer);
            clearInterval(activityTimer);
            coordinator.stopStandbyPolling();
            await coordinator.release();
            await discordDestroy();
        },

        "chat.message": async (input) => {
            try {
                const sid = input.sessionID;
                if (!sid) return;
                const s = ensureSession(sid);
                s.agent = input.agent || s.agent;
                s.model = input.model?.modelID || s.model;
                s.mode = input.agent || s.mode;
                s.modelLimit = getModelLimit(s.model) ?? s.modelLimit;
                s.lastActivity = Date.now();
                s.promptCount++;
                s.state = STATE.WORKING;
                noteActivity();
                // v2.0.8-rc4: pre-spawn the worker so the handoff gap is
                // shorter. The worker starts retrying Discord login while we
                // are still standby; by the time the leader releases, the
                // worker's next retry tick already has a free IPC socket.
                if (!coordinator.isLeader) prepareConnect(config);
                updateDisplay();
                scheduleWrite();
                restoreSessionMessages(client, sid, directory).catch(() => {});
            } catch (e) { log("chat.message error:", e?.message || e); }
        },

        event: async ({ event }) => {
            try {
                const et = event?.type;
                if (!et) return;

                if (et === "session.created" || et === "session.updated") {
                    const i = event.properties?.info;
                    if (!i?.id) return;
                    const s = ensureSession(i.id);
                    if (i.time?.created) s.startedAt = i.time.created;
                    s.lastActivity = Date.now();
                    noteActivity({ requestHandoff: false });
                    updateDisplay();
                    scheduleWrite();
                    restoreSessionMessages(client, i.id, directory).catch(() => {});
                    return;
                }

                if (et === "session.deleted") {
                    const i = event.properties?.info;
                    const id = i?.id;
                    if (!id) return;
                    sessions.delete(id);
                    const idx = queue.indexOf(id);
                    if (idx !== -1) queue.splice(idx, 1);
                    if (displayedSessionID === id) updateDisplay();
                    scheduleWrite();
                    return;
                }

                if (et === "session.status" || et === "session.idle") {
                    const sid = event.properties?.sessionID;
                    if (!sid) return;
                    const s = sessions.get(sid);
                    if (!s) return;
                    const st = event.properties?.status?.type ?? (et === "session.idle" ? "idle" : null);
                    s.lastActivity = Date.now();
                    if ((st === "idle" || et === "session.idle") && s.state !== STATE.ASKING) s.state = STATE.WAITING;
                    else if (st === "busy" && ![STATE.TYPING, STATE.THINKING, STATE.ASKING].includes(s.state)) s.state = STATE.WORKING;
                    if (st === "busy") noteActivity({ requestHandoff: false });
                    updateDisplay();
                    scheduleWrite();
                    return;
                }

                if (et === "message.updated") {
                    const i = event.properties?.info;
                    if (!i || i.role !== "assistant") return;
                    const sid = i.sessionID;
                    if (!sid) return;
                    const s = ensureSession(sid);
                    s.addOrUpdateMessage(i.id, i.cost, i.tokens, i.modelID, i.providerID, i.time?.completed, i.time?.created);
                    if (i.mode) s.mode = i.mode;
                    s.modelLimit = getModelLimit(s.model) ?? s.modelLimit;
                    s.lastActivity = Date.now();
                    noteActivity({ requestHandoff: false });
                    updateDisplay();
                    scheduleWrite();
                    return;
                }

                if (et === "message.part.updated") {
                    const p = event.properties?.part;
                    if (!p) return;
                    const sid = p.sessionID;
                    if (!sid) return;
                    const s = sessions.get(sid);
                    if (!s) return;
                    s.lastActivity = Date.now();
                    if (p.type === "reasoning") s.state = STATE.THINKING;
                    else if (p.type === "text" && s.state !== STATE.ASKING) s.state = STATE.TYPING;
                    else if (p.type === "tool") s.state = STATE.WORKING;
                    else if (p.type === "step-finish" && p.tokens) {
                        const ctxT = (p.tokens.input || 0) + (p.tokens.cache?.read || 0);
                        if (ctxT > 0) s._latestContextTokens = ctxT;
                    }
                    noteActivity({ requestHandoff: false });
                    updateDisplay();
                    scheduleWrite();
                    return;
                }

                if (et === "permission.asked") {
                    const sid = event.properties?.sessionID;
                    if (!sid) return;
                    const s = sessions.get(sid);
                    if (!s) return;
                    s.state = STATE.ASKING;
                    s.lastActivity = Date.now();
                    noteActivity();
                    if (!coordinator.isLeader) prepareConnect(config);
                    updateDisplay();
                    scheduleWrite();
                    return;
                }

                if (et === "permission.replied") {
                    const sid = event.properties?.sessionID;
                    if (!sid) return;
                    const s = sessions.get(sid);
                    if (!s) return;
                    s.state = STATE.WORKING;
                    s.lastActivity = Date.now();
                    noteActivity();
                    if (!coordinator.isLeader) prepareConnect(config);
                    updateDisplay();
                    scheduleWrite();
                    return;
                }
            } catch (e) { log("event error:", e?.message || e); }
        },
    };
};

export default OpencodeRichPresence;
