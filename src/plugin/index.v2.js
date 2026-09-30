// OpenCode V2 plugin entry for opencode-rich-presence.
//
// Reuses the daemon, Discord IPC, templates and config as-is; only the
// OpenCode integration layer uses the V2 plugin API
// (export default Plugin.define({ id, setup(ctx) })). Session activity
// is rendered locally and forwarded to the daemon over the local IPC
// endpoint, same as the V1 entry (src/plugin/index.js).
//
// Selected by `opencode-rpc install` when OpenCode v2 is detected.
// Requires the `@opencode/plugin` dependency (see package.json).

import { Plugin } from "@opencode/plugin";
import { loadConfig } from "./config-resolver.js";
import { SessionState } from "./session-state.js";
import { STATE } from "../shared/constants.js";
import { activity, log } from "../shared/logger.js";
import { readState } from "../shared/presence-state.js";
import {
    renderPresence,
    pushPresence,
    startPresence,
    stopPresence,
    ensureConnected,
    sendStateToDaemon,
} from "./local-presence.js";
import { ensureDaemonRunning } from "./daemon-spawner.js";

const sessions = new Map();
let displayedID = null;
const modelLimits = new Map();
let config = null;
let presenceEnabled = true;
let daemonStopped = false;

function limitFor(mid) {
    if (!mid) return null;
    if (modelLimits.has(mid)) return modelLimits.get(mid);
    const stripped = mid.includes("/") ? mid.split("/").slice(1).join("/") : mid;
    if (modelLimits.has(stripped)) return modelLimits.get(stripped);
    return null;
}

function ensureSession(sid) {
    if (!sid) return null;
    let s = sessions.get(sid);
    if (!s) {
        s = new SessionState(sid);
        sessions.set(sid, s);
        activity("queue", `added sid=${sid.slice(-8)} (v2)`);
    }
    return s;
}

function updateDisplay() {
    for (const [sid, ss] of sessions) {
        if (ss.isActive()) { displayedID = sid; return; }
    }
    let latest = 0, pick = null;
    for (const [sid, ss] of sessions) {
        if (ss.lastActivity > latest) { latest = ss.lastActivity; pick = sid; }
    }
    displayedID = pick;
}

function setState(s, next, reason) {
    if (!s || s.state === next) return;
    const prev = s.state;
    s.state = next;
    activity("state", `sid=${s.sessionID.slice(-8)} ${prev} -> ${next} (${reason})`);
}

function push() {
    try {
        const st = readState();
        presenceEnabled = st.presenceEnabled;
        daemonStopped = st.daemonStopped;
    } catch {}
    const d = displayedID ? sessions.get(displayedID) ?? null : null;
    let rendered = null;
    try {
        rendered = renderPresence(d, config);
    } catch (e) {
        log(`render failed: ${e?.message || e}`);
        return;
    }
    pushPresence(rendered);
    if (rendered && presenceEnabled) sendStateToDaemon(d, rendered);
}

async function ensureDaemonAndConnect() {
    try {
        if (daemonStopped) {
            activity("daemon", "spawn suppressed: daemonStopped=true (run 'opencode-rpc spawn')");
            return false;
        }
        const running = await ensureDaemonRunning();
        if (!running) return false;
        return await ensureConnected();
    } catch (e) {
        log(`ensureDaemon: ${e?.message || e}`);
        return false;
    }
}

// Best-effort extraction across event shapes.
function infoOf(event) {
    return event?.properties?.info ?? event?.data?.info ?? event?.info ?? null;
}
function sidOf(event, info) {
    return (
        event?.properties?.sessionID ??
        event?.data?.sessionID ??
        event?.sessionID ??
        info?.sessionID ??
        null
    );
}

function applyAssistantMessage(sid, info) {
    if (!info || !sid) return;
    const s = ensureSession(sid);
    const modelID = info.modelID ?? info.model?.id ?? null;
    const providerID = info.providerID ?? info.model?.providerID ?? null;
    try {
        s.addOrUpdateMessage(
            info.id, info.cost, info.tokens,
            modelID, providerID,
            info.time?.completed, info.time?.created,
        );
    } catch (e) {
        log(`stats update failed: ${e?.message || e}`);
    }
    if (modelID) s.model = modelID;
    if (providerID) s.provider = providerID;
    if (info.mode) s.mode = info.mode;
    const lim = limitFor(s.model);
    if (lim) s.modelLimit = lim;
    s.lastActivity = Date.now();
}

async function refreshModelLimits(ctx) {
    try {
        const list = await ctx.model.list();
        const arr = Array.isArray(list) ? list : (list?.data ?? []);
        if (!Array.isArray(arr)) return;
        for (const m of arr) {
            const ctxLimit = m?.limit?.context;
            if (typeof ctxLimit !== "number" || ctxLimit <= 0) continue;
            const id = m?.id;
            const pid = m?.providerID;
            if (id) modelLimits.set(id, ctxLimit);
            if (pid && id) modelLimits.set(`${pid}/${id}`, ctxLimit);
        }
        activity("models", `loaded ${modelLimits.size} model limits (v2)`);
    } catch (e) {
        log(`model limits: ${e?.message || e}`);
    }
}

async function refreshSessionStats(ctx, sid) {
    try {
        const resp = await ctx.session.context({ sessionID: sid });
        const msgs = Array.isArray(resp) ? resp : (resp?.data ?? resp?.messages ?? null);
        if (!Array.isArray(msgs)) return;
        for (const m of msgs) {
            const info = m?.info ?? m;
            if (!info || info.role !== "assistant") continue;
            applyAssistantMessage(sid, info);
        }
    } catch {}
}

export default Plugin.define({
    id: "opencode-rich-presence-v2",
    async setup(ctx) {
        activity("load", `v2 plugin loaded dir=${ctx.location?.directory || "(none)"}`);
        config = await loadConfig();
        try {
            const st = readState();
            presenceEnabled = st.presenceEnabled;
            daemonStopped = st.daemonStopped;
        } catch {}
        activity("config", `appId=${config.appId} key=${config.largeImageKey} currency=${config.currency}`);
        activity("state", `presenceEnabled=${presenceEnabled} daemonStopped=${daemonStopped}`);

        await refreshModelLimits(ctx);
        startPresence();
        push();

        // Prompt admission == V1 chat.message: user sent something.
        await ctx.session.hook("prompt", (event) => {
            try {
                const sid = event?.sessionID ?? null;
                if (!sid) return;
                const s = ensureSession(sid);
                s.lastActivity = Date.now();
                s.promptCount++;
                setState(s, STATE.WORKING, "prompt");
                activity("event", `prompt sid=${sid.slice(-8)}`);
                updateDisplay();
                void ensureDaemonAndConnect().then(() => push());
                void (async () => {
                    try {
                        const info = await ctx.session.get({ sessionID: sid });
                        const data = info?.data ?? info;
                        if (data && typeof data === "object") {
                            // Authoritative totals, but only as backfill: per-message
                            // events own the accounting once they start arriving.
                            if (s._messageMap.size === 0) {
                                if (typeof data.cost === "number" && data.cost > 0) {
                                    s._cost = data.cost;
                                }
                                const tok = data.tokens;
                                if (tok && typeof tok === "object") {
                                    const ctxT = (tok.input || 0) + (tok.cache?.read || 0);
                                    if (ctxT > 0) s._latestContextTokens = ctxT;
                                }
                            }
                        }
                        const model = data?.model ?? data?.modelID;
                        if (typeof model === "string" && model) s.model = model;
                        else if (model?.id) {
                            s.model = model.id;
                            if (model.providerID) s.provider = model.providerID;
                        }
                        const agent = data?.agent ?? data?.agentID;
                        if (typeof agent === "string" && agent) { s.agent = agent; s.mode = agent; }
                        const lim = limitFor(s.model);
                        if (lim) s.modelLimit = lim;
                    } catch {}
                    push();
                })();
            } catch (e) {
                log(`prompt hook: ${e?.message || e}`);
            }
        });

        // Model-call context == agent loop is running: capture agent/model
        // (session.get does not expose them in V2).
        try {
            await ctx.session.hook("context", (event) => {
                try {
                    const sid = event?.sessionID ?? null;
                    if (!sid) return;
                    const s = sessions.get(sid);
                    if (!s) return;
                    const agent = event?.agent;
                    const agentName = typeof agent === "string" ? agent : agent?.name ?? agent?.id ?? null;
                    if (agentName) { s.agent = agentName; s.mode = agentName; }
                    const model = event?.model;
                    if (typeof model === "string" && model) s.model = model;
                    else if (model && typeof model === "object") {
                        if (model.id) {
                            s.model = model.providerID ? `${model.providerID}/${model.id}` : model.id;
                        }
                        if (model.providerID) s.provider = model.providerID;
                    }
                    const lim = limitFor(s.model);
                    if (lim) s.modelLimit = lim;
                    s.lastActivity = Date.now();
                    if (s.state === STATE.WAITING) setState(s, STATE.WORKING, "context");
                    updateDisplay();
                    push();
                } catch {}
            });
        } catch (e) {
            log(`context hook register: ${e?.message || e}`);
        }

        // Tool execution == agent is working.
        try {
            await ctx.tool.hook("execute.before", (event) => {
                try {
                    const sid = event?.sessionID ?? displayedID;
                    if (!sid) return;
                    const s = sessions.get(sid);
                    if (!s) return;
                    s.lastActivity = Date.now();
                    if (s.state !== STATE.ASKING) setState(s, STATE.WORKING, "tool.execute.before");
                    updateDisplay();
                    push();
                } catch {}
            });
        } catch (e) {
            log(`tool hook register: ${e?.message || e}`);
        }

        const controller = new AbortController();
        void (async () => {
            try {
                for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
                    try {
                        const type = event?.type;
                        if (!type) continue;
                        const info = infoOf(event);
                        const sid = sidOf(event, info);

                        if (type === "session.created" || type === "session.updated") {
                            if (!info?.id && !sid) continue;
                            const s = ensureSession(info?.id ?? sid);
                            if (info?.time?.created) s.startedAt = info.time.created;
                            s.lastActivity = Date.now();
                            activity("event", `${type} sid=${(info?.id ?? sid).slice(-8)}`);
                            updateDisplay();
                            push();
                        } else if (type === "session.deleted") {
                            const id = info?.id ?? sid;
                            if (!id) continue;
                            sessions.delete(id);
                            activity("event", `session.deleted sid=${id.slice(-8)}`);
                            updateDisplay();
                            push();
                        } else if (type === "session.idle" || type === "session.error") {
                            if (!sid) continue;
                            const s = sessions.get(sid);
                            if (!s) continue;
                            s.lastActivity = Date.now();
                            if (s.state !== STATE.ASKING) setState(s, STATE.WAITING, type);
                            updateDisplay();
                            push();
                        } else if (type === "session.status") {
                            if (!sid) continue;
                            const s = sessions.get(sid);
                            if (!s) continue;
                            const status = event?.properties?.status?.type ?? event?.data?.status?.type ?? null;
                            s.lastActivity = Date.now();
                            if (status === "idle" && s.state !== STATE.ASKING) setState(s, STATE.WAITING, "session.status idle");
                            else if (status === "busy" && s.state === STATE.WAITING) setState(s, STATE.WORKING, "session.status busy");
                            updateDisplay();
                            push();
                        } else if (type === "message.updated") {
                            if (!info || info.role !== "assistant" || !sid) continue;
                            const completed = !!info.time?.completed;
                            applyAssistantMessage(sid, info);
                            activity("event", `message.updated sid=${sid.slice(-8)} completed=${completed}`);
                            if (completed) {
                                const s = sessions.get(sid);
                                if (s) setState(s, STATE.WAITING, "message.updated completed");
                            }
                            updateDisplay();
                            push();
                        } else if (type === "permission.asked") {
                            if (!sid) continue;
                            const s = sessions.get(sid);
                            if (!s) continue;
                            s.lastActivity = Date.now();
                            setState(s, STATE.ASKING, "permission.asked");
                            updateDisplay();
                            push();
                        } else if (type === "permission.replied") {
                            if (!sid) continue;
                            const s = sessions.get(sid);
                            if (!s) continue;
                            s.lastActivity = Date.now();
                            setState(s, STATE.WORKING, "permission.replied");
                            updateDisplay();
                            push();
                        }
                    } catch (e) {
                        log(`event loop item: ${e?.message || e}`);
                    }
                }
            } catch (e) {
                if (e?.name !== "AbortError") log(`event loop: ${e?.message || e}`);
            }
        })();

        const timer = setInterval(() => {
            try {
                const st = readState();
                presenceEnabled = st.presenceEnabled;
                daemonStopped = st.daemonStopped;
            } catch {}
            const d = displayedID ? sessions.get(displayedID) : null;
            if (d) {
                void refreshSessionStats(ctx, d.sessionID).then(() => {
                    updateDisplay();
                    push();
                });
            }
        }, 5000);
        timer.unref?.();

        activity("load", "v2 plugin setup complete");

        return () => {
            try { controller.abort(); } catch {}
            try { clearInterval(timer); } catch {}
            try { stopPresence(); } catch {}
            activity("load", "v2 plugin unloaded");
        };
    },
});
