import { spawnWorker } from "./worker-spawner.js";
import { log } from "../shared/logger.js";
import { DISCORD_DEBOUNCE_MS } from "../shared/constants.js";
import { truncate } from "./template-engine.js";
import { renderTemplate, getTemplateVars, chooseTemplates, selectIdleTemplates } from "./template-engine.js";

const state = {
    workerProcess: null,
    connected: false,
    disposed: false,
    respawning: false,
    pendingActivity: null,
    lastError: null,
    lastAttemptAt: null,
    retryCount: 0,
    pushTimer: null,
    stdoutBuf: "",
    // Set before killing the worker when the shutdown is intentional (e.g.
    // losing leadership). The onExit handler reads this and skips its
    // respawn/retry logic so the worker stays dead until a new connect().
    intentionalShutdown: false,
};

function sendCmd(cmd) {
    if (!state.workerProcess?.stdin?.writable) return false;
    try { state.workerProcess.stdin.write(JSON.stringify(cmd) + "\n"); return true; } catch { return false; }
}

function handleWorkerMsg(msg) {
    if (msg.type === "connected") {
        state.connected = true;
        state.retryCount = 0;
        state.lastError = null;
        log("Discord connected via worker");
        if (state.pendingActivity) sendCmd({ cmd: "setActivity", activity: state.pendingActivity });
    } else if (msg.type === "disconnected") {
        state.connected = false;
    } else if (msg.type === "error") {
        state.lastError = msg.error;
        log(`[worker error] ${msg.error}`);
    } else if (msg.type === "attempt") {
        state.lastAttemptAt = Date.now();
        state.retryCount = msg.retryCount ?? 0;
    } else if (msg.type === "log") {
        // v2.0.8-rc3: forward the worker's own log lines into the parent's
        // debug log so we can see "Activity sent", "Replay activity failed",
        // "Shutdown requested" without re-running with extra logging.
        log(`[worker] ${msg.msg || ""}`);
    }
}

function spawn(config) {
    if (state.workerProcess || state.respawning) return;
    const env = { ...process.env };
    if (config.appId && config.appId !== "NOT_CONFIGURED") {
        env.DISCORD_APP_ID = config.appId;
    } else {
        delete env.DISCORD_APP_ID;
    }
    state.workerProcess = spawnWorker({
        env,
        onMessage: handleWorkerMsg,
        onExit: ({ isIntentionalRestart }) => {
            state.workerProcess = null;
            state.connected = false;
            state.lastError = `Worker exited`;

            if (state.disposed) return;

            // Intentional shutdown (e.g. on leadership loss): kill the worker
            // cleanly and do not respawn. A future connect() will spawn a new
            // one when this instance becomes leader again.
            if (state.intentionalShutdown) {
                state.intentionalShutdown = false;
                state.lastError = null;
                return;
            }

            if (isIntentionalRestart) {
                state.retryCount = 0;
                state.lastError = null;
                state.respawning = true;
                setTimeout(() => {
                    state.respawning = false;
                    spawn(config);
                }, 2000).unref?.();
            } else {
                setTimeout(() => {
                    if (!state.disposed && !state.workerProcess && !state.intentionalShutdown) spawn(config);
                }, 3000).unref?.();
            }
        },
    });
}

function connect() {
    if (state.disposed) return;
    state.lastAttemptAt = Date.now();
    if (!state.workerProcess) spawn(getCurrentConfig());
    sendCmd({ cmd: "connect" });
}

export function pushActivity(session, config, isLeader) {
    if (state.disposed || !isLeader) return;
    const isIdle = !session || session.state === "Waiting for command";
    const tmpls = isIdle ? selectIdleTemplates(config.templates) : chooseTemplates(config.templates, session?.state);
    const vars = getTemplateVars(session);
    state.pendingActivity = {
        details: truncate(renderTemplate(tmpls.details, vars), 128),
        state: truncate(renderTemplate(tmpls.state, vars), 128),
        largeImageKey: config.largeImageKey,
        largeImageText: truncate(renderTemplate(tmpls.largeImageText ?? "OpenCode", vars), 128),
        smallImageKey: undefined,
        smallImageText: tmpls.smallImageText ? truncate(renderTemplate(tmpls.smallImageText, vars), 128) : undefined,
    };
    if (!state.connected) { connect(); return; }
    if (state.pushTimer) return;
    state.pushTimer = setTimeout(() => {
        state.pushTimer = null;
        if (state.connected && state.pendingActivity) sendCmd({ cmd: "setActivity", activity: state.pendingActivity });
    }, DISCORD_DEBOUNCE_MS);
    state.pushTimer.unref?.();
}

export async function destroy() {
    state.disposed = true;
    if (state.pushTimer) { clearTimeout(state.pushTimer); state.pushTimer = null; }
    const wp = state.workerProcess;
    state.workerProcess = null;
    state.connected = false;
    if (!wp) return;

    // v2.0.8-rc3: poll the child's exitCode instead of using a fixed
    // 200ms wait + unconditional SIGTERM (the source of
    // `Worker exited: code=null sig=SIGTERM` in v2.0.7).
    //
    // v2.0.8-rc5: drop the SIGKILL-after-grace fallback entirely. Linux
    // reuses PIDs as soon as a process exits, so a `wp.kill()` call
    // AFTER the worker has exited (but before Node.js has dispatched
    // the `exit` event back to the parent) can land on a recycled PID
    // and kill an unrelated process. Better to leave the worker to
    // exit on its own (the shutdown handler has its own 1s timeouts on
    // clearActivity and client.destroy in v2.0.8-rc5, so it exits
    // promptly). If it does hang, it becomes an orphan that gets
    // cleaned up when its parent eventually exits.
    try { sendCmd({ cmd: "shutdown" }); } catch {}

    const start = Date.now();
    const graceMs = 2000;
    while (Date.now() - start < graceMs) {
        if (wp.exitCode !== null || wp.signalCode !== null) return;
        await new Promise((r) => setTimeout(r, 50));
    }

    log("destroy: worker did not exit within grace, leaving it orphaned");
}

// Tear the worker down because we lost leadership (or otherwise no longer want
// to push to Discord). Unlike destroy() this does NOT mark the service as
// permanently disposed; a subsequent connect() will spawn a new worker.
//
// Important: do NOT signal-kill the worker by PID. Linux reuses PIDs as soon
// as a process exits, and the next leader's worker can spawn with the same
// PID. Sending a signal to the cached ChildProcess reference AFTER the
// worker has exited (but before Node.js dispatched the `exit` event back to
// the parent) can land on a recycled PID and kill an unrelated process.
// See `destroy()` for the same rationale.
export async function shutdownWorker() {
    state.intentionalShutdown = true;
    if (state.pushTimer) { clearTimeout(state.pushTimer); state.pushTimer = null; }
    const wp = state.workerProcess;
    state.workerProcess = null;
    state.connected = false;
    if (!wp) return;

    try { sendCmd({ cmd: "shutdown" }); } catch {}

    const start = Date.now();
    const graceMs = 2000;
    while (Date.now() - start < graceMs) {
        if (wp.exitCode !== null || wp.signalCode !== null) return;
        await new Promise((r) => setTimeout(r, 50));
    }

    log("shutdownWorker: worker did not exit within grace, leaving it orphaned");
}

// Internal: track current config for respawn
let _currentConfig = null;
function getCurrentConfig() { return _currentConfig; }

export function startConnect(config) {
    _currentConfig = config;
    connect();
}

// Spawn the worker and start its Discord connection attempt without requiring
// the calling process to be the leader. Standby instances that have just
// received user activity call this so their worker is already running and
// retrying the login by the time the leader releases. The worker's first
// login will fail (Discord IPC held by the current leader) and it will
// retry with the fast backoff configured in discord-worker.mjs. When the
// standby eventually becomes leader, the worker is already in place and
// the only remaining delay is the Discord IPC handshake itself.
export function prepareConnect(config) {
    _currentConfig = config;
    if (state.disposed) return;
    if (!state.workerProcess) {
        spawn(config);
        try { sendCmd({ cmd: "connect" }); } catch {}
    }
}

export function getStatus() {
    return {
        connected: state.connected,
        lastError: state.lastError,
        retryCount: state.retryCount,
        lastAttemptAt: state.lastAttemptAt,
        workerAlive: !!state.workerProcess,
    };
}
