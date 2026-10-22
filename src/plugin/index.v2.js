// OpenCode V2 plugin entry for opencode-rich-presence.
//
// V2 has a different plugin API and a different public event model from V1.
// Keep this adapter separate from src/plugin/index.js, but share the session
// state, renderer, daemon, and configuration layers.

import { Plugin } from "@opencode/plugin";
import { unlinkSync } from "node:fs";
import { stat } from "node:fs/promises";
import { loadConfig } from "./config-resolver.js";
import { SessionState } from "./session-state.js";
import { STATE } from "../shared/constants.js";
import { activity, log } from "../shared/logger.js";
import { readState } from "../shared/presence-state.js";
import { DAEMON_PID_FILE, CONFIG_PATH, OPENCODE_DIR } from "../shared/paths.js";
import { join } from "node:path";
import {
    isDaemonAlive,
    isPidAlive,
    readDaemonPid,
    unlinkSocketPath,
} from "../shared/daemon-liveness.js";
import {
    renderPresence,
    pushPresence,
    startPresence,
    stopPresence,
    getDaemonClient,
    ensureConnected,
    sendStateToDaemon,
    disconnectFromDaemon,
} from "./local-presence.js";
import { ensureDaemonRunning } from "./daemon-spawner.js";

// All V2 locations in one OpenCode service share the daemon client. Keep the
// connection alive until the last V2 plugin setup is disposed.
let activePresenceUsers = 0;
let lastForwardedEnabled = null;
let sharedRuntime = null;
let sharedRuntimeRefs = 0;
let sharedController = null;
let sharedTimer = null;
let lastConfigMtime = 0;

function acquirePresence() {
    activePresenceUsers += 1;
    if (activePresenceUsers === 1) startPresence();
}

function releasePresence() {
    if (activePresenceUsers <= 0) return;
    activePresenceUsers -= 1;
    if (activePresenceUsers === 0) stopPresence();
}

function dataOf(event) {
    if (event?.data && typeof event.data === "object") return event.data;
    if (event?.properties && typeof event.properties === "object") return event.properties;
    return event || {};
}

function infoOf(event) {
    return event?.properties?.info ?? event?.data?.info ?? event?.info ?? null;
}

function sidOf(event) {
    const data = dataOf(event);
    const info = infoOf(event);
    return data.sessionID ?? event?.sessionID ?? info?.sessionID ?? info?.id ?? null;
}

function modelRefOf(value) {
    if (!value) return { id: null, providerID: null };
    if (typeof value === "string") {
        const slash = value.indexOf("/");
        if (slash > 0) {
            const providerID = value.slice(0, slash);
            const variant = value.indexOf("#", slash + 1);
            return {
                id: value.slice(slash + 1, variant === -1 ? undefined : variant),
                providerID,
            };
        }
        return { id: value, providerID: null };
    }
    const providerID = value.providerID ?? value.provider ?? null;
    let id = value.id ?? value.modelID ?? null;
    if (typeof id === "string") {
        const slash = id.indexOf("/");
        if (slash > 0) id = id.slice(slash + 1);
        const variant = id.indexOf("#");
        if (variant !== -1) id = id.slice(0, variant);
    }
    return { id, providerID };
}

function isAssistantMessage(info) {
    return info?.role === "assistant" || info?.type === "assistant";
}

function isUserMessage(info) {
    return info?.role === "user" || info?.type === "user";
}

function modelIDVariants(value) {
    if (typeof value !== "string" || !value) return [];
    const base = value.split("#", 1)[0];
    const parts = base.split("/");
    const variants = [];
    for (let i = 0; i < parts.length; i += 1) {
        const candidate = parts.slice(i).join("/");
        if (candidate && !variants.includes(candidate)) variants.push(candidate);
    }
    return variants;
}

async function ensureDaemonAndConnect(daemonStopped) {
    const c = getDaemonClient();
    if (isDaemonAlive()) {
        const ok = await ensureConnected();
        if (ok) {
            const caps = await c.waitForHelloAck();
            if (Array.isArray(caps) && caps.includes("set-enabled")) return true;
            activity("daemon", `stale daemon detected (capabilities=${JSON.stringify(caps)}); recycling`);
            await recycleDaemon();
            const respawned = await ensureDaemonRunning();
            if (!respawned) return false;
            return await ensureConnected();
        }
        try { unlinkSync(DAEMON_PID_FILE); } catch {}
        unlinkSocketPath();
    }
    if (daemonStopped) {
        activity("daemon", "spawn suppressed: daemonStopped=true (run 'opencode-rpc spawn')");
        return false;
    }
    const spawned = await ensureDaemonRunning();
    if (!spawned) return false;
    return await ensureConnected();
}

async function connectExistingDaemon() {
    if (!isDaemonAlive()) return false;
    // A V2 service restart should reconnect to an already-running daemon,
    // but must not change the established first-prompt spawn behavior when
    // no daemon exists yet.
    return await ensureDaemonAndConnect(true);
}

async function recycleDaemon() {
    disconnectFromDaemon();
    let pid = readDaemonPid();
    if (pid !== null) {
        try { process.kill(pid, "SIGTERM"); } catch {}
        const start = Date.now();
        while (Date.now() - start < 2000) {
            if (!isPidAlive(pid)) { pid = null; break; }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (pid !== null) {
            try { process.kill(pid, "SIGKILL"); } catch {}
            await new Promise((resolve) => setTimeout(resolve, 150));
        }
    }
    try { unlinkSync(DAEMON_PID_FILE); } catch {}
    unlinkSocketPath();
}

function createRuntime(ctx, loadedConfig) {
    const sessions = new Map();
    const modelLimits = new Map();
    let displayedID = null;
    let config = loadedConfig;
    let presenceEnabled = true;
    let daemonStopped = false;

    function limitFor(modelID) {
        if (!modelID) return null;
        for (const candidate of modelIDVariants(modelID)) {
            if (modelLimits.has(candidate)) return modelLimits.get(candidate);
        }
        return null;
    }

    function ensureSession(sid) {
        if (!sid) return null;
        let session = sessions.get(sid);
        if (!session) {
            session = new SessionState(sid);
            session._promptIDs = new Set();
            session._userPromptIDs = new Set();
            session._assistantPromptIDs = new Set();
            sessions.set(sid, session);
            activity("queue", `added sid=${sid.slice(-8)} (v2)`);
        }
        return session;
    }

    function touch(session, timestamp = Date.now()) {
        if (!session) return;
        const value = Number(timestamp);
        session.lastActivity = Math.max(session.lastActivity || 0, Number.isFinite(value) ? value : Date.now());
    }

    function setState(session, next, reason) {
        if (!session || session.state === next) return false;
        const previous = session.state;
        session.state = next;
        activity("state", `sid=${session.sessionID.slice(-8)} ${previous} -> ${next} (${reason})`);
        return true;
    }

    function applyModel(session, ref) {
        const model = modelRefOf(ref);
        if (model.id) session.model = model.id;
        if (model.providerID) session.provider = model.providerID;
        const limit = limitFor(session.model) ?? limitFor(model.id);
        if (limit) session.modelLimit = limit;
    }

    function applyModelLimit(session, ref) {
        if (!session) return;
        const model = modelRefOf(ref);
        const candidates = [
            model.id,
            ref?.id,
            ref?.modelID,
            typeof ref === "string" ? ref : null,
            session.model,
        ];
        for (const candidate of candidates) {
            const limit = limitFor(candidate);
            if (limit) {
                session.modelLimit = limit;
                return;
            }
        }
    }

    function applyAgent(session, agent) {
        const name = typeof agent === "string" ? agent : agent?.id ?? agent?.name ?? null;
        if (name) {
            session.agent = name;
            session.mode = name;
        }
    }

    function applyUsage(session, cost, tokens) {
        if (!session) return;
        if (typeof cost !== "number" && !tokens) return;
        session.setUsageTotals(typeof cost === "number" ? cost : session.cost, tokens || {});
    }

    function addPrompt(session, messageID) {
        if (!session) return;
        const key = messageID ? String(messageID) : `anonymous:${session.promptCount}:${Date.now()}`;
        if (session._promptIDs.has(key)) return;
        session._promptIDs.add(key);
        session.promptCount += 1;
    }

    function reconcilePromptCount(session) {
        if (!session) return;
        // V2 context normally omits user records. Assistant messages are the
        // same prompt proxy used by the V1 restore path, so use them only
        // when no user prompt records are available.
        const observed = session._userPromptIDs.size > 0
            ? session._userPromptIDs.size
            : session._assistantPromptIDs.size;
        if (observed > session.promptCount) session.promptCount = observed;
    }

    function applyAssistantMessage(sid, info, eventTime) {
        if (!sid || !isAssistantMessage(info)) return null;
        const session = ensureSession(sid);
        const model = modelRefOf(info.model ?? info.modelID);
        const messageID = info.id;
        const time = info.time || {};
        if (messageID) session._assistantPromptIDs.add(String(messageID));
        try {
            session.addOrUpdateMessage(
                messageID,
                info.cost,
                info.tokens,
                model.id,
                model.providerID,
                time.completed,
                time.created,
            );
        } catch (error) {
            log(`stats update failed: ${error?.message || error}`);
        }
        applyModel(session, info.model ?? info.modelID);
        applyAgent(session, info.agent ?? info.agentID);
        if (info.mode) session.mode = info.mode;
        reconcilePromptCount(session);
        touch(session, time.completed || time.created || eventTime);
        return session;
    }

    function syncSessionInfo(info, fallbackSID, eventTime) {
        if (!info && !fallbackSID) return null;
        const sid = info?.id ?? info?.sessionID ?? fallbackSID;
        const session = ensureSession(sid);
        if (!session) return null;
        if (info?.time?.created) session.startedAt = info.time.created;
        touch(session, info?.time?.updated || eventTime);
        applyModel(session, info?.model ?? info?.modelID);
        applyAgent(session, info?.agent ?? info?.agentID);
        applyUsage(session, info?.cost, info?.tokens);
        return session;
    }

    function updateDisplay() {
        const active = [...sessions.entries()]
            .filter(([, session]) => session.isActive())
            .sort((a, b) => (b[1].lastActivity || 0) - (a[1].lastActivity || 0));
        if (active.length) {
            displayedID = active[0][0];
            return;
        }
        const latest = [...sessions.entries()]
            .sort((a, b) => (b[1].lastActivity || 0) - (a[1].lastActivity || 0));
        displayedID = latest[0]?.[0] ?? null;
    }

    function logDisplayChange(previous, reason) {
        if (previous === displayedID) return;
        activity(
            "display",
            `sid=${previous?.slice(-8) || "(none)"} -> ${displayedID?.slice(-8) || "(none)"} (${reason})`,
        );
    }

    function forwardEnabled(enabled) {
        if (enabled === lastForwardedEnabled) return true;
        try {
            const client = getDaemonClient();
            if (!client.isConnected()) {
                activity("push", `set-enabled forward skipped (not connected): ${enabled}`);
                return false;
            }
            const ok = client.send({ type: "set-enabled", enabled });
            if (ok) lastForwardedEnabled = enabled;
            activity(
                "push",
                ok
                    ? `forwarded set-enabled=${enabled} to daemon`
                    : `set-enabled forward failed: ${client.lastError || "not connected"}`,
            );
            return ok;
        } catch (error) {
            log(`set-enabled forward: ${error?.message || error}`);
            return false;
        }
    }

    function push() {
        try {
            const state = readState();
            presenceEnabled = state.presenceEnabled;
            daemonStopped = state.daemonStopped;
        } catch {}
        const session = displayedID ? sessions.get(displayedID) ?? null : null;
        let rendered = null;
        try {
            rendered = renderPresence(session, config);
        } catch (error) {
            log(`render failed: ${error?.message || error}`);
            return;
        }
        pushPresence(rendered);
        forwardEnabled(presenceEnabled);
        if (rendered && presenceEnabled) sendStateToDaemon(session, rendered);
    }

    function commit(reason, shouldPush = true) {
        const previous = displayedID;
        updateDisplay();
        logDisplayChange(previous, reason);
        if (shouldPush) push();
    }

    async function refreshModelLimits(sourceCtx = ctx) {
        try {
            const list = await sourceCtx.model.list();
            const models = Array.isArray(list) ? list : list?.data ?? [];
            if (!Array.isArray(models)) return;
            for (const model of models) {
                const limit = model?.limit?.context;
                if (typeof limit !== "number" || limit <= 0) continue;
                const rawID = model.modelID ?? model.id;
                const provider = model.providerID;
                if (rawID) {
                    for (const candidate of modelIDVariants(rawID)) modelLimits.set(candidate, limit);
                }
                if (provider && rawID) {
                    for (const candidate of modelIDVariants(rawID)) {
                        modelLimits.set(`${provider}/${candidate}`, limit);
                    }
                }
            }
            activity("models", `loaded ${modelLimits.size} model limits (v2)`);
        } catch (error) {
            log(`model limits: ${error?.message || error}`);
        }
        // Fallback: read custom model limits from opencode.jsonc directly.
        // ctx.model.list() may not include custom models defined in the config,
        // so we parse the config file as a second source of truth.
        try {
            const { readFile } = await import("node:fs/promises");
            const candidates = [
                join(OPENCODE_DIR, "opencode.jsonc"),
                join(OPENCODE_DIR, "opencode.json"),
            ];
            for (const cfgPath of candidates) {
                try {
                    let raw = await readFile(cfgPath, "utf-8");
                    // Strip // and /* */ comments for JSONC files
                    raw = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
                    const cfg = JSON.parse(raw);
                    const providers = cfg.providers || {};
                    for (const [pid, prov] of Object.entries(providers)) {
                        const models = prov.models || {};
                        for (const [mid, mdef] of Object.entries(models)) {
                            const limit = mdef?.limit?.context;
                            if (typeof limit !== "number" || limit <= 0) continue;
                            for (const candidate of modelIDVariants(mid)) {
                                if (!modelLimits.has(candidate)) modelLimits.set(candidate, limit);
                            }
                            for (const candidate of modelIDVariants(mid)) {
                                const pk = `${pid}/${candidate}`;
                                if (!modelLimits.has(pk)) modelLimits.set(pk, limit);
                            }
                        }
                    }
                    activity("models", `config fallback loaded, total ${modelLimits.size} model limits`);
                    break;
                } catch {}
            }
        } catch {}
    }

    async function refreshSessionStats(sid, sourceCtx = ctx) {
        const session = ensureSession(sid);
        if (!session) return;
        try {
            const response = await sourceCtx.session.get({ sessionID: sid });
            const info = response?.data ?? response;
            syncSessionInfo(info, sid);
        } catch (error) {
            log(`session.get(${sid}): ${error?.message || error}`);
        }

        try {
            const response = await sourceCtx.session.context({ sessionID: sid });
            const messages = Array.isArray(response) ? response : response?.data ?? response?.messages ?? [];
            if (!Array.isArray(messages)) return;
            let latest = null;
            for (const item of messages) {
                const info = item?.info ?? item;
                if (!info) continue;
                if (isUserMessage(info)) {
                    if (info.id) session._userPromptIDs.add(String(info.id));
                    addPrompt(session, info.id);
                    latest = info;
                    continue;
                }
                if (isAssistantMessage(info)) {
                    applyAssistantMessage(sid, info);
                    latest = info;
                }
            }
            if (isUserMessage(latest)) {
                setState(session, STATE.WORKING, "poll: latest is user message");
            } else if (isAssistantMessage(latest)) {
                if (latest.time?.completed) setState(session, STATE.WAITING, "poll: assistant message completed");
                else setState(session, STATE.TYPING, "poll: assistant message in progress");
            }
        } catch (error) {
            log(`session.context(${sid}): ${error?.message || error}`);
        }
    }

    async function restoreSessions(sourceCtx = ctx) {
        try {
            const response = await sourceCtx.session.list({ directory: sourceCtx.location?.directory, limit: 50, order: "desc" });
            const list = Array.isArray(response) ? response : response?.data ?? [];
            if (!Array.isArray(list)) return;
            for (const info of list) syncSessionInfo(info, info?.id);
            updateDisplay();
            const latest = displayedID;
            if (latest) await refreshSessionStats(latest, sourceCtx);
            commit("v2 restore");
            activity("restore", `completed: ${sessions.size} sessions restored (v2)`);
        } catch (error) {
            log(`restore v2: ${error?.message || error}`);
        }
    }

    function applyStepUsage(session, data, eventTime, syntheticPrefix = "step") {
        if (!session || !data) return;
        const id = data.assistantMessageID ? `${syntheticPrefix}:${data.assistantMessageID}` : `${syntheticPrefix}:${eventTime}`;
        try {
            session.addOrUpdateMessage(id, data.cost, data.tokens, session.model, session.provider, eventTime, data.started || eventTime);
        } catch (error) {
            log(`step stats failed: ${error?.message || error}`);
        }
        if (data.cost !== undefined || data.tokens) {
            activity(
                "stats",
                `sid=${session.sessionID.slice(-8)} cost=$${session.cost.toFixed(4)} ctx=${session.contextTokens} (${session.contextPercent.toFixed(1)}%)`,
            );
        }
    }

    async function handleEvent(event) {
        const type = event?.type;
        if (!type) return;
        const data = dataOf(event);
        const sid = sidOf(event);
        const eventTime = event?.created || Date.now();

        if (type === "session.created") {
            const session = syncSessionInfo(data, sid, eventTime);
            if (session) activity("event", `session.created sid=${session.sessionID.slice(-8)}`);
            commit(type);
            return;
        }

        if (type === "session.updated") {
            const session = syncSessionInfo(infoOf(event), sid, eventTime);
            if (session) activity("event", `session.updated sid=${session.sessionID.slice(-8)}`);
            commit(type);
            return;
        }

        if (type === "session.deleted") {
            if (!sid) return;
            sessions.delete(sid);
            activity("event", `session.deleted sid=${sid.slice(-8)}`);
            commit(type);
            return;
        }

        if (type === "location.shutdown") {
            activity("event", "location.shutdown, clearing presence");
            sessions.clear();
            stopPresence();
            return;
        }

        if (type === "session.agent.selected") {
            const session = ensureSession(sid);
            if (!session) return;
            applyAgent(session, data.agent);
            touch(session, eventTime);
            commit(type);
            return;
        }

        if (type === "session.model.selected") {
            const session = ensureSession(sid);
            if (!session) return;
            applyModel(session, data.model);
            touch(session, eventTime);
            commit(type);
            return;
        }

        if (type === "session.execution.started") {
            const session = ensureSession(sid);
            if (!session) return;
            touch(session, eventTime);
            setState(session, STATE.WORKING, type);
            activity("event", `${type} sid=${sid.slice(-8)}`);
            commit(type);
            void refreshSessionStats(sid).then(() => commit(`${type} stats`));
            return;
        }

        if (type === "session.execution.succeeded" || type === "session.execution.failed" || type === "session.execution.interrupted") {
            const session = ensureSession(sid);
            if (!session) return;
            touch(session, eventTime);
            if (session.state !== STATE.ASKING) setState(session, STATE.WAITING, type);
            activity("event", `${type} sid=${sid.slice(-8)}`);
            commit(type);
            void refreshSessionStats(sid).then(() => commit(`${type} stats`));
            return;
        }

        if (type === "session.step.started") {
            const session = ensureSession(sid);
            if (!session) return;
            applyModel(session, data.model);
            applyModelLimit(session, data.model);
            applyAgent(session, data.agent);
            touch(session, data.started || eventTime);
            if (session.state !== STATE.ASKING) setState(session, STATE.THINKING, type);
            activity("event", `${type} sid=${sid.slice(-8)} model=${session.model}`);
            commit(type);
            return;
        }

        if (type === "session.step.streamed") {
            const session = ensureSession(sid);
            if (!session) return;
            touch(session, eventTime);
            if (session.state !== STATE.ASKING) setState(session, STATE.TYPING, type);
            commit(type);
            return;
        }

        if (type === "session.step.ended" || type === "session.step.failed") {
            const session = ensureSession(sid);
            if (!session) return;
            touch(session, eventTime);
            applyStepUsage(session, data, eventTime);
            if (session.state !== STATE.ASKING) setState(session, STATE.WORKING, type);
            activity("event", `${type} sid=${sid.slice(-8)} finish=${data.finish || data.rawFinish || "error"}`);
            commit(type);
            return;
        }

        if (type === "session.text.started" || type === "session.text.ended") {
            const session = ensureSession(sid);
            if (!session) return;
            touch(session, eventTime);
            if (session.state !== STATE.ASKING) setState(session, STATE.TYPING, type);
            commit(type);
            return;
        }

        if (type === "session.text.delta") {
            const session = ensureSession(sid);
            if (!session) return;
            touch(session, eventTime);
            if (session.state !== STATE.ASKING) setState(session, STATE.TYPING, type);
            return;
        }

        if (type === "session.reasoning.started" || type === "session.reasoning.ended" || type === "session.reasoning.delta") {
            const session = ensureSession(sid);
            if (!session) return;
            touch(session, eventTime);
            if (session.state !== STATE.ASKING) setState(session, STATE.THINKING, type);
            if (type !== "session.reasoning.delta") commit(type);
            return;
        }

        if (type.startsWith("session.tool.")) {
            const session = ensureSession(sid);
            if (!session) return;
            touch(session, eventTime);
            if (session.state !== STATE.ASKING) setState(session, STATE.WORKING, type);
            if (!type.endsWith(".progress") && !type.endsWith(".input.delta")) commit(type);
            return;
        }

        if (type === "session.retry.scheduled") {
            const session = ensureSession(sid);
            if (!session) return;
            touch(session, eventTime);
            if (session.state !== STATE.ASKING) setState(session, STATE.WORKING, type);
            activity("event", `${type} sid=${sid.slice(-8)} attempt=${data.attempt ?? "?"}`);
            commit(type);
            return;
        }

        if (type === "session.compaction.started") {
            const session = ensureSession(sid);
            if (!session) return;
            session.mode = "compaction";
            touch(session, eventTime);
            if (session.state !== STATE.ASKING) setState(session, STATE.WORKING, type);
            commit(type);
            return;
        }

        if (type === "session.compaction.ended" || type === "session.compaction.failed") {
            const session = ensureSession(sid);
            if (!session) return;
            touch(session, eventTime);
            applyStepUsage(session, data, eventTime, "compaction");
            if (type.endsWith("failed") && session.state !== STATE.ASKING) setState(session, STATE.WAITING, type);
            activity("event", `${type} sid=${sid.slice(-8)}`);
            commit(type);
            return;
        }

        if (type === "session.usage.updated") {
            const session = ensureSession(sid);
            if (!session) return;
            applyUsage(session, data.cost, data.tokens);
            touch(session, eventTime);
            activity("stats", `sid=${sid.slice(-8)} usage cost=$${session.cost.toFixed(4)} ctx=${session.contextTokens} (${session.contextPercent.toFixed(1)}%)`);
            commit(type);
            return;
        }

        if (type === "session.status" || type === "session.idle") {
            const session = ensureSession(sid);
            if (!session) return;
            const status = data.status?.type ?? (type === "session.idle" ? "idle" : null);
            touch(session, eventTime);
            activity("event", `${type} sid=${sid.slice(-8)} status=${status || "(none)"}`);
            if (status === "idle" && session.state !== STATE.ASKING) setState(session, STATE.WAITING, type);
            else if ((status === "busy" || status === "retry") && session.state !== STATE.ASKING) setState(session, STATE.WORKING, type);
            commit(type);
            return;
        }

        // Compatibility events still appear on some V2 builds and are cheap
        // to support. Normalize their V1 payloads through the same path.
        if (type === "message.updated") {
            const info = infoOf(event);
            const session = applyAssistantMessage(sid, info, eventTime);
            if (!session) return;
            if (info.time?.completed) setState(session, STATE.WAITING, type);
            activity("event", `${type} sid=${sid.slice(-8)} completed=${!!info.time?.completed}`);
            commit(type);
            return;
        }

        if (type === "message.part.updated") {
            const part = event?.properties?.part ?? event?.data?.part;
            const session = ensureSession(part?.sessionID ?? sid);
            if (!session) return;
            touch(session, eventTime);
            if (part?.type === "reasoning") setState(session, STATE.THINKING, type);
            else if (part?.type === "text") setState(session, STATE.TYPING, type);
            else if (part?.type === "tool") setState(session, STATE.WORKING, type);
            commit(type);
            return;
        }

        if (type === "permission.asked" || type === "permission.replied") {
            const session = ensureSession(sid);
            if (!session) return;
            touch(session, eventTime);
            if (type === "permission.asked") setState(session, STATE.ASKING, type);
            else setState(session, STATE.WORKING, type);
            commit(type);
        }
    }

    return {
        get config() { return config; },
        get presenceEnabled() { return presenceEnabled; },
        get daemonStopped() { return daemonStopped; },
        ensureSession,
        addPrompt,
        applyModel,
        applyAgent,
        setState,
        touch,
        updateDisplay,
        push,
        commit,
        refreshModelLimits,
        refreshSessionStats,
        restoreSessions,
        handleEvent,
        getDisplayedSession() {
            return displayedID ? sessions.get(displayedID) ?? null : null;
        },
        setConfig(value) { config = value; },
        readControlState() {
            try {
                const state = readState();
                presenceEnabled = state.presenceEnabled;
                daemonStopped = state.daemonStopped;
            } catch {}
        },
        async ensureDaemon() {
            return ensureDaemonAndConnect(daemonStopped);
        },
        async connectExistingDaemon() {
            return connectExistingDaemon();
        },
    };
}

export default Plugin.define({
    id: "opencode-rich-presence-v2",
    async setup(ctx) {
        const isFirstRuntime = !sharedRuntime;
        if (isFirstRuntime) {
            const config = await loadConfig();
            sharedRuntime = createRuntime(ctx, config);
            sharedRuntimeRefs = 0;
        }
        const runtime = sharedRuntime;
        sharedRuntimeRefs += 1;
        runtime.readControlState();
        acquirePresence();

        activity("load", `v2 plugin loaded dir=${ctx.location?.directory || "(none)"}`);
        activity("config", `appId=${runtime.config?.appId || "?"} key=${runtime.config?.largeImageKey || "?"} currency=${runtime.config?.currency || "?"}`);
        activity("state", `presenceEnabled=${runtime.presenceEnabled} daemonStopped=${runtime.daemonStopped}`);

        if (isFirstRuntime) {
            await runtime.refreshModelLimits(ctx);
            runtime.push();
            void runtime.connectExistingDaemon().then(() => runtime.push());
            void runtime.restoreSessions(ctx);
        }

        const promptHook = await ctx.session.hook("prompt", (event) => {
            try {
                const sid = event?.sessionID;
                if (!sid) return;
                const session = runtime.ensureSession(sid);
                runtime.addPrompt(session, event?.messageID);
                runtime.touch(session);
                runtime.setState(session, STATE.WORKING, "prompt");
                activity("event", `prompt sid=${sid.slice(-8)}`);
                runtime.updateDisplay();
                void runtime.ensureDaemon().then(() => runtime.push());
                void runtime.refreshSessionStats(sid).then(() => runtime.commit("prompt stats"));
            } catch (error) {
                log(`prompt hook: ${error?.message || error}`);
            }
        });

        const contextHook = await ctx.session.hook("context", (event) => {
            try {
                const sid = event?.sessionID;
                if (!sid) return;
                const session = runtime.ensureSession(sid);
                runtime.applyAgent(session, event?.agent);
                runtime.applyModel(session, event?.model);
                runtime.touch(session);
                if (session.state === STATE.WAITING) runtime.setState(session, STATE.WORKING, "context");
                runtime.commit("context");
                void runtime.refreshSessionStats(sid).then(() => runtime.commit("context stats", false));
            } catch (error) {
                log(`context hook: ${error?.message || error}`);
            }
        });

        const toolHook = await ctx.tool.hook("execute.before", (event) => {
            try {
                const sid = event?.sessionID;
                if (!sid) return;
                const session = runtime.ensureSession(sid);
                runtime.touch(session);
                if (session.state !== STATE.ASKING) runtime.setState(session, STATE.WORKING, "tool.execute.before");
                runtime.commit("tool.execute.before");
            } catch (error) {
                log(`tool hook: ${error?.message || error}`);
            }
        });

        if (isFirstRuntime) {
            sharedController = new AbortController();
            void (async () => {
                try {
                    for await (const event of ctx.event.subscribe({ signal: sharedController.signal })) {
                        try {
                            await runtime.handleEvent(event);
                        } catch (error) {
                            log(`event loop item: ${error?.message || error}`);
                        }
                    }
                } catch (error) {
                    if (error?.name !== "AbortError") log(`event loop: ${error?.message || error}`);
                }
            })();

            sharedTimer = setInterval(() => {
                runtime.readControlState();
                void (async () => {
                    try {
                        const st = await stat(CONFIG_PATH);
                        if (st.mtimeMs !== lastConfigMtime) {
                            lastConfigMtime = st.mtimeMs;
                            const newConfig = await loadConfig();
                            Object.assign(runtime.config, newConfig);
                            activity("config", "reloaded discord-config.json");
                            runtime.push();
                        }
                    } catch {}
                })();
                runtime.push();
                const session = runtime.getDisplayedSession();
                // The public V2 event stream is authoritative, but this fallback
                // repairs a missed event and reconciles a service reconnect.
                if (session && session.state !== STATE.WAITING) {
                    void runtime.refreshSessionStats(session.sessionID, ctx).then(() => runtime.commit("periodic stats", false));
                }
            }, 5000);
            sharedTimer.unref?.();
        }

        activity("load", "v2 plugin setup complete");

        let cleaned = false;
        return async () => {
            if (cleaned) return;
            cleaned = true;
            try { await promptHook?.dispose?.(); } catch {}
            try { await contextHook?.dispose?.(); } catch {}
            try { await toolHook?.dispose?.(); } catch {}
            activity("load", "v2 plugin unloaded");
            releasePresence();
            sharedRuntimeRefs -= 1;
            if (sharedRuntimeRefs <= 0) {
                try { sharedController?.abort(); } catch {}
                try { if (sharedTimer) clearInterval(sharedTimer); } catch {}
                sharedController = null;
                sharedTimer = null;
                sharedRuntime = null;
                sharedRuntimeRefs = 0;
                lastForwardedEnabled = null;
            }
        };
    },
});
