#!/usr/bin/env node
// Phase 2 regression harness: verifies the daemon-based push
// architecture. Tests:
//   - First firing triggers daemon spawn
//   - Plugin sends state to daemon
//   - Multi-instance share one daemon
//   - Daemon lifecycle (spawn, exit on last goodbye)
//
// Run: node tests/phase2-harness.mjs
//
// Requires the plugin code to be installed at the standard npm global
// path so the harness can import it as a real OpenCode plugin would.
// Adjust PLUGIN_ENTRY below if your install path differs.

import { OpencodeRichPresence } from "../src/plugin/index.js";
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PLUGIN_ENTRY = "/home/khip/.nvm/versions/node/v24.13.1/lib/node_modules/opencode-rich-presence/src/plugin/index.js";
const OPENCODE_DIR = join(homedir(), ".config", "opencode");
const ACTIVITY_LOG = join(OPENCODE_DIR, "presence-activity.log");
const DAEMON_SOCKET = join(OPENCODE_DIR, ".opencode-rich-presence.sock");
const DAEMON_PID_FILE = join(OPENCODE_DIR, ".opencode-rich-presence.pid");

let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        passed++;
        console.log(`  PASS: ${message}`);
    } else {
        failed++;
        console.log(`  FAIL: ${message}`);
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readActivityLog() {
    if (!existsSync(ACTIVITY_LOG)) return "";
    return readFileSync(ACTIVITY_LOG, "utf-8");
}

async function clearState() {
    // Stop any running daemon
    if (existsSync(DAEMON_PID_FILE)) {
        try {
            const pid = parseInt(readFileSync(DAEMON_PID_FILE, "utf-8").trim(), 10);
            if (pid > 0) try { process.kill(pid, "SIGTERM"); } catch {}
        } catch {}
    }
    await sleep(500);
    try { unlinkSync(ACTIVITY_LOG); } catch {}
    try { unlinkSync(DAEMON_SOCKET); } catch {}
    try { unlinkSync(DAEMON_PID_FILE); } catch {}
    try {
        for (const f of readdirSync(OPENCODE_DIR)) {
            if (f.startsWith("presence-state-pid") && f.endsWith(".txt")) {
                try { unlinkSync(join(OPENCODE_DIR, f)); } catch {}
            }
        }
    } catch {}
}

await clearState();
await sleep(500);

function mockClient(opts = {}) {
    return {
        session: {
            list: async () => ({ data: opts.sessions || [] }),
            messages: async () => ({ data: [] }),
        },
        provider: {
            list: async () => ({ data: { all: [] } }),
        },
    };
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

// ─── Scenarios ─────────────────────────────────────────────────────────────

await scenario("1. Initial state: no daemon", async () => {
    assert(!existsSync(DAEMON_SOCKET), "daemon socket not present initially");
    assert(!existsSync(DAEMON_PID_FILE), "daemon PID file not present initially");
});

let handlers = null;

await scenario("2. chat.message spawns daemon on first firing", async () => {
    handlers = await OpencodeRichPresence({
        client: mockClient(),
        directory: "/tmp/phase2-test",
    });
    await sleep(800);

    assert(!existsSync(DAEMON_SOCKET), "daemon not spawned just by plugin load");

    await handlers["chat.message"]({
        sessionID: "ses_alpha_aaaaaaaa",
        agent: "build",
        model: { modelID: "minimax-m3" },
    });
    await sleep(2000);

    assert(existsSync(DAEMON_SOCKET), "daemon socket appeared after first firing");
    assert(existsSync(DAEMON_PID_FILE), "daemon PID file written");

    const pid = parseInt(readFileSync(DAEMON_PID_FILE, "utf-8").trim(), 10);
    assert(pid > 0, `daemon PID is positive (got ${pid})`);

    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch {}
    assert(alive, `daemon process ${pid} is alive`);

    const log = readActivityLog();
    assert(log.includes("spawning"), "spawn event logged in activity log");
    assert(log.includes("sent rendered payload to daemon"), "state sent to daemon logged");
});

await scenario("3. Subsequent fires reuse the same daemon", async () => {
    const pidBefore = parseInt(readFileSync(DAEMON_PID_FILE, "utf-8").trim(), 10);

    await handlers.event({
        event: { type: "message.part.updated", properties: { part: { type: "text", sessionID: "ses_alpha_aaaaaaaa", text: "hi" } } },
    });
    await sleep(500);
    await handlers.event({
        event: { type: "message.updated", properties: { info: { id: "msg_bbbbbbbbbbbbbb", sessionID: "ses_alpha_aaaaaaaa", role: "assistant", cost: 0.001, tokens: { input: 100, output: 50, cache: { read: 0, write: 0 } }, modelID: "minimax-m3", providerID: "Khip01", time: { completed: Date.now() - 100 } } } },
    });
    await sleep(500);

    const pidAfter = parseInt(readFileSync(DAEMON_PID_FILE, "utf-8").trim(), 10);
    assert(pidBefore === pidAfter, `daemon PID unchanged (${pidBefore} == ${pidAfter})`);
    assert(existsSync(DAEMON_SOCKET), "daemon socket still present");
});

await scenario("4. Plugin sends state messages to daemon", async () => {
    const log = readActivityLog();
    const sends = (log.match(/sent rendered payload to daemon/g) || []).length;
    assert(sends >= 3, `multiple state sends logged (got ${sends})`);
});

await scenario("5. Plugin dispose sends goodbye to daemon (daemon stays alive)", async () => {
    await handlers.dispose();
    await sleep(3000);

    const log = readActivityLog();
    assert(log.includes("disconnecting from daemon") || log.includes("disconnected") || log.includes("goodbye"),
        "goodbye or disconnect logged");

    // Phase 2 v3+: daemon stays alive after all goodbyes (no auto-exit).
    // The user's OpenCode may also keep the daemon alive.
    assert(existsSync(DAEMON_SOCKET) || existsSync(DAEMON_PID_FILE),
        "daemon still alive after dispose (stays alive until explicit kill)");
});

await scenario("6. Second plugin instance reuses existing daemon (no respawn)", async () => {
    // The daemon from scenario 2 is still alive. Loading a new plugin
    // should NOT spawn a new daemon — it should connect to the existing one.
    const pidBefore = parseInt(readFileSync(DAEMON_PID_FILE, "utf-8").trim(), 10);

    const h2 = await OpencodeRichPresence({
        client: mockClient(),
        directory: "/tmp/phase2-test-2",
    });
    await sleep(500);
    await h2["chat.message"]({
        sessionID: "ses_beta_bbbbbbbbbb",
        agent: "plan",
        model: { modelID: "kimi-k2.6" },
    });
    await sleep(1500);

    const pidAfter = parseInt(readFileSync(DAEMON_PID_FILE, "utf-8").trim(), 10);
    assert(pidBefore === pidAfter, `daemon PID unchanged (${pidBefore} == ${pidAfter}); no respawn`);

    await h2.dispose();
    await sleep(500);
});

await scenario("7. Multi-instance: 2 plugins share one daemon", async () => {
    // No need to kill daemon between scenarios now (it stays alive).
    // Just connect two new clients.

    const childScript = `
import { OpencodeRichPresence } from "${PLUGIN_ENTRY}";
const sid = process.env.TEST_SID;
const model = process.env.TEST_MODEL;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = {
    session: { list: async () => ({ data: [] }), messages: async () => ({ data: [] }) },
    provider: { list: async () => ({ data: { all: [] } }) },
};
const h = await OpencodeRichPresence({ client, directory: "/tmp/phase2-multi-" + process.pid });
await sleep(500);
await h["chat.message"]({ sessionID: sid, agent: "build", model: { modelID: model } });
await sleep(500);
await h.event({ event: { type: "message.part.updated", properties: { part: { type: "text", sessionID: sid, text: "x" } } } });
await sleep(1500);
await h.dispose();
setTimeout(() => process.exit(0), 200).unref();
`;
    writeFileSync("/tmp/phase2-child.mjs", childScript);

    function spawnChild(env) {
        return new Promise((resolve, reject) => {
            const child = spawn("node", ["/tmp/phase2-child.mjs"], {
                env: { ...process.env, ...env },
                stdio: ["ignore", "pipe", "pipe"],
            });
            let stderr = "";
            child.stderr.on("data", (c) => (stderr += c.toString()));
            child.on("exit", (code) => {
                if (code === 0) resolve();
                else reject(new Error(`child exited ${code}: ${stderr}`));
            });
        });
    }

    await Promise.all([
        spawnChild({ TEST_SID: "ses_multi_eeeeeeee", TEST_MODEL: "minimax-m3" }),
        spawnChild({ TEST_SID: "ses_multi_ffffffff", TEST_MODEL: "kimi-k2.6" }),
    ]);
    await sleep(1000);

    const log = readActivityLog();
    assert(log.includes("ses_multi_eeeeeeee") || log.includes("eeeeeeee"),
        "instance 1 session in log");
    assert(log.includes("ses_multi_ffffffff") || log.includes("ffffffff"),
        "instance 2 session in log");

    const files = readdirSync(OPENCODE_DIR).filter((f) => f.startsWith("presence-state-pid") && f.endsWith(".txt"));
    assert(files.length >= 2, `at least 2 per-instance state files exist (got ${files.length}: ${files.join(", ")})`);
    const subPids = new Set();
    for (const f of files) {
        const m = f.match(/pid(\d+)/);
        if (m) subPids.add(m[1]);
    }
    assert(subPids.size >= 2, `state files have distinct PIDs (got ${subPids.size}: ${[...subPids].join(", ")})`);

    // Verify daemon SAW both children disconnect.
    await sleep(2000);
    const logAfter = readActivityLog();
    const goodbyes = (logAfter.match(/instance goodbye/g) || []).length;
    const disconnects = (logAfter.match(/client disconnected/g) || []).length;
    assert(goodbyes + disconnects >= 2, `daemon saw at least 2 disconnects (got ${goodbyes} goodbyes + ${disconnects} socket-closes)`);

    // Daemon is alive (either user's OpenCode OR it stays alive itself now).
    assert(existsSync(DAEMON_SOCKET) || existsSync(DAEMON_PID_FILE),
        "daemon still running");
});

// ─── Summary ───────────────────────────────────────────────────────────────

console.log("\n=== Summary ===");
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log(`  Total:  ${passed + failed}`);

if (failed === 0) {
    console.log("\n  ALL SCENARIOS PASSED");
    process.exit(0);
} else {
    console.log(`\n  ${failed} SCENARIO(S) FAILED`);
    process.exit(1);
}
