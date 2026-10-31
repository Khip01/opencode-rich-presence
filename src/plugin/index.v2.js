// OpenCode V2 plugin entry for opencode-rich-presence.
//
// V2 has a different plugin API and a different public event model from V1.
// Keep this adapter separate from src/plugin/index.js, but share the session
// state, renderer, daemon, and configuration layers.

import { statSync, unlinkSync } from "node:fs";
import { stat } from "node:fs/promises";
import { loadConfig } from "./config-resolver.js";
import { SessionState } from "./session-state.js";
import { STATE } from "../shared/constants.js";
import { activity, log } from "../shared/logger.js";
import { readState } from "../shared/presence-state.js";
import { DAEMON_PID_FILE, CONFIG_PATH, OPENCODE_DIR, CLIENT_HEARTBEAT } from "../shared/paths.js";
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
import {
    extractModelReference,
    findModelInfo,
    modelReferenceFromInfo,
    rememberModelInfo,
    resolveEffort,
} from "./model-effort.js";

// `Plugin.define` from the `@opencode/plugin` SDK is a pure identity
// function (`define(def) { return def; }`). It is inlined here so the
// package ships zero runtime dependencies: a fresh `npm install -g`
// resolves nothing and cannot be broken by upstream dependency churn
// (the `@opencode/plugin@2.2.0` peer set crashed npm 10.8.x installs;
// see docs/TROUBLESHOOTING.md).
const Plugin = { define(def) { return def; } };

// All V2 locations in one OpenCode service share the daemon client. Keep the
// connection alive until the last V2 plugin setup is disposed.
let activePresenceUsers = 0;
let lastForwardedEnabled = null;
let sharedRuntime = null;
let sharedRuntimeRefs = 0;
let sharedController = null;
let sharedTimer = null;
let lastConfigMtime = 0;
// The V2 event stream is owned by one setup ctx at a time. A location
// shutdown can end that stream silently (the for-await just returns), so
// the loop must be restartable with a surviving ctx. The token invalidates
// an older loop when a new one takes over.
let sharedSubscribeCtx = null;
const liveCtxs = new Set();
let eventLoopToken = 0;
// No native event traffic for this long while a guard is active means the
// terminal event was lost; release the guard and let polling reconcile.
const STUCK_GUARD_MS = 2 * 60 * 1000;

// Client heartbeat staleness. The TUI plugin part touches CLIENT_HEARTBEAT
// every 10s while a client window is open; no touch for this long means the
// last window is gone and the presence should clear. Overridable via env so
// tests do not wait.
const CLIENT_TIMEOUT_MS = 30 * 1000;

function clientTimeoutMs() {
    const value = Number(process.env.ORP_CLIENT_TIMEOUT_MS);
    return Number.isFinite(value) && value > 0 ? value : CLIENT_TIMEOUT_MS;
}

function sleep(ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}

// Keep one shared event subscription alive for the whole service. If the
// stream ends or errors (location shutdown, service restart), resubscribe
// with backoff instead of silently losing every native execution event.
// Losing those events is what strands a session in Working: the execution
// guard waits for a terminal event that will never arrive.
function restartEventLoop(ctx) {
    sharedSubscribeCtx = ctx;
    eventLoopToken += 1;
    const token = eventLoopToken;
    try { sharedController?.abort(); } catch {}
    sharedController = new AbortController();
    const controller = sharedController;
    void (async () => {
        let delay = 1000;
        while (!controller.signal.aborted && token === eventLoopToken) {
            try {
                const source = sharedSubscribeCtx ?? [...liveCtxs].at(-1);
                if (!source?.event?.subscribe) {
                    await sleep(delay);
                    continue;
                }
                for await (const event of source.event.subscribe({ signal: controller.signal })) {
                    delay = 1000;
                    try {
                        await sharedRuntime?.handleEvent(event);
                    } catch (error) {
                        log(`event loop item: ${error?.message || error}`);
                    }
                }
                // A clean end is still a dead stream: resubscribe.
                if (controller.signal.aborted || token !== eventLoopToken) return;
                activity("event", "event stream ended, resubscribing");
            } catch (error) {
                if (controller.signal.aborted || token !== eventLoopToken) return;
                log(`event loop: ${error?.message || error}`);
                activity("event", `event stream failed, resubscribing in ${delay}ms`);
            }
            await sleep(delay);
            delay = Math.min(delay * 2, 30000);
        }
    })();
}

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
    return extractModelReference(value);
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
    const modelCatalog = new Map();
    let displayedID = null;
    let config = loadedConfig;
    let presenceEnabled = true;
    let daemonStopped = false;
    // True while the auto-clear policy is hiding the presence (every client
    // window closed and nothing running). Pushes resume on the first sign
    // of a client or work.
    let presenceSuppressed = false;

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
            session._fullCountDone = false;
            // Polling session.context() can return the assistant message from
            // the previous prompt while a new execution is starting. Keep a
            // small execution guard so that stale history cannot overwrite
            // the native V2 event state with Waiting for command.
            session._executionGeneration = 0;
            session._executionPending = false;
            session._executionActive = false;
            session._promptAt = 0;
            session._executionStartedAt = 0;
            // Server-side "session became idle" timestamp from session.get().
            // Only stamped when the session really goes idle, so it is solid
            // evidence that a guarded execution has finished even when the
            // terminal event never arrived (see refreshSessionStats).
            session._serverIdleAt = 0;
            // Last time a native execution event touched this session. Used
            // as a watchdog: a guard with no event traffic at all is stuck.
            session._lastNativeEventAt = 0;
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

    function eventTimestamp(value, fallback = Date.now()) {
        const timestamp = Number(value);
        return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : fallback;
    }

    function markPromptPending(session, timestamp = Date.now()) {
        if (!session) return;
        session._executionGeneration += 1;
        session._executionPending = true;
        session._executionActive = false;
        session._promptAt = eventTimestamp(timestamp);
        session._executionStartedAt = 0;
    }

    function markExecutionStarted(session, timestamp = Date.now()) {
        if (!session) return;
        session._executionGeneration += 1;
        session._executionPending = false;
        session._executionActive = true;
        session._executionStartedAt = eventTimestamp(timestamp);
        if (!session._promptAt) session._promptAt = session._executionStartedAt;
    }

    function markExecutionFinished(session, timestamp = Date.now()) {
        if (!session) return;
        // Incrementing the generation invalidates refreshSessionStats() calls
        // that were started before the terminal event and finish afterward.
        session._executionGeneration += 1;
        session._executionPending = false;
        session._executionActive = false;
        session._promptAt = 0;
        session._executionStartedAt = 0;
        session._executionFinishedAt = eventTimestamp(timestamp);
    }

    function executionGuarded(session) {
        return !!(session?._executionPending || session?._executionActive);
    }

    function markNativeEvent(session, timestamp = Date.now()) {
        if (!session) return;
        // Monotonic: a stale server timestamp must not erase fresher event
        // activity (the watchdog reads this as "last time anything moved").
        const value = eventTimestamp(timestamp);
        session._lastNativeEventAt = Math.max(session._lastNativeEventAt || 0, value);
    }

    // Watchdog timeout. Overridable via env so tests do not wait minutes.
    function stuckGuardMs() {
        const value = Number(process.env.ORP_STUCK_GUARD_MS);
        return Number.isFinite(value) && value > 0 ? value : STUCK_GUARD_MS;
    }

    // Watchdog: a guard is only meaningful while activity keeps coming in
    // (native events, server message updates, the prompt itself). If nothing
    // has moved for a long time, the terminal event was lost (typically a
    // dead event stream) and the guard must not freeze the presence.
    function guardStuckTooLong(session) {
        if (!executionGuarded(session)) return false;
        const guardSetAt = Math.max(session._promptAt || 0, session._executionStartedAt || 0);
        const evidence = Math.max(
            session._lastNativeEventAt || 0,
            session._serverIdleAt || 0,
            guardSetAt,
        );
        return evidence > 0 && Date.now() - evidence > stuckGuardMs();
    }

    // Recover from a lost terminal execution event (dead event stream,
    // missed session.execution.succeeded). Returns true when a stuck guard
    // was released and the state was decided here.
    //
    // All evidence comes from the context/server APIs, which keep working
    // even when the event stream dies (the failure mode that leaves the
    // presence frozen on Working):
    // - Rule 1: the assistant answer for this turn is complete and the
    //   server stamped the session idle after that completion.
    // - Rule 2 (watchdog): the guard has seen no activity for
    //   STUCK_GUARD_MS and the server reports idle after the turn started
    //   without any in-progress answer (aborted/failed turn).
    // Both rules require the idle proof, so a long-running tool (which only
    // stamps stale idle) never triggers a false Completed state.
    function tryRecoverFromLostTerminalEvent(session, latest) {
        if (!executionGuarded(session) || session.state === STATE.ASKING) return false;
        const guardSetAt = Math.max(session._promptAt || 0, session._executionStartedAt || 0);
        const completedAt = isAssistantMessage(latest) && latest.time?.completed
            ? eventTimestamp(latest.time.completed, 0)
            : 0;
        const createdAt = latest?.time?.created
            ? eventTimestamp(latest.time.created, 0)
            : 0;
        const idleAt = session._serverIdleAt || 0;
        const turnFinished = completedAt > 0 && (!guardSetAt || completedAt >= guardSetAt);
        const turnInProgress = isAssistantMessage(latest) && !latest.time?.completed
            && createdAt > 0 && (!guardSetAt || createdAt >= guardSetAt);

        if (turnFinished && idleAt > 0 && idleAt >= completedAt) {
            markExecutionFinished(session, completedAt);
            setState(session, STATE.WAITING, "poll: terminal event recovered");
            activity("event", `poll recovered terminal state sid=${session.sessionID.slice(-8)} completed=${completedAt} idle=${idleAt}`);
            return true;
        }
        if (!turnInProgress && guardStuckTooLong(session) && (idleAt === 0 || idleAt >= guardSetAt)) {
            markExecutionFinished(session, completedAt || Date.now());
            setState(session, STATE.WAITING, "poll: watchdog released");
            activity("event", `poll watchdog released sid=${session.sessionID.slice(-8)} idle=${idleAt} guard=${guardSetAt}`);
            return true;
        }
        return false;
    }

    function applyModel(session, ref) {
        if (!session || ref === null || ref === undefined) return;
        const model = modelRefOf(ref);
        if (model.id) session.model = model.id;
        if (model.providerID) session.provider = model.providerID;
        session.variant = model.hasVariant ? model.variant : "";
        session.effort = model.hasVariant
            ? resolveEffort(model.variant, findModelInfo(modelCatalog, model.providerID, model.id))
            : "";
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

    async function countAllUserMessages(session, sourceCtx = ctx) {
        if (!session) return 0;
        try {
            // Read from OpenCode SQLite database directly (most reliable)
            const { DatabaseSync } = await import("node:sqlite");
            const { join } = await import("node:path");
            const { homedir } = await import("node:os");
            const dbPath = process.env.OPENCODE_CONFIG_DIR
                ? join(process.env.OPENCODE_CONFIG_DIR, "..", "opencode", "opencode.db")
                : join(homedir(), ".local", "share", "opencode", "opencode.db");
            try {
                const db = new DatabaseSync(dbPath, { readOnly: true });
                let count = 0;
                // Skenario 1 & 2: V2 sessions (session_message table)
                // Handles: V2-only users AND V1->V2 migrated users
                try {
                    const result = db.prepare(
                        "SELECT COUNT(*) as cnt FROM session_message WHERE session_id = ? AND type = 'user'"
                    ).get(session.sessionID);
                    count = result?.cnt ?? 0;
                    if (count > 0) {
                        log(`countUser: v2 table count=${count} for ${session.sessionID}`);
                        db.close();
                        return count;
                    }
                } catch (e) {
                    // session_message table doesn't exist (V1-only user) - try V1 table
                    log(`countUser: v2 table not available: ${e?.message}`);
                }
                // Skenario 1 & 2: V1 sessions (message table)
                // Handles: V1-only users AND V1->V2 migrated users
                try {
                    const result = db.prepare(
                        "SELECT COUNT(*) as cnt FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'user'"
                    ).get(session.sessionID);
                    count = result?.cnt ?? 0;
                    if (count > 0) {
                        log(`countUser: v1 table count=${count} for ${session.sessionID}`);
                        db.close();
                        return count;
                    }
                } catch (e) {
                    // message table doesn't exist (V2-only user) - fall through
                    log(`countUser: v1 table not available: ${e?.message}`);
                }
                db.close();
                log(`countUser: sqlite user count=${count} for ${session.sessionID}`);
            } catch (e) {
                log(`countUser: sqlite error=${e?.message}`);
            }
            // Fallback to session.context (least reliable, only context window)
            const contextResp = await sourceCtx.session.context({ sessionID: session.sessionID });
            const messages = Array.isArray(contextResp) ? contextResp : contextResp?.data ?? [];
            if (Array.isArray(messages)) {
                const userCount = messages.filter((m) => {
                    const info = m?.info ?? m;
                    return info?.type === "user" || info?.role === "user";
                }).length;
                log(`countUser: fallback context user count=${userCount}`);
                return userCount;
            }
        } catch (error) {
            log(`countUserMessages: ${error?.message || error}`);
        }
        return 0;
    }

    function applyAssistantMessage(sid, info, eventTime) {
        if (!sid || !isAssistantMessage(info)) return null;
        const session = ensureSession(sid);
        const model = modelRefOf(modelReferenceFromInfo(info));
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
        const sessionModel = modelReferenceFromInfo(info);
        if (sessionModel !== null && sessionModel !== undefined) applyModel(session, sessionModel);
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
        // The server-side idle stamp only advances when the session really
        // becomes idle. It doubles as proof of terminal state when the
        // execution events are lost.
        if (info?.time?.idle) {
            session._serverIdleAt = Math.max(session._serverIdleAt || 0, eventTimestamp(info.time.idle, 0));
        }
        // Server-side message updates count as activity evidence too: a turn
        // that is still streaming keeps time.updated moving even when the
        // event stream is dead, so the watchdog will not fire early.
        if (info?.time?.updated) markNativeEvent(session, info.time.updated);
        touch(session, info?.time?.updated || eventTime);
        const sessionModel = modelReferenceFromInfo(info);
        if (sessionModel !== null && sessionModel !== undefined) applyModel(session, sessionModel);
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

    // True: a client window is attached (the TUI part's heartbeat is
    // fresh). False: every window has been closed for longer than the
    // timeout. Null: no heartbeat file at all, i.e. the TUI part is not
    // loaded (older client), so the client check is unavailable and the
    // presence keeps the legacy always-on behavior.
    function clientAttached() {
        try {
            const st = statSync(CLIENT_HEARTBEAT);
            return Date.now() - st.mtimeMs <= clientTimeoutMs();
        } catch {
            return null;
        }
    }

    // Server-side work that must keep the presence alive even with every
    // window closed: a headless `opencode run`, or a turn that finishes
    // after the user already quit. An ASKING session (permission prompt)
    // is deliberately not work: it cannot advance without a client to
    // answer it, so it must not pin the presence forever.
    function workInProgress() {
        for (const session of sessions.values()) {
            if (session.state === STATE.ASKING) continue;
            if (executionGuarded(session)) return true;
            if (session.state !== STATE.WAITING) return true;
        }
        return false;
    }

    // The presence shows while a client window is attached (heartbeat
    // fresh) or server-side work is still running. When every window has
    // been closed and nothing runs anymore, the presence must not linger
    // on Discord until the next service restart.
    function presenceAllowed() {
        const client = clientAttached();
        if (client === true) return true;
        if (workInProgress()) return true;
        return client === null;
    }

    function push() {
        try {
            const state = readState();
            presenceEnabled = state.presenceEnabled;
            daemonStopped = state.daemonStopped;
        } catch {}
        if (!presenceAllowed()) {
            if (!presenceSuppressed) {
                presenceSuppressed = true;
                activity("presence", "auto-clear (no client window attached and nothing running)");
                stopPresence();
            }
            return;
        }
        if (presenceSuppressed) {
            presenceSuppressed = false;
            activity("presence", "auto-clear: resumed");
            void ensureDaemonAndConnect(daemonStopped).then(() => push());
            return;
        }
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
            if (Array.isArray(models)) {
                for (const model of models) {
                    rememberModelInfo(modelCatalog, model);
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
                activity("models", `loaded ${modelLimits.size} model limits and ${modelCatalog.size} model definitions (v2)`);
                for (const session of sessions.values()) {
                    if (!session.variant) continue;
                    session.effort = resolveEffort(
                        session.variant,
                        findModelInfo(modelCatalog, session.provider, session.model),
                    );
                }
            }
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
                            rememberModelInfo(modelCatalog, mdef, pid, mid);
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
                    for (const session of sessions.values()) {
                        if (!session.variant) continue;
                        session.effort = resolveEffort(
                            session.variant,
                            findModelInfo(modelCatalog, session.provider, session.model),
                        );
                    }
                    break;
                } catch {}
            }
        } catch {}
    }

    async function refreshSessionStats(sid, sourceCtx = ctx, options = {}) {
        const session = ensureSession(sid);
        if (!session) return;
        const updateState = options.updateState !== false;
        const refreshGeneration = session._executionGeneration;
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
            // The context endpoint is a history/statistics fallback, not an
            // authoritative execution-state source. During a new execution
            // it can still expose the previously completed assistant message.
            // Never let that stale record turn an active execution into the
            // completed/Waiting state or replace native Thinking/Typing.
            const generationStillCurrent = session._executionGeneration === refreshGeneration;
            // A guard with a lost terminal event (dead event stream) never
            // clears and freezes the presence on Working. Try recovery first:
            // it releases the guard only with timestamp evidence that the
            // current turn really finished.
            const recovered = updateState && generationStillCurrent && executionGuarded(session)
                && tryRecoverFromLostTerminalEvent(session, latest);
            if (updateState && generationStillCurrent && !executionGuarded(session) && !recovered) {
                const idleAt = session._serverIdleAt || 0;
                if (isUserMessage(latest)) {
                    // Newest record is a prompt with no answer. The server
                    // idle stamp decides whether the turn is still running
                    // (stale idle) or dead without reply (idle after it).
                    const createdAt = latest.time?.created ? eventTimestamp(latest.time.created, 0) : 0;
                    const turnDead = idleAt > 0 && createdAt > 0 && idleAt >= createdAt;
                    if (turnDead) setState(session, STATE.WAITING, "poll: prompt finished without reply");
                    else setState(session, STATE.WORKING, "poll: latest is user message");
                } else if (isAssistantMessage(latest)) {
                    if (latest.time?.completed) setState(session, STATE.WAITING, "poll: assistant message completed");
                    else setState(session, STATE.TYPING, "poll: assistant message in progress");
                }
            } else if (updateState && latest && executionGuarded(session)) {
                activity(
                    "event",
                    `poll state ignored sid=${sid.slice(-8)} execution active, latest=${isAssistantMessage(latest) ? "assistant" : isUserMessage(latest) ? "user" : "unknown"}`,
                );
            }
        } catch (error) {
            log(`session.context(${sid}): ${error?.message || error}`);
        }

        // Full user message count via message.list API (paginated).
        // Only done once per session since it requires multiple API calls.
        if (!session._fullCountDone) {
            session._fullCountDone = true;
            const total = await countAllUserMessages(session, sourceCtx);
            session.promptCount = Math.max(session.promptCount, total);
            activity("stats", `sid=${sid.slice(-8)} full prompt count=${total}`);
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
        // Any native event for this session proves the event stream is
        // alive; the stuck-guard watchdog relies on this signal.
        if (sid) markNativeEvent(sessions.get(sid), eventTime);

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
            markExecutionStarted(session, eventTime);
            touch(session, eventTime);
            setState(session, STATE.WORKING, type);
            activity("event", `${type} sid=${sid.slice(-8)}`);
            commit(type);
            // The execution event is authoritative for the state transition.
            // This refresh is for usage and prompt statistics only, so a
            // stale/in-progress context response cannot overwrite Working.
            void refreshSessionStats(sid, ctx, { updateState: false }).then(() => commit(`${type} stats`));
            return;
        }

        if (type === "session.execution.succeeded" || type === "session.execution.failed" || type === "session.execution.interrupted") {
            const session = ensureSession(sid);
            if (!session) return;
            touch(session, eventTime);
            markExecutionFinished(session, eventTime);
            if (session.state !== STATE.ASKING) setState(session, STATE.WAITING, type);
            activity("event", `${type} sid=${sid.slice(-8)}`);
            commit(type);
            // Preserve the terminal state selected above. The context API can
            // still return an older assistant record while it catches up.
            void refreshSessionStats(sid, ctx, { updateState: false }).then(() => commit(`${type} stats`));
            return;
        }

        if (type === "session.step.started") {
            const session = ensureSession(sid);
            if (!session) return;
            if (!session._executionActive) markExecutionStarted(session, data.started || eventTime);
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
            const finish = String(data.finish || data.rawFinish || "").toLowerCase();
            // A stopped step is not necessarily a tool step. For a normal
            // model response, step.ended arrives just before
            // execution.succeeded. Do not briefly label that terminal step as
            // Working, because it makes a completed answer look like a tool
            // execution and can win the Discord throttle window. Keep the
            // current Thinking/Typing state until execution.succeeded makes
            // the final Waiting transition. Tool-call steps remain Working.
            const isToolStep = finish === "tool-calls" || finish === "tool_calls" || finish === "tool-call";
            if (session.state !== STATE.ASKING && (isToolStep || type === "session.step.failed")) {
                setState(session, STATE.WORKING, type);
            }
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
            // An idle status can race with the native execution events while
            // OpenCode is still starting the next step. The execution guard
            // prevents a stale idle notification from hiding Thinking.
            if (status === "idle" && !executionGuarded(session) && session.state !== STATE.ASKING) setState(session, STATE.WAITING, type);
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
            if (info.time?.completed) {
                const completedAt = eventTimestamp(info.time.completed, eventTime);
                const belongsToCurrentExecution = !session._executionPending
                    && (!session._executionActive
                        || !session._executionStartedAt
                        || completedAt >= session._executionStartedAt);
                if (belongsToCurrentExecution) {
                    setState(session, STATE.WAITING, type);
                } else {
                    activity("event", `message completion ignored sid=${sid.slice(-8)} stale assistant message`);
                }
            }
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
        markPromptPending,
        markNativeEvent,
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
                runtime.markPromptPending?.(session);
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
                runtime.markNativeEvent?.(session);
                if (session.state !== STATE.ASKING) runtime.setState(session, STATE.WORKING, "tool.execute.before");
                runtime.commit("tool.execute.before");
            } catch (error) {
                log(`tool hook: ${error?.message || error}`);
            }
        });

        liveCtxs.add(ctx);
        if (isFirstRuntime) {
            // Restartable shared subscription: a silent stream end (service
            // restart, location shutdown) must not kill native events for the
            // rest of the session's life.
            restartEventLoop(ctx);

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
            liveCtxs.delete(ctx);
            sharedRuntimeRefs -= 1;
            if (sharedRuntimeRefs <= 0) {
                eventLoopToken += 1;
                try { sharedController?.abort(); } catch {}
                try { if (sharedTimer) clearInterval(sharedTimer); } catch {}
                sharedController = null;
                sharedTimer = null;
                sharedRuntime = null;
                sharedSubscribeCtx = null;
                sharedRuntimeRefs = 0;
                lastForwardedEnabled = null;
            } else if (sharedSubscribeCtx === ctx) {
                // The subscription belonged to this runtime. Hand it to a
                // surviving one instead of letting the event stream die.
                const survivor = [...liveCtxs].at(-1);
                if (survivor) restartEventLoop(survivor);
            }
        };
    },
});
