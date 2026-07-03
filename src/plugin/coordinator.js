import { writeFile, readFile, unlink } from "node:fs/promises";
import { LOCK_FILE, HANDOFF_REQUEST } from "../shared/paths.js";
import { HEARTBEAT_INTERVAL, HEARTBEAT_TIMEOUT, HANDOFF_CHECK_INTERVAL } from "../shared/constants.js";
import { log } from "../shared/logger.js";

// Activity-based leader election. The first instance to start acquires the
// leader lock and connects to Discord. A standby instance that receives chat
// activity writes a handoff signal at HANDOFF_REQUEST; the leader's heartbeat
// reads the signal on each tick and releases the lock if the request is from
// a different PID with a fresher last-activity timestamp than its own. The
// standby polls for the lock release and acquires it, at which point it
// connects to Discord and pushes its own presence.
//
// This way the actively-chatting instance always wins leadership, regardless
// of which OpenCode window opened first. An idle leader yields to an active
// standby; a leader that is also active keeps the lock.

let isLeader = false;
let heartbeatTimer = null;
let standbyTimer = null;
let myLastActivity = 0;
let onLeadershipChange = null;
const myPid = process.pid;

async function readLockSafe() {
    try {
        const content = await readFile(LOCK_FILE, "utf-8");
        return JSON.parse(content);
    } catch { return null; }
}

async function readHandoffSafe() {
    try {
        const content = await readFile(HANDOFF_REQUEST, "utf-8");
        const req = JSON.parse(content);
        if (Date.now() - (req.requestedAt || 0) > HEARTBEAT_TIMEOUT) return null;
        return req;
    } catch { return null; }
}

async function tryAcquireLock() {
    const now = Date.now();
    const payload = JSON.stringify({ pid: myPid, started: now, lastActivity: myLastActivity });

    try {
        await writeFile(LOCK_FILE, payload, { flag: "wx" });
        isLeader = true;
        log(`Acquired leader lock (pid ${myPid})`);
        return true;
    } catch (e) {
        if (e.code !== "EEXIST") {
            log(`Lock acquire error: ${e.message}`);
            return false;
        }
    }

    const lock = await readLockSafe();
    if (!lock) {
        // Lock vanished between wx attempt and read; retry once.
        return await tryAcquireLock();
    }

    const age = Date.now() - (lock.started || 0);
    if (age < HEARTBEAT_TIMEOUT && lock.pid !== myPid) {
        log(`Another instance is leader (pid ${lock.pid}, ${Math.round(age/1000)}s old)`);
        return false;
    }

    log(`Lock is stale (${Math.round(age/1000)}s old, owner pid ${lock.pid}), stealing...`);
    await unlink(LOCK_FILE).catch(() => {});
    return await tryAcquireLock();
}

async function heartbeatLoop() {
    if (!isLeader) return;
    try {
        // Hand off leadership if another instance has fresher activity.
        const req = await readHandoffSafe();
        if (req && req.pid !== myPid && req.requestedAt > myLastActivity) {
            log(`Handoff requested by pid ${req.pid} (their activity: ${new Date(req.requestedAt).toISOString()}, mine: ${myLastActivity ? new Date(myLastActivity).toISOString() : "never"})`);
            await unlink(HANDOFF_REQUEST).catch(() => {});
            await releaseLock();
            return;
        }

        await writeFile(LOCK_FILE, JSON.stringify({ pid: myPid, started: Date.now(), lastActivity: myLastActivity }), "utf-8");
    } catch (e) {
        log(`Heartbeat failed: ${e.message}`);
    }
}

function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(heartbeatLoop, HEARTBEAT_INTERVAL);
    heartbeatTimer.unref?.();
}

function stopHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

async function releaseLock() {
    stopHeartbeat();
    if (!isLeader) return;
    try { await unlink(LOCK_FILE); log("Released leader lock"); } catch {}
    isLeader = false;
    if (onLeadershipChange) onLeadershipChange(false);
}

async function standbyPoll() {
    if (isLeader) return;
    const lock = await readLockSafe();
    if (!lock) {
        // No leader at all (or it just released); try to claim.
        const ok = await tryAcquireLock();
        if (ok) await onGainedLeadership();
        return;
    }
    if (lock.pid === myPid) {
        // Lock claims to be ours but we did not think we were leader. Reconcile.
        isLeader = true;
        await onGainedLeadership();
        return;
    }
    const age = Date.now() - (lock.started || 0);
    if (age >= HEARTBEAT_TIMEOUT) {
        log(`Leader pid ${lock.pid} lock is stale (${Math.round(age/1000)}s), taking over`);
        await unlink(LOCK_FILE).catch(() => {});
        const ok = await tryAcquireLock();
        if (ok) await onGainedLeadership();
    }
}

function startStandbyPolling() {
    if (standbyTimer) return;
    standbyTimer = setInterval(standbyPoll, HANDOFF_CHECK_INTERVAL);
    standbyTimer.unref?.();
}

function stopStandbyPolling() {
    if (standbyTimer) {
        clearInterval(standbyTimer);
        standbyTimer = null;
    }
}

async function onGainedLeadership() {
    startHeartbeat();
    if (onLeadershipChange) {
        try { await onLeadershipChange(true); } catch (e) { log("Leadership change cb error:", e?.message || e); }
    }
}

// Standby instance signals that it wants leadership because it has chat
// activity. Writes the handoff signal AND tries to acquire immediately in
// case the leader has already released.
async function requestHandoff() {
    myLastActivity = Date.now();
    try {
        await writeFile(HANDOFF_REQUEST, JSON.stringify({ pid: myPid, requestedAt: myLastActivity }), "utf-8");
        log(`Handoff requested (pid ${myPid})`);
    } catch (e) {
        log(`Handoff request failed: ${e.message}`);
    }
    if (!isLeader) {
        const ok = await tryAcquireLock();
        if (ok) await onGainedLeadership();
    }
}

function markActive() {
    myLastActivity = Date.now();
}

function setLeadershipChangeCallback(cb) {
    onLeadershipChange = cb;
}

export const coordinator = {
    get isLeader() { return isLeader; },
    tryAcquire: tryAcquireLock,
    startHeartbeat,
    stopHeartbeat,
    startStandbyPolling,
    stopStandbyPolling,
    release: releaseLock,
    requestHandoff,
    markActive,
    setLeadershipChangeCallback,
};
