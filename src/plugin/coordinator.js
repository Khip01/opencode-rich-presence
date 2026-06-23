import { writeFile, readFile, unlink } from "node:fs/promises";
import { LOCK_FILE } from "../shared/paths.js";
import { HEARTBEAT_INTERVAL, HEARTBEAT_TIMEOUT } from "../shared/constants.js";
import { log } from "../shared/logger.js";

let isLeader = false;
let heartbeatTimer = null;
const myPid = process.pid;

async function tryAcquireLock() {
    const now = Date.now();
    const payload = JSON.stringify({ pid: myPid, started: now });

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

    try {
        const content = await readFile(LOCK_FILE, "utf-8");
        const lock = JSON.parse(content);
        const age = Date.now() - (lock.started || 0);

        if (age < HEARTBEAT_TIMEOUT && lock.pid !== myPid) {
            log(`Another instance is leader (pid ${lock.pid}, ${Math.round(age/1000)}s old)`);
            return false;
        }

        log(`Lock is stale (${Math.round(age/1000)}s old, owner pid ${lock.pid}), stealing...`);
        await unlink(LOCK_FILE).catch(() => {});
        return await tryAcquireLock();
    } catch (e) {
        log(`Lock read error: ${e.message}, retrying...`);
        return false;
    }
}

async function heartbeatLoop() {
    if (!isLeader) return;
    try {
        await writeFile(LOCK_FILE, JSON.stringify({ pid: myPid, started: Date.now() }), "utf-8");
    } catch (e) {
        log(`Heartbeat failed: ${e.message}`);
    }
}

function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(heartbeatLoop, HEARTBEAT_INTERVAL);
    heartbeatTimer.unref?.();
}

async function releaseLock() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    if (!isLeader) return;
    try { await unlink(LOCK_FILE); log("Released leader lock"); } catch {}
    isLeader = false;
}

export const coordinator = {
    get isLeader() { return isLeader; },
    tryAcquire: tryAcquireLock,
    startHeartbeat,
    release: releaseLock,
};
