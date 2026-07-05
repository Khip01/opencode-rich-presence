import { writeFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { OPENCODE_DIR, OUTPUT_FILE } from "../shared/paths.js";
import {
    STATE,
    REFRESH_INTERVAL,
    FILE_WRITE_DEBOUNCE_MS,
    FALLBACK_MODEL_LIMITS,
} from "../shared/constants.js";
import { log, activity } from "../shared/logger.js";
import { loadConfig } from "./config-resolver.js";
import { SessionState } from "./session-state.js";
import { withTimeout, formatDuration } from "./template-engine.js";
import {
    renderPresence,
    pushPresence,
    startPresence,
    stopPresence,
    getPresenceStatus,
} from "./local-presence.js";

// ─── Global State ──────────────────────────────────────────────────────────

const sessions = new Map();
const queue = [];
let displayedSessionID = null;
const providerModels = new Map();
let writeTimer = null;
let config = null;
// Phase 1: each OpenCode instance writes its OWN state file so multi-
// instance runs do not race on a single file. Naming uses the process PID
// for stability (the same instance always writes to the same file).
const MY_STATE_FILE = OUTPUT_FILE.replace(/\.txt$/, `-pid${process.pid}.txt`);

// ─── File Output ───────────────────────────────────────────────────────────

function scheduleWrite() {
    // Render + log the would-push payload BEFORE touching the file so the
    // activity log shows the resolved template values regardless of
    // whether the file write succeeds.
    const d = displayedSessionID ? sessions.get(displayedSessionID) : null;
    const rendered = renderPresence(d, config);
    pushPresence(rendered);

    if (writeTimer) return;
    writeTimer = setTimeout(async () => {
        writeTimer = null;
        try { await writeFile(MY_STATE_FILE, formatOutput(rendered), "utf-8"); } catch (e) { log("Write failed:", e?.message || e); }
    }, FILE_WRITE_DEBOUNCE_MS);
    writeTimer.unref?.();
}

function formatOutput(rendered) {
    const now = new Date();
    const d = displayedSessionID ? sessions.get(displayedSessionID) : null;
    const lines = [];
    lines.push("=".repeat(60));
    lines.push(` OpenCode Presence State - pid ${process.pid}`);
    lines.push(` Updated: ${now.toISOString().replace("T", " ").substring(0, 19)} UTC`);
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
    lines.push("RENDERED PRESENCE (what Phase 2 would push to Discord)");
    if (rendered) {
        lines.push(`  details         : ${rendered.details || "(empty)"}`);
        lines.push(`  state           : ${rendered.state || "(empty)"}`);
        lines.push(`  largeImageKey   : ${rendered.largeImageKey || "?"}`);
        lines.push(`  largeImageText  : ${rendered.largeImageText || "(empty)"}`);
        lines.push(`  smallImageText  : ${rendered.smallImageText || "(empty)"}`);
    } else {
        lines.push("  (nothing rendered)");
    }

    lines.push("");
    const status = getPresenceStatus();
    lines.push("=".repeat(60));
    lines.push(` Application ID : ${config?.appId || "?"}`);
    lines.push(` Asset Key      : ${config?.largeImageKey || "?"}`);
    lines.push(` Asset Text     : ${config?.largeImageText || "?"}`);
    lines.push(` Phase          : 1 (local state + activity log, no Discord push)`);
    lines.push(` State File     : ${MY_STATE_FILE}`);
    lines.push(` Activity Log   : ~/.config/opencode/presence-activity.log`);
    lines.push(` Models Loaded  : ${providerModels.size}`);
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
        activity("queue", `added sid=${sid.slice(-8)} (queue size ${queue.length})`);
    }
    return s;
}

// Record a session state transition. Logs only when the state actually
// changes so the activity log is a clean history (no spam on every event).
function transitionTo(s, newState, reason) {
    if (!s || s.state === newState) return;
    const prev = s.state;
    s.state = newState;
    activity("state", `sid=${s.sessionID.slice(-8)} ${prev} -> ${newState} (${reason})`);
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
        activity("restore", `sid=${sid.slice(-8)} restored=${ac} cost=$${s.cost.toFixed(4)} model=${s.model}`);
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
                if (info.role === "user") transitionTo(state, STATE.WORKING, "poll: latest is user message");
                else if (info.role === "assistant" && !info.time?.completed) transitionTo(state, STATE.TYPING, "poll: assistant message in progress");
                else if (info.role === "assistant" && info.time?.completed) transitionTo(state, STATE.WAITING, "poll: assistant message completed");
            } catch {}
        });

        await Promise.allSettled(checks);

        const previousDisplayed = displayedSessionID;
        updateDisplay();
        if (displayedSessionID !== previousDisplayed) {
            activity(
                "display",
                `sid=${previousDisplayed?.slice(-8) || "(none)"} -> sid=${displayedSessionID?.slice(-8) || "(none)"} (${queue.length} in queue)`,
            );
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
        activity("models", `loaded ${providerModels.size} provider model limits`);
    } catch (e) { log(`loadModels: ${e?.message || e}`); }
}

async function restoreFromServer(client, wd) {
    try {
        await loadProviderModels(client, wd);
        const o = wd ? { query: { directory: wd } } : undefined;
        const r = await withTimeout(client.session.list(o), 5000, "session.list");
        const sl = r?.data ?? r;
        if (!Array.isArray(sl)) { activity("restore", "no sessions to restore"); return; }
        const tasks = sl.filter(x => x?.id).map(async (si) => {
            const s = ensureSession(si.id);
            if (si.time?.created) s.startedAt = si.time.created;
            s.lastActivity = si.time?.updated || s.startedAt;
            try { await restoreSessionMessages(client, si.id, wd); } catch (e) { log(`Restore task ${si.id}: ${e?.message || e}`); }
        });
        await Promise.allSettled(tasks);
        updateDisplay();
        scheduleWrite();
        activity("restore", `completed: ${sessions.size} sessions restored`);
    } catch (e) { log(`restoreAll: ${e?.message || e}`); }
}

function loadFallbackLimits() {
    let c = 0;
    for (const [id, l] of Object.entries(FALLBACK_MODEL_LIMITS)) { providerModels.set(id, l); c++; }
    activity("models", `loaded ${c} fallback model limits`);
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
        activity("models", `loaded ${c} model limits from ${basename(p)}`);
    } catch (e) { log(`loadConfigLimits(${p}): ${e?.message || e}`); }
}

// ─── Main Plugin ───────────────────────────────────────────────────────────

export const OpencodeRichPresence = async ({ client, directory }) => {
    if (!client) { log("No client"); return {}; }

    activity("load", `plugin loaded workdir=${directory || "(none)"}`);

    config = await loadConfig();
    activity(
        "config",
        `appId=${config.appId} key=${config.largeImageKey} currency=${config.currency}`,
    );

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

    startPresence();

    scheduleWrite();

    const activityTimer = setInterval(() => {
        checkAllSessionsActivity(client, directory).catch((e) => log(`Activity check failed: ${e?.message || e}`));
    }, REFRESH_INTERVAL);
    activityTimer.unref?.();

    const refreshTimer = setInterval(() => {
        const d = displayedSessionID ? sessions.get(displayedSessionID) : null;
        if (d && d.state !== STATE.WAITING) restoreSessionMessages(client, d.sessionID, directory).catch(() => {});
    }, REFRESH_INTERVAL);
    refreshTimer.unref?.();

    return {
        dispose: async () => {
            activity("load", "disposing (OpenCode shutting down)");
            clearInterval(refreshTimer);
            clearInterval(activityTimer);
            stopPresence();
        },

        "chat.message": async (input) => {
            try {
                const sid = input.sessionID;
                if (!sid) return;
                const s = ensureSession(sid);
                const agent = input.agent || s.agent;
                const model = input.model?.modelID || s.model;
                const mode = input.agent || s.mode;
                s.agent = agent;
                s.model = model;
                s.mode = mode;
                s.modelLimit = getModelLimit(s.model) ?? s.modelLimit;
                s.lastActivity = Date.now();
                s.promptCount++;
                activity(
                    "event",
                    `chat.message sid=${sid.slice(-8)} agent=${agent} model=${model} mode=${mode}`,
                );
                if (model !== input.model?.modelID && !input.model?.modelID) {
                    activity("session", `sid=${sid.slice(-8)} model=${model} (no model in event)`);
                } else if (model) {
                    activity("session", `sid=${sid.slice(-8)} model=${model} provider=${s.provider}`);
                }
                transitionTo(s, STATE.WORKING, "chat.message");
                const prev = displayedSessionID;
                updateDisplay();
                if (displayedSessionID !== prev) {
                    activity("display", `sid=${prev?.slice(-8) || "(none)"} -> sid=${displayedSessionID?.slice(-8) || "(none)"} (chat.message)`);
                }
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
                    const created = i.time?.created;
                    if (created) s.startedAt = created;
                    s.lastActivity = Date.now();
                    activity(
                        "event",
                        `${et} sid=${i.id.slice(-8)} parent=${i.parentID?.slice(-8) || "(root)"}`,
                    );
                    const prev = displayedSessionID;
                    updateDisplay();
                    if (displayedSessionID !== prev) {
                        activity("display", `sid=${prev?.slice(-8) || "(none)"} -> sid=${displayedSessionID?.slice(-8) || "(none)"} (${et})`);
                    }
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
                    activity("event", `session.deleted sid=${id.slice(-8)} (queue size ${queue.length})`);
                    activity("queue", `removed sid=${id.slice(-8)} (queue size ${queue.length})`);
                    const prev = displayedSessionID;
                    updateDisplay();
                    if (displayedSessionID !== prev) {
                        activity("display", `sid=${prev?.slice(-8) || "(none)"} -> sid=${displayedSessionID?.slice(-8) || "(none)"} (session.deleted)`);
                    }
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
                    activity("event", `${et} sid=${sid.slice(-8)} status=${st || "(none)"}`);
                    if ((st === "idle" || et === "session.idle") && s.state !== STATE.ASKING) {
                        transitionTo(s, STATE.WAITING, `${et} (idle)`);
                    } else if (st === "busy" && ![STATE.TYPING, STATE.THINKING, STATE.ASKING].includes(s.state)) {
                        transitionTo(s, STATE.WORKING, `${et} (busy)`);
                    }
                    const prev = displayedSessionID;
                    updateDisplay();
                    if (displayedSessionID !== prev) {
                        activity("display", `sid=${prev?.slice(-8) || "(none)"} -> sid=${displayedSessionID?.slice(-8) || "(none)"} (${et})`);
                    }
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
                    activity(
                        "event",
                        `message.updated sid=${sid.slice(-8)} role=assistant completed=${!!i.time?.completed} cost=$${(i.cost || 0).toFixed(4)} model=${i.modelID || s.model}`,
                    );
                    if (i.cost > 0 || i.tokens) {
                        const ctxT = (i.tokens?.input || 0) + (i.tokens?.cache?.read || 0);
                        activity(
                            "stats",
                            `sid=${sid.slice(-8)} cost=$${s.cost.toFixed(4)} tokens.in=${i.tokens?.input || 0} tokens.out=${i.tokens?.output || 0} ctx=${ctxT} (${s.contextPercent.toFixed(1)}%)`,
                        );
                    }
                    if (i.time?.completed) {
                        transitionTo(s, STATE.WAITING, "message.updated completed");
                    }
                    const prev = displayedSessionID;
                    updateDisplay();
                    if (displayedSessionID !== prev) {
                        activity("display", `sid=${prev?.slice(-8) || "(none)"} -> sid=${displayedSessionID?.slice(-8) || "(none)"} (message.updated)`);
                    }
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
                    let partDesc = p.type;
                    if (p.type === "text" && p.text) partDesc = `text(${p.text.length}b)`;
                    else if (p.type === "tool" && p.tool) partDesc = `tool(${p.tool})`;
                    activity("event", `message.part.updated sid=${sid.slice(-8)} type=${partDesc}`);
                    if (p.type === "reasoning") transitionTo(s, STATE.THINKING, "part: reasoning");
                    else if (p.type === "text" && s.state !== STATE.ASKING) transitionTo(s, STATE.TYPING, "part: text");
                    else if (p.type === "tool") transitionTo(s, STATE.WORKING, "part: tool");
                    else if (p.type === "step-finish" && p.tokens) {
                        const ctxT = (p.tokens.input || 0) + (p.tokens.cache?.read || 0);
                        if (ctxT > 0) {
                            s._latestContextTokens = ctxT;
                            activity("stats", `sid=${sid.slice(-8)} step-finish ctx=${ctxT} (${s.contextPercent.toFixed(1)}%)`);
                        }
                    }
                    const prev = displayedSessionID;
                    updateDisplay();
                    if (displayedSessionID !== prev) {
                        activity("display", `sid=${prev?.slice(-8) || "(none)"} -> sid=${displayedSessionID?.slice(-8) || "(none)"} (message.part.updated)`);
                    }
                    scheduleWrite();
                    return;
                }

                if (et === "permission.asked") {
                    const sid = event.properties?.sessionID;
                    if (!sid) return;
                    const s = sessions.get(sid);
                    if (!s) return;
                    s.lastActivity = Date.now();
                    activity("event", `permission.asked sid=${sid.slice(-8)}`);
                    transitionTo(s, STATE.ASKING, "permission.asked");
                    const prev = displayedSessionID;
                    updateDisplay();
                    if (displayedSessionID !== prev) {
                        activity("display", `sid=${prev?.slice(-8) || "(none)"} -> sid=${displayedSessionID?.slice(-8) || "(none)"} (permission.asked)`);
                    }
                    scheduleWrite();
                    return;
                }

                if (et === "permission.replied") {
                    const sid = event.properties?.sessionID;
                    if (!sid) return;
                    const s = sessions.get(sid);
                    if (!s) return;
                    s.lastActivity = Date.now();
                    const reply = event.properties?.response;
                    activity("event", `permission.replied sid=${sid.slice(-8)} response=${reply || "(none)"}`);
                    transitionTo(s, STATE.WORKING, "permission.replied");
                    const prev = displayedSessionID;
                    updateDisplay();
                    if (displayedSessionID !== prev) {
                        activity("display", `sid=${prev?.slice(-8) || "(none)"} -> sid=${displayedSessionID?.slice(-8) || "(none)"} (permission.replied)`);
                    }
                    scheduleWrite();
                    return;
                }
            } catch (e) { log("event error:", e?.message || e); }
        },
    };
};

export default OpencodeRichPresence;
