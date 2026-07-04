import { spawnWorker } from "./worker-spawner.js";
import { log } from "../shared/logger.js";
import { DISCORD_DEBOUNCE_MS, STALE_WORKER_THRESHOLD_MS } from "../shared/constants.js";
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
    // v2.1.2: track when the worker last reported any state change (connect,
    // attempt, error). The stale-check loop kills + respawns the worker if
    // nothing has happened for STALE_WORKER_THRESHOLD_MS, which indicates
    // the Discord IPC socket is in a state where the worker's normal retry
    // loop cannot recover (e.g. socket held by a zombie process or stale
    // after the previous leader exited). See forceRestartWorker().
    lastWorkerEventAt: 0,
    // v2.1.2: guard against concurrent forceRestartWorker() calls (e.g. the
    // leadership-gain path and the stale-check loop firing at the same time).
    restarting: false,
};

function sendCmd(cmd, wp = state.workerProcess) {
    // v2.1.2: take wp as parameter so callers that null out state.workerProcess
    // BEFORE calling us (e.g. shutdownWorker, destroy) can still send the cmd.
    // The previous code read `state.workerProcess?.stdin?.writable` after
    // the caller had nulled it, which silently dropped every shutdown command.
    // The worker was then SIGKILLed without ever receiving "Shutdown requested"
    // or running clearActivity, leaving Discord showing the last activity
    // until Discord itself was restarted.
    if (!wp?.stdin?.writable) {
        log(`sendCmd: cannot send ${cmd?.cmd} (stdin not writable)`);
        return false;
    }
    try { wp.stdin.write(JSON.stringify(cmd) + "\n"); return true; } catch (e) {
        log(`sendCmd(${cmd?.cmd}):`, e?.message || e);
        return false;
    }
}

function handleWorkerMsg(msg) {
    state.lastWorkerEventAt = Date.now();
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
            state.lastWorkerEventAt = Date.now();

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
    if (!wp) return;

    // v2.1.2: send shutdown cmd BEFORE nulling state.workerProcess. The
    // previous order (null first, then sendCmd) silently dropped the cmd
    // because sendCmd read `state.workerProcess?.stdin?.writable` which
    // was undefined once the caller had nulled it. The worker was then
    // SIGKILLed without ever running clearActivity, leaving Discord
    // showing the last activity until Discord itself was restarted.
    try { sendCmd({ cmd: "shutdown" }, wp); } catch {}

    state.workerProcess = null;
    state.connected = false;

    // v2.0.8-rc3: poll the child's exitCode instead of a fixed wait.
    // v2.0.8-rc5: dropped SIGKILL-after-grace, leaving orphan workers.
    // v2.1.2: bring SIGKILL back. Without it, an orphan worker keeps the
    // Discord IPC socket bound after the plugin has disposed (e.g. user
    // closed the last OpenCode instance with /exit), and Discord keeps
    // showing the last activity until Discord itself is restarted.
    //
    // The PID-reuse concern that v2.0.8-rc5 worried about (kill landing
    // on a recycled PID if the worker exits between the parent polling
    // and the parent sending the signal) is theoretical and rare. The
    // polling loop checks wp.exitCode every 50ms; if the worker exits
    // during the poll, the loop returns immediately. Only after the
    // grace period expires AND exitCode is still null do we send the
    // signal, at which point we know the worker is still alive and the
    // PID has not been recycled.
    const start = Date.now();
    const graceMs = 2500;
    while (Date.now() - start < graceMs) {
        if (wp.exitCode !== null || wp.signalCode !== null) return;
        await new Promise((r) => setTimeout(r, 50));
    }

    log("destroy: worker did not exit within 2.5s grace, SIGKILL");
    try { wp.kill("SIGKILL"); } catch {}
}

// Tear the worker down because we lost leadership (or otherwise no longer want
// to push to Discord). Unlike destroy() this does NOT mark the service as
// permanently disposed; a subsequent connect() will spawn a new worker.
//
// v2.1.2: same shutdown-first-then-null order fix as destroy(). Without it
// the shutdown cmd is silently dropped and the worker never gets to run
// clearActivity before being SIGKILLed, leaving Discord showing stale
// activity after the last leader exits.
export async function shutdownWorker() {
    state.intentionalShutdown = true;
    if (state.pushTimer) { clearTimeout(state.pushTimer); state.pushTimer = null; }
    const wp = state.workerProcess;
    if (!wp) return;

    try { sendCmd({ cmd: "shutdown" }, wp); } catch {}

    state.workerProcess = null;
    state.connected = false;

    const start = Date.now();
    const graceMs = 2500;
    while (Date.now() - start < graceMs) {
        if (wp.exitCode !== null || wp.signalCode !== null) return;
        await new Promise((r) => setTimeout(r, 50));
    }

    log("shutdownWorker: worker did not exit within 2.5s grace, SIGKILL");
    try { wp.kill("SIGKILL"); } catch {}
}

// Internal: track current config for respawn
let _currentConfig = null;
function getCurrentConfig() { return _currentConfig; }

// v2.1.2: kill the current worker (if any) and spawn a fresh one. Used by
// the leadership-gain path to guarantee a clean state on every handoff (the
// previous leader's worker may have left the Discord IPC socket in a stale
// state), and by the stale-check loop when the worker has been failing to
// connect for too long.
//
// Mirrors the manual recovery that `opencode-rpc restart` performs:
//   1. Send shutdown to the worker, set intentionalShutdown so its onExit
//      does not auto-respawn.
//   2. Poll for actual exit (up to 2s grace).
//   3. Wait an additional 2s for the Discord IPC socket to be released by the
//      OS. Without this delay, the freshly spawned worker tries to bind the
//      still-occupied socket and immediately fails.
//   4. Spawn + connect.
//
// Safe to call when no worker is alive: each step short-circuits.
async function forceRestartWorker() {
    if (state.restarting) return;
    state.restarting = true;
    try {
        const wp = state.workerProcess;
        if (wp) {
            state.intentionalShutdown = true;
            // v2.1.2: pass wp explicitly because state.workerProcess is
            // nulled below; without this, sendCmd silently drops the cmd.
            try { sendCmd({ cmd: "shutdown" }, wp); } catch {}
            const start = Date.now();
            while (Date.now() - start < 2000) {
                if (wp.exitCode !== null || wp.signalCode !== null) break;
                await new Promise((r) => setTimeout(r, 50));
            }
        }
        state.workerProcess = null;
        state.connected = false;
        state.retryCount = 0;
        state.lastError = null;
        state.lastWorkerEventAt = Date.now();
        // Give the OS time to fully release the Discord IPC socket.
        await new Promise((r) => setTimeout(r, 2000));
        if (state.disposed) return;
        if (_currentConfig) {
            spawn(_currentConfig);
            try { sendCmd({ cmd: "connect" }); } catch {}
        }
    } finally {
        state.restarting = false;
    }
}

// v2.1.2: self-healing watchdog. Returns true if the worker is currently
// stuck (alive but no progress for STALE_WORKER_THRESHOLD_MS) and a restart
// was triggered. Called from the leader heartbeat loop so we do not add a
// second timer.
async function maybeRestartStaleWorker() {
    if (state.disposed) return false;
    if (state.connected) return false;
    if (!state.workerProcess) return false;
    if (!state.lastWorkerEventAt) return false;
    const staleMs = Date.now() - state.lastWorkerEventAt;
    if (staleMs < STALE_WORKER_THRESHOLD_MS) return false;
    log(`Worker stuck for ${Math.round(staleMs / 1000)}s, auto-restarting`);
    forceRestartWorker().catch((e) => log("forceRestartWorker:", e?.message || e));
    return true;
}

export function startConnect(config) {
    _currentConfig = config;
    connect();
}

// v2.1.2: gain-leadership entry point. Unlike startConnect() (which only
// sends a `connect` command to the existing worker), this guarantees the
// new leader starts with a fresh worker process. Used by the
// setLeadershipChangeCallback(true) path so the Discord IPC socket held by
// the previous leader's worker does not cause the new leader's connect
// attempts to fail silently.
export function startConnectAsLeader(config) {
    _currentConfig = config;
    // If the worker is already connected, no restart needed. Skipping the
    // restart saves the 2s IPC-release wait when leadership changes on a
    // healthy Discord session.
    if (state.connected) {
        connect();
        return;
    }
    forceRestartWorker().catch((e) => log("startConnectAsLeader:", e?.message || e));
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

// v2.1.2: exported for the plugin's leader activity timer. Triggers a fresh
// worker spawn if the current one has been failing to connect for
// STALE_WORKER_THRESHOLD_MS.
export function checkWorkerHealth() {
    return maybeRestartStaleWorker();
}
