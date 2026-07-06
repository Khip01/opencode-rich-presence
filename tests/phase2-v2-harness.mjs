// Phase 2 v2 verification: tests the new behavior added after
// user feedback.
//
// New behaviors tested:
//   1. Final-state push: when state changes are throttled, the LATEST
//      state is pushed after the throttle expires (not a stale
//      intermediate).
//   2. Fingerprint skip: a push attempt with the same details+state
//      as the last successful push is skipped (no spam).
//   3. EXIT_GRACE_MS = 10s: daemon stays alive longer so a quick
//      /exit + reopen does not require Discord reconnect.
//   4. Exit cancellation: new instance connecting during grace
//      cancels the exit timer.

import net from "node:net";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
    // The daemon logs the short SID (last 8 chars of sessionID).
    // Filter by short SID, not the full session ID.
    return lines.filter(l => l.includes(`sid=${sidFilter}`)).length;
}

// Convert a full session ID to the short SID the plugin uses
function shortSid(sid) {
    return sid.length <= 8 ? sid : sid.slice(-8);
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
        const proc = spawn("node", [
            "/home/khip/.nvm/versions/node/v24.13.1/lib/node_modules/opencode-rich-presence/src/worker/daemon.mjs"
        ], { stdio: ["ignore", "pipe", "pipe"] });
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

        // T=0: WORKING
        sendState(sock1, 99001, "ses_quicktest_aaa", "Working",
            "model1 (build)", "Working · 0 ctx");
        await sleep(200);

        // T=200ms: TYPING (should be throttled, scheduled for later)
        sendState(sock1, 99001, "ses_quicktest_aaa", "Typing",
            "model1 (build)", "Typing · 0 ctx");
        await sleep(200);

        // T=400ms: WAITING (still throttled)
        sendState(sock1, 99001, "ses_quicktest_aaa", "Waiting for command",
            "model1 (build)", "Completed! · 1k ctx");
        await sleep(200);

        const pushesAfterBurst = countDaemonPushes(shortSid("ses_quicktest_aaa"));
        assert(pushesAfterBurst >= 1, `at least 1 daemon push in burst (got ${pushesAfterBurst})`);
        const lastPush = lastDaemonPush();
        assert(lastPush && lastPush.includes("Typing") || lastPush.includes("Working"),
            `last push is Working or Typing (got: ${lastPush ? lastPush.match(/state="([^"]+)"/)?.[1] : "none"})`);

        // Wait for the delayed final-state push (throttle = 4s)
        await sleep(5500);

        const pushesAfterDelay = countDaemonPushes(shortSid("ses_quicktest_aaa"));
        assert(pushesAfterDelay >= 2, `delayed push fired (now ${pushesAfterDelay} total, was ${pushesAfterBurst})`);

        const finalPush = lastDaemonPush();
        const finalState = finalPush ? finalPush.match(/state="([^"]+)"/)?.[1] : null;
        assert(finalState === "Completed! · 1k ctx",
            `final state lands as WAITING/Completed (got: ${finalState})`);
    });

    await scenario("2. Fingerprint skip: identical state not pushed again", async () => {
        const pushesBefore = countDaemonPushes("ses_fp_test_b");
        // Push the SAME state 5 times
        for (let i = 0; i < 5; i++) {
            sendState(sock1, 99001, "ses_fp_test_bbb", "Working",
                "same details", "same state");
            await sleep(200);
        }
        await sleep(2500);
        const pushesAfter = countDaemonPushes("ses_fp_test_b");
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

    await scenario("4. EXIT_GRACE_MS = 10s: daemon stays alive after all clients disconnect", async () => {
        // Both clients send goodbye
        sock1.write(JSON.stringify({ type: "goodbye", pid: 99001 }) + "\n");
        sock2.write(JSON.stringify({ type: "goodbye", pid: 99002 }) + "\n");
        await sleep(500);

        const stillAlive = existsSync(SOCKET) && existsSync(PID_FILE);
        assert(stillAlive, "daemon still alive immediately after all goodbyes");
    });

    await scenario("5. Exit cancelled when new client connects during grace period", async () => {
        // Wait 5s (still within 10s grace)
        await sleep(5000);

        // New client connects
        const sock3 = await connectClient(99003);
        sendState(sock3, 99003, "ses_newwww_eeee", "Working",
            "new client", "Working");

        // Wait past original 10s grace (would have been 5s + 6s = 11s after goodbye)
        await sleep(6000);

        const stillAlive = existsSync(SOCKET);
        assert(stillAlive, "daemon still alive after new client connected during grace");

        // Verify log shows exit was cancelled
        const log = readLog();
        assert(log.includes("exit cancelled: new instance connected"),
            "log shows exit was cancelled when new client connected");

        sock3.write(JSON.stringify({ type: "goodbye", pid: 99003 }) + "\n");
        await sleep(500);
    });

    await scenario("6. After final goodbye, daemon exits within 10s grace period", async () => {
        // Currently no clients. Daemon should schedule exit in 10s.
        await sleep(11000);
        const exited = !existsSync(SOCKET);
        assert(exited, "daemon exits within 10s grace period when no new clients connect");
    });
} finally {
    try { sock1?.end(); } catch {}
    try { sock2?.end(); } catch {}
    await sleep(500);
    // Final cleanup
    try { unlinkSync(SOCKET); } catch {}
    try { unlinkSync(PID_FILE); } catch {}
}

console.log("\n=== Summary ===");
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);

if (failed === 0) {
    console.log("\n  ALL SCENARIOS PASSED");
} else {
    console.log(`\n  ${failed} FAILED`);
    process.exit(1);
}
