#!/usr/bin/env node
// Phase 1 regression harness: verifies the plugin captures all SDK
// events, state transitions, and template renders correctly in the
// activity log, without pushing to Discord.
//
// Run: node tests/phase1-harness.mjs
//
// Requires the plugin code to be installed at the standard npm global
// path (so the harness can import it as a real OpenCode plugin would).
// Adjust PLUGIN_ENTRY below if your install path differs.

import { OpencodeRichPresence } from "../src/plugin/index.js";
import { writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PLUGIN_ENTRY = "/home/khip/.nvm/versions/node/v24.13.1/lib/node_modules/opencode-rich-presence/src/plugin/index.js";
const OPENCODE_DIR = join(homedir(), ".config", "opencode");
const ACTIVITY_LOG = join(OPENCODE_DIR, "presence-activity.log");
const STATE_FILE_PREFIX = "presence-state-pid";

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

function shortSid(sid) {
    if (!sid) return "?";
    return sid.length <= 8 ? sid : sid.slice(-8);
}

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

async function loadPlugin(opts = {}) {
    const client = mockClient(opts);
    const handlers = await OpencodeRichPresence({
        client,
        directory: opts.workdir || "/tmp/phase1-test",
    });
    await sleep(800);
    return handlers;
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

function readActivityLog() {
    if (!existsSync(ACTIVITY_LOG)) return "";
    return readFileSync(ACTIVITY_LOG, "utf-8");
}

function stateFileFor(pid) {
    return join(OPENCODE_DIR, `${STATE_FILE_PREFIX}${pid}.txt`);
}

function readStateFile(pid) {
    const p = stateFileFor(pid);
    if (!existsSync(p)) return null;
    return readFileSync(p, "utf-8");
}

async function clearLogs() {
    try { unlinkSync(ACTIVITY_LOG); } catch {}
    try {
        for (const f of readdirSync(OPENCODE_DIR)) {
            if (f.startsWith(STATE_FILE_PREFIX) && f.endsWith(".txt")) {
                try { unlinkSync(join(OPENCODE_DIR, f)); } catch {}
            }
        }
    } catch {}
}

await clearLogs();

let handlers = null;

await scenario("1. Plugin lifecycle", async () => {
    handlers = await loadPlugin();
    const log = readActivityLog();
    assert(log.includes("[load] plugin loaded"), "[load] plugin loaded entry");
    assert(log.includes("[config] appId="), "[config] appId entry");
    assert(log.includes("[models] loaded"), "[models] loaded entry");
    assert(log.match(/\[pid \d+\]/g).length > 0, "PID tagging in log entries");
});

const SID_A = "ses_alpha_aaaaaaaa";
const SHORT_A = shortSid(SID_A);

await scenario("2. chat.message -> WORKING", async () => {
    await handlers["chat.message"]({
        sessionID: SID_A,
        agent: "build",
        model: { modelID: "minimax-m3" },
    });
    await sleep(300);
    const log = readActivityLog();
    assert(log.includes(`chat.message sid=${SHORT_A}`), `chat.message logged with sid=${SHORT_A}`);
    assert(log.includes("Waiting for command -> Working"), "state transition WAITING -> WORKING");
    assert(log.includes("[display] sid="), "display changed event logged");
    assert(log.includes(`[template] sid=${SHORT_A} details=`), "template render logged with sid");
    assert(log.includes("[push] would-push details="), "would-push entry logged");
});

await scenario("3. message.part.updated text -> TYPING", async () => {
    await handlers.event({
        event: {
            type: "message.part.updated",
            properties: {
                part: { type: "text", sessionID: SID_A, text: "Hello " },
            },
        },
    });
    await sleep(300);
    const log = readActivityLog();
    assert(log.includes(`message.part.updated sid=${SHORT_A} type=text(6b)`), "text part with byte length logged");
    assert(log.includes("Working -> Typing"), "state transition WORKING -> TYPING");
    assert(log.includes('"Typing'), "Typing template rendered");
});

await scenario("4. message.part.updated reasoning -> THINKING", async () => {
    await handlers.event({
        event: {
            type: "message.part.updated",
            properties: {
                part: { type: "reasoning", sessionID: SID_A },
            },
        },
    });
    await sleep(300);
    const log = readActivityLog();
    assert(log.includes(`message.part.updated sid=${SHORT_A} type=reasoning`), "reasoning part logged");
    assert(log.includes("Typing -> Thinking"), "state transition TYPING -> THINKING");
});

await scenario("5. message.part.updated tool -> WORKING", async () => {
    await handlers.event({
        event: {
            type: "message.part.updated",
            properties: {
                part: { type: "tool", sessionID: SID_A, tool: "bash" },
            },
        },
    });
    await sleep(300);
    const log = readActivityLog();
    assert(log.includes(`message.part.updated sid=${SHORT_A} type=tool(bash)`), "tool part with name logged");
    assert(log.includes("Thinking -> Working"), "state transition THINKING -> WORKING");
});

await scenario("6. message.part.updated step-finish -> stats", async () => {
    await handlers.event({
        event: {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "step-finish",
                    sessionID: SID_A,
                    tokens: { input: 5000, output: 200, cache: { read: 1500, write: 0 } },
                },
            },
        },
    });
    await sleep(300);
    const log = readActivityLog();
    assert(log.includes("step-finish ctx=6500"), "step-finish context tokens logged");
    const pctMatch = log.match(/step-finish ctx=6500 \(([\d.]+)%\)/);
    assert(pctMatch !== null, "context percentage computed");
    if (pctMatch) {
        const pct = parseFloat(pctMatch[1]);
        assert(pct > 0 && pct < 5, `context percentage is reasonable (got ${pct}%)`);
    }
});

await scenario("7. message.updated completed -> WAITING", async () => {
    await handlers.event({
        event: {
            type: "message.updated",
            properties: {
                info: {
                    id: "msg_done_bbbbbbbbbbbb",
                    sessionID: SID_A,
                    role: "assistant",
                    cost: 0.0042,
                    tokens: { input: 5000, output: 200, cache: { read: 1500, write: 0 } },
                    modelID: "minimax-m3",
                    providerID: "Khip01",
                    time: { completed: Date.now() - 100, created: Date.now() - 5000 },
                },
            },
        },
    });
    await sleep(300);
    const log = readActivityLog();
    assert(log.includes(`message.updated sid=${SHORT_A} role=assistant completed=true`), "message.updated logged with completed=true");
    assert(log.includes("cost=$0.0042"), "cost logged");
    assert(log.includes("-> Waiting for command"), "state transition to WAITING");
    assert(log.includes("[stats]"), "stats entry logged");
    const stateFile = readStateFile(process.pid);
    assert(stateFile !== null, "per-instance state file written");
    if (stateFile) {
        assert(stateFile.includes("DISPLAYED SESSION"), "state file has DISPLAYED SESSION section");
        assert(stateFile.includes("State     : Waiting for command"), "state file shows WAITING state");
        assert(stateFile.includes("RENDERED PRESENCE"), "state file has RENDERED PRESENCE section");
        assert(stateFile.includes("largeImageKey   : opencode-logo-too-rich-presence"), "state file shows asset key");
    }
});

await scenario("8. permission.asked -> ASKING", async () => {
    await handlers.event({
        event: {
            type: "permission.asked",
            properties: { sessionID: SID_A },
        },
    });
    await sleep(300);
    const log = readActivityLog();
    assert(log.includes(`permission.asked sid=${SHORT_A}`), "permission.asked logged");
    assert(log.includes("Waiting for command -> Asking"), "state transition WAITING -> ASKING");
});

await scenario("9. permission.replied -> WORKING", async () => {
    await handlers.event({
        event: {
            type: "permission.replied",
            properties: { sessionID: SID_A, response: "approved" },
        },
    });
    await sleep(300);
    const log = readActivityLog();
    assert(log.includes(`permission.replied sid=${SHORT_A} response=approved`), "permission.replied logged with response");
    assert(log.includes("Asking -> Working"), "state transition ASKING -> WORKING");
});

await scenario("10. session.status busy + session.idle", async () => {
    await handlers.event({
        event: {
            type: "session.status",
            properties: { sessionID: SID_A, status: { type: "busy" } },
        },
    });
    await sleep(200);
    const log1 = readActivityLog();
    assert(log1.includes(`session.status sid=${SHORT_A} status=busy`), "session.status busy logged");

    await handlers.event({
        event: {
            type: "session.idle",
            properties: { sessionID: SID_A },
        },
    });
    await sleep(200);
    const log2 = readActivityLog();
    assert(log2.includes(`session.idle sid=${SHORT_A} status=idle`), "session.idle logged");
});

await scenario("11. session.created + session.deleted", async () => {
    const SID_C = "ses_gamma_cccccccc";
    const SHORT_C = shortSid(SID_C);
    await handlers.event({
        event: {
            type: "session.created",
            properties: { info: { id: SID_C, parentID: SID_A, time: { created: Date.now() } } },
        },
    });
    await sleep(200);
    const log1 = readActivityLog();
    assert(log1.includes(`session.created sid=${SHORT_C}`), `session.created logged (sid=${SHORT_C})`);

    await handlers.event({
        event: {
            type: "session.deleted",
            properties: { info: { id: SID_C } },
        },
    });
    await sleep(200);
    const log2 = readActivityLog();
    assert(log2.includes(`session.deleted sid=${SHORT_C}`), `session.deleted logged (sid=${SHORT_C})`);
    assert(log2.includes(`[queue] removed sid=${SHORT_C}`), `queue removal logged (sid=${SHORT_C})`);
});

await scenario("12. State transitions only logged when state changes", async () => {
    // Filter to OUR pid only to avoid interference from concurrent
    // OpenCode instances (the user's live OpenCode also writes state
    // entries).
    const pidTag = `[pid ${process.pid}]`;
    const escapedPidTag = pidTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escapedPidTag + ".*\\[state\\]", "g");
    const beforeCount = (readActivityLog().match(re) || []).length;
    for (let i = 0; i < 5; i++) {
        await handlers["chat.message"]({
            sessionID: SID_A,
            agent: "build",
            model: { modelID: "minimax-m3" },
        });
        await sleep(50);
    }
    await sleep(300);
    const afterCount = (readActivityLog().match(re) || []).length;
    const growth = afterCount - beforeCount;
    assert(growth <= 1, `no spam: chat.message when already WORKING produces <=1 new state entry (got ${growth})`);
});

await scenario("13. Template fallbacks for unknown model", async () => {
    const SID_D = "ses_fallback_dddddddd";
    await handlers["chat.message"]({
        sessionID: SID_D,
        agent: "plan",
        model: { modelID: "completely-unknown-model-xyz" },
    });
    await sleep(300);
    const log = readActivityLog();
    assert(log.includes(`[session] sid=${shortSid(SID_D)} model=completely-unknown-model-xyz`), "unknown model captured as-is");
    assert(log.match(/\[template\].*details=".*\?.*"/), "template renders with fallback '?' for unknown model");
});

await scenario("14. dispose lifecycle", async () => {
    await handlers.dispose();
    await sleep(200);
    const log = readActivityLog();
    assert(log.includes("disposing (OpenCode shutting down)"), "dispose logged");
    assert(log.includes("[presence] stop"), "presence stop logged");
});

// ─── Multi-instance: spawn separate child processes ────────────────────────

await scenario("15. Multi-instance: 2 child processes writing to same log", async () => {
    const childScript = `
import { OpencodeRichPresence } from "${PLUGIN_ENTRY}";
const sid = process.env.TEST_SID;
const model = process.env.TEST_MODEL;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = {
    session: { list: async () => ({ data: [] }), messages: async () => ({ data: [] }) },
    provider: { list: async () => ({ data: { all: [] } }) },
};
const h = await OpencodeRichPresence({ client, directory: "/tmp/phase1-multi-" + process.pid });
await sleep(500);
await h["chat.message"]({ sessionID: sid, agent: "build", model: { modelID: model } });
await sleep(300);
await h.event({
    event: { type: "message.part.updated", properties: { part: { type: "text", sessionID: sid, text: "x" } } },
});
await sleep(300);
await h.dispose();
process.exit(0);
`;
    writeFileSync("/tmp/phase1-child.mjs", childScript);

    async function spawnChild(env) {
        const cp = await import("node:child_process");
        return new Promise((resolve, reject) => {
            const child = cp.spawn("node", ["/tmp/phase1-child.mjs"], {
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
    await sleep(500);

    const log = readActivityLog();
    const pids = new Set();
    for (const m of log.matchAll(/\[pid (\d+)\]/g)) pids.add(m[1]);
    assert(pids.size >= 2, `at least 2 distinct PIDs in log (got ${pids.size})`);
    assert(log.includes(shortSid("ses_multi_eeeeeeee")), "session from instance 1 logged");
    assert(log.includes(shortSid("ses_multi_ffffffff")), "session from instance 2 logged");

    const files = readdirSync(OPENCODE_DIR).filter((f) => f.startsWith(STATE_FILE_PREFIX) && f.endsWith(".txt"));
    assert(files.length >= 2, `at least 2 per-instance state files exist (got ${files.length})`);
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
