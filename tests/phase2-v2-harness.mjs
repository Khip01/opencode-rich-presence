#!/usr/bin/env node
// Phase 2 v2 regression harness: verifies behaviors added after user
// feedback during Phase 2 testing.
//
// Tests:
//   - Final-state push: when state changes are throttled, the LATEST
//     state is pushed after the throttle expires (not a stale
//     intermediate).
//   - Fingerprint skip: a push attempt with the same details+state
//     as the last successful push is skipped (no spam).
//   - Daemon stays alive indefinitely after all clients disconnect
//     (replaces the old "exit after grace" behavior). New clients
//     reuse the existing daemon (no Discord reconnect).
//
// Run: node tests/phase2-v2-harness.mjs
//
// Requires the daemon code to be installed at the standard npm global
// path so the harness can spawn it. Adjust DAEMON_PATH below if your
// install path differs.

import net from "node:net";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DAEMON_PATH = "/home/khip/.nvm/versions/node/v24.13.1/lib/node_modules/opencode-rich-presence/src/worker/daemon.mjs";
const OPENCODE_DIR = join(homedir(), ".config", "opencode");
const ACTIVITY_LOG = join(OPENCODE_DIR, "presence-activity.log");
const SOCKET = join(OPENCODE_DIR, ".opencode-rich-presence.sock");
const PID_FILE = join(OPENCODE_DIR, ".opencode-rich-presence.pid");

let passed = 0;
let failed = 0;

function assert(c, m) {
    if (c) { passed++; console.log(`  PASS: ${m}`); }
    else { failed++; console.log(`  FAIL: ${m}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readLog() {
    if (!existsSync(ACTIVITY_LOG)) return "";
    return readFileSync(ACTIVITY_LOG, "utf-8");
}

function countDaemonPushes(sidFilter = "") {
    const log = readLog();
    const lines = log.split("\n").filter(l => l.includes("[daemon] push"));
    if (!sidFilter) return lines.length;
    return lines.filter(l => l.includes(`sid=${sidFilter}`)).length;
}

function lastDaemonPush() {
    const log = readLog();
    const lines = log.split("\n").filter(l => l.includes("[daemon] push"));
    return lines.length > 0 ? lines[lines.length - 1] : null;
}

async function clear() {
    // Kill any existing daemon first.
    if (existsSync(PID_FILE)) {
        try {
            const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
            if (pid > 0) try { process.kill(pid, "SIGTERM"); } catch {}
        } catch {}
    }
    await sleep(500);
    try { unlinkSync(SOCKET); } catch {}
    try { unlinkSync(PID_FILE); } catch {}
    await sleep(300);
}

async function scenario(name, fn) {
    console.log(`\n=== ${name} ===`);
    try {
        await fn();
    } catch (e) {
        failed++;
        console.log(`  ERROR: ${e?.message || e}\n${e?.stack || ""}`);
    }
}

function spawnDaemon() {
    return new Promise((resolve, reject) => {
        const proc = spawn("node", [DAEMON_PATH], { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        proc.stdout?.on("data", (c) => (stderr += "[out] " + c.toString()));
        proc.stderr.on("data", (c) => (stderr += "[err] " + c.toString()));
        proc.unref();
        proc.on("error", reject);
        // Poll for socket to appear (more robust than fixed 2s wait).
        const start = Date.now();
        const check = () => {
            if (existsSync(SOCKET)) {
                resolve();
            } else if (Date.now() - start > 5000) {
                reject(new Error(`daemon socket did not appear within 5s; stderr: ${stderr}`));
            } else {
                setTimeout(check, 100);
            }
        };
        check();
    });
}

async function connectClient(pid) {
    const sock = net.createConnection(SOCKET);
    sock.setEncoding("utf-8");
    await new Promise((resolve, reject) => {
        sock.once("connect", resolve);
        sock.once("error", reject);
    });
    sock.write(JSON.stringify({ type: "hello", pid }) + "\n");
    await sleep(200);
    return sock;
}

function sendState(sock, pid, sid, state, details, stateText) {
    const msg = JSON.stringify({
        type: "state",
        pid,
        session: { sessionID: sid, state, lastActivity: Date.now() },
        rendered: { details, state: stateText, largeImageKey: "x" }
    }) + "\n";
    return sock.write(msg);
}

await clear();
await spawnDaemon();
console.log("Daemon spawned");

let sock1 = null;
let sock2 = null;

try {
    await scenario("1. Single-instance rapid transitions: final state lands", async () => {
        sock1 = await connectClient(99001);

        // Wait for daemon to finish connecting to Discord (the
        // pushCurrentPresence call in connectDiscord's success path
        // depends on it). Without this wait, the early pushes may be
        // skipped because discordConnected is still false when the
        // state messages arrive.
        await sleep(2000);

        // T=0: WORKING
        sendState(sock1, 99001, "ses_quicktest_aaa", "Working",
            "model1 (build)", "Working · 0 ctx");
        await sleep(500);

        // T=500ms: TYPING (should be throttled, scheduled for later)
        sendState(sock1, 99001, "ses_quicktest_aaa", "Typing",
            "model1 (build)", "Typing · 0 ctx");
        await sleep(500);

        // T=1000ms: WAITING (still throttled)
        sendState(sock1, 99001, "ses_quicktest_aaa", "Waiting for command",
            "model1 (build)", "Completed! · 1k ctx");
        await sleep(500);

        const pushesAfterBurst = countDaemonPushes("test_aaa");
        assert(pushesAfterBurst >= 1, `at least 1 daemon push in burst (got ${pushesAfterBurst})`);
        const lastPush = lastDaemonPush();
        const lastState = lastPush ? lastPush.match(/state="([^"]+)"/)?.[1] : null;
        // lastPush might be from a different scenario (the activity
        // log accumulates). Filter by PID for this scenario's daemon.
        const targetPid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
        const log = readLog();
        const scenario1Pushes = log.split("\n")
            .filter(l => l.includes("[daemon] push") && l.includes(`sid=test_aaa`) && l.includes(`[pid ${targetPid}]`));
        const lastScenarioPush = scenario1Pushes[scenario1Pushes.length - 1];
        const lastScenarioState = lastScenarioPush ? lastScenarioPush.match(/state="([^"]+)"/)?.[1] : null;
        assert(lastScenarioState === "Working · 0 ctx" || lastScenarioState === "Typing · 0 ctx",
            `last push is Working or Typing (got: ${lastScenarioState})`);

        // Wait for the delayed final-state push (throttle = 4s)
        await sleep(6000);

        const pushesAfterDelay = countDaemonPushes("test_aaa");
        assert(pushesAfterDelay >= 2, `delayed push fired (now ${pushesAfterDelay} total, was ${pushesAfterBurst})`);

        // Re-fetch the last push AFTER the delayed push fires.
        const log2 = readLog();
        const scenario1PushesAfter = log2.split("\n")
            .filter(l => l.includes("[daemon] push") && l.includes(`sid=test_aaa`) && l.includes(`[pid ${targetPid}]`));
        const finalPush = scenario1PushesAfter[scenario1PushesAfter.length - 1];
        const finalState = finalPush ? finalPush.match(/state="([^"]+)"/)?.[1] : null;
        assert(finalState === "Completed! · 1k ctx",
            `final state lands as WAITING/Completed (got: ${finalState})`);
    });

    await scenario("2. Fingerprint skip: identical state not pushed again", async () => {
        const pushesBefore = countDaemonPushes("test_bbb");
        // Push the SAME state 5 times
        for (let i = 0; i < 5; i++) {
            sendState(sock1, 99001, "ses_fp_test_bbb", "Working",
                "same details", "same state");
            await sleep(200);
        }
        await sleep(2500);
        const pushesAfter = countDaemonPushes("test_bbb");
        assert(pushesAfter <= pushesBefore + 1,
            `fingerprint skip works: same state pushed at most once (before=${pushesBefore}, after=${pushesAfter})`);
    });

    await scenario("3. Multi-instance: when only one is active, its final state lands", async () => {
        sock2 = await connectClient(99002);

        let daemonPid = null;
        try {
            const pidRaw = readFileSync(PID_FILE, "utf-8").trim();
            daemonPid = parseInt(pidRaw, 10);
        } catch {}
        const targetPid = daemonPid;

        // sock1 fires WORKING (active)
        sendState(sock1, 99001, "ses_inst1_cccc", "Working",
            "inst1", "Working");
        await sleep(300);

        // sock2 fires TYPING (active)
        sendState(sock2, 99002, "ses_inst2_dddd", "Typing",
            "inst2", "Typing");
        await sleep(300);

        // sock1 finishes to WAITING (no longer active)
        sendState(sock1, 99001, "ses_inst1_cccc", "Waiting for command",
            "inst1", "Completed!");
        await sleep(300);

        // sock2 finishes to WAITING (no longer active)
        sendState(sock2, 99002, "ses_inst2_dddd", "Waiting for command",
            "inst2", "Done!");

        // Now BOTH sessions are idle. Daemon should pick the most
        // recently active (sock2's "Done!") and push it via delayed
        // push. Wait for throttle to expire.
        await sleep(6000);

        const log = readLog();
        const allPushes = log.split("\n")
            .filter(l => l.includes("[daemon] push") && targetPid && l.includes(`[pid ${targetPid}]`));
        // The LAST push should be one of the "Completed!" or "Done!"
        // terminal states (any session). The exact instance picked is
        // an implementation detail; what matters is no session is
        // stuck on an intermediate state like Typing/Working.
        const lastPush = allPushes[allPushes.length - 1];
        const lastState = lastPush ? lastPush.match(/state="([^"]+)"/)?.[1] : null;
        console.log(`  (debug: last daemon push: ${lastPush})`);
        assert(lastState === "Completed!" || lastState === "Done!",
            `final state lands (not stuck on Typing/Working); got: ${lastState}`);
    });

    await scenario("4. Daemon stays alive after all goodbyes (no auto-exit)", async () => {
        // Both clients send goodbye
        sock1.write(JSON.stringify({ type: "goodbye", pid: 99001 }) + "\n");
        sock2.write(JSON.stringify({ type: "goodbye", pid: 99002 }) + "\n");
        await sleep(2000);

        const stillAlive = existsSync(SOCKET) && existsSync(PID_FILE);
        assert(stillAlive, "daemon still alive immediately after all goodbyes");

        // Wait MUCH longer than the old 10s grace period. Daemon
        // should STILL be alive.
        await sleep(15000);
        const stillAliveAfterLongWait = existsSync(SOCKET);
        assert(stillAliveAfterLongWait,
            "daemon stays alive well past the old grace period (15s wait, no exit)");
    });

    await scenario("5. clearActivity sent when last instance disconnects", async () => {
        // The goodbye from scenario 4 should have triggered clearActivity.
        const log = readLog();
        const clearActivityLines = log.split("\n").filter(l => l.includes("[daemon] clearActivity"));
        assert(clearActivityLines.length > 0,
            `clearActivity sent when last instance left (got ${clearActivityLines.length} entries)`);
    });

    await scenario("6. New client reuses existing daemon (no Discord reconnect)", async () => {
        // The daemon from scenario 4 is still alive. A new client
        // should connect to it (no spawn needed).
        const pidBefore = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);

        const sock3 = await connectClient(99003);
        sendState(sock3, 99003, "ses_newwww_eeee", "Working",
            "new client", "Working · 0 ctx");

        // Wait long enough for throttle (4s) + buffer
        await sleep(6000);

        const pidAfter = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
        assert(pidBefore === pidAfter, `daemon PID unchanged (${pidBefore} == ${pidAfter})`);

        const log = readLog();
        // The most recent daemon-start should be the ORIGINAL one
        // (before scenarios 4-5). If we see a NEW one in scenarios
        // 5-6 it means daemon was killed and respawned (regression).
        const allDaemonStarts = log.split("\n").filter(l => l.includes("[daemon] daemon starting"));
        console.log(`  (debug: total daemon-start entries: ${allDaemonStarts.length})`);

        // The state should have been pushed
        const newPushes = log.split("\n").filter(l =>
            l.includes("[daemon] push") && l.includes("sid=www_eeee"));
        if (newPushes.length === 0) {
            console.log(`  (debug: no push for sid=www_eeee. Recent daemon log:`);
            const recent = log.split("\n").slice(-10).join("\n  ");
            console.log(`  ${recent})`);
        }
        assert(newPushes.length > 0,
            `new client's state pushed (got ${newPushes.length} pushes for sid=www_eeee)`);

        sock3.write(JSON.stringify({ type: "goodbye", pid: 99003 }) + "\n");
        await sleep(500);
    });

    await scenario("7. Daemon survives even longer idle (60s+ total)", async () => {
        // After multiple disconnect/reconnect cycles, daemon should
        // STILL be alive (no auto-exit).
        await sleep(5000);
        const stillAlive = existsSync(SOCKET);
        assert(stillAlive,
            "daemon still alive after multiple disconnect/reconnect cycles");
    });
} finally {
    try { sock1?.end(); } catch {}
    try { sock2?.end(); } catch {}
    await sleep(500);
    // Cleanup: kill the long-lived daemon we spawned
    try {
        const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
        if (pid > 0) try { process.kill(pid, "SIGTERM"); } catch {}
    } catch {}
    await sleep(500);
    try { unlinkSync(SOCKET); } catch {}
    try { unlinkSync(PID_FILE); } catch {}
}

console.log("\n=== Summary ===");
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);

if (failed === 0) {
    console.log("\n  ALL SCENARIOS PASSED");
    process.exit(0);
} else {
    console.log(`\n  ${failed} FAILED`);
    process.exit(1);
}
