import "./test-env.mjs";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";

// V2 entry harness: drives src/plugin/index.v2.js with a mocked V2
// plugin context (no OpenCode v2 binary needed). Covers the review
// surface for the v2 port:
//   - setup registers prompt/context/tool hooks and completes
//   - prompt transitions a session to Working and pushes to the daemon
//   - the context hook stores the bare model id (one shape, like V1)
//   - flipping the presence marker forwards set-enabled to the daemon
//     and gates payload sends until re-enabled
//
// Like presence-toggle, this harness spawns a REAL daemon (from this
// repo's src/worker) inside the OPENCODE_CONFIG_DIR sandbox, then
// SIGTERMs it during cleanup. No Discord is needed: pushes are
// asserted via the activity log with discord=disconnected.

const { ACTIVITY_LOG } = await import("../src/shared/paths.js");
const { writeState } = await import("../src/shared/presence-state.js");
const { readDaemonPid, isPidAlive } = await import("../src/shared/daemon-liveness.js");
const def = (await import("../src/plugin/index.v2.js")).default;

const SID = "ses_v2harness01";

let passed = 0, failed = 0;
function ok(cond, msg) {
    try { assert.ok(cond, msg); passed += 1; console.log(`  ✓ ${msg}`); }
    catch (e) { failed += 1; console.log(`  ✗ ${msg}`); console.log(`    ${e.message}`); }
}
function section(name) { console.log(`\n== ${name} ==`); }
function logText() {
    try { return readFileSync(ACTIVITY_LOG, "utf-8"); } catch { return ""; }
}
async function waitFor(re, timeoutMs, what) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (re.test(logText())) return true;
        await new Promise((r) => setTimeout(r, 200));
    }
    console.log(`    [timeout waiting for ${what || re}]\n    last log lines:\n    ` + logText().trim().split("\n").slice(-4).join("\n    "));
    return false;
}
function countMatches(re) {
    const m = logText().match(new RegExp(re.source, "g"));
    return m ? m.length : 0;
}
// Existence checks can match lines from an earlier section, so for
// lines that repeat (forwards, payload sends) wait for the count to
// grow past a baseline instead.
async function waitForCount(re, before, timeoutMs, what) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (countMatches(re) > before) return true;
        await new Promise((r) => setTimeout(r, 200));
    }
    console.log(`    [timeout waiting for ${what || re} to grow past ${before}]`);
    return false;
}
function killSandboxDaemon() {
    const pid = readDaemonPid();
    if (pid === null || !isPidAlive(pid)) return false;
    try { process.kill(pid, "SIGTERM"); } catch { return false; }
    return true;
}
async function waitPidGone(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const pid = readDaemonPid();
        if (pid === null || !isPidAlive(pid)) return true;
        await new Promise((r) => setTimeout(r, 200));
    }
    return false;
}

const hooks = {};
const toolHooks = {};
const mockCtx = {
    location: { directory: "/tmp/orp-v2-harness-proj" },
    options: {},
    model: {
        list: async () => [
            { id: "gpt-6.1-sol", providerID: "openrouter", limit: { context: 1000000 } },
        ],
    },
    session: {
        hook: async (name, cb) => { hooks[name] = cb; return { dispose: async () => {} }; },
        get: async ({ sessionID }) => ({ id: sessionID }),
        context: async () => [],
    },
    tool: {
        hook: async (name, cb) => { toolHooks[name] = cb; return { dispose: async () => {} }; },
    },
    event: {
        subscribe: () => (async function* () {})(),
    },
};

section("setup registers v2 hooks");
ok(def && typeof def === "object" && def.id === "opencode-rich-presence-v2", "default export carries the v2 plugin id");
const cleanup = await def.setup(mockCtx);
ok(typeof hooks.prompt === "function", "prompt hook registered");
ok(typeof hooks.context === "function", "context hook registered");
ok(typeof toolHooks["execute.before"] === "function", "tool execute.before hook registered");
ok(await waitFor(/v2 plugin setup complete/, 10000), "setup completes in activity log");

section("missed set-enabled is not committed");
ok(await waitFor(/set-enabled forward skipped \(not connected\): true/, 10000, "setup-time skip"), "setup-time forward skipped without daemon");

section("prompt pushes to the daemon");
const forwardedTrueBefore = countMatches(/forwarded set-enabled=true to daemon/);
hooks.prompt({ sessionID: SID });
ok(await waitFor(/Waiting for command -> Working \(prompt\)/, 30000, "Working transition"), "session transitions to Working on prompt");
ok(await waitFor(/sent rendered payload to daemon/, 30000, "payload send"), "rendered payload sent to daemon");
ok(await waitForCount(/forwarded set-enabled=true to daemon/, forwardedTrueBefore, 30000, "setup-skip redelivery"), "skipped forward retried once reachable");

section("model id keeps one shape");
hooks.context({ sessionID: SID, agent: "build", model: { providerID: "openrouter", id: "gpt-6.1-sol" } });
ok(await waitFor(/gpt-6\.1-sol · Working/, 10000, "bare model render"), "context hook renders the bare model id");
ok(!/openrouter\/gpt-6\.1-sol/.test(logText()), "no provider/model compound id leaks into the render");

section("set-enabled is forwarded and gates sends");
const sentBefore = countMatches(/sent rendered payload to daemon/);
const forwardedFalseBefore = countMatches(/forwarded set-enabled=false to daemon/);
writeState({ presenceEnabled: false });
hooks.prompt({ sessionID: SID });
ok(await waitForCount(/forwarded set-enabled=false to daemon/, forwardedFalseBefore, 15000, "disable forward"), "marker flip forwards set-enabled=false");
await new Promise((r) => setTimeout(r, 3000));
ok(countMatches(/sent rendered payload to daemon/) === sentBefore, "payload sends gated while disabled");
const forwardedTrueBefore2 = countMatches(/forwarded set-enabled=true to daemon/);
writeState({ presenceEnabled: true });
hooks.prompt({ sessionID: SID });
ok(await waitForCount(/forwarded set-enabled=true to daemon/, forwardedTrueBefore2, 15000, "re-enable forward"), "re-enable forwards set-enabled=true");
ok(await waitFor(/sent rendered payload to daemon/, 15000) && countMatches(/sent rendered payload to daemon/) > sentBefore, "payload sends resume after re-enable");

section("interval tick forwards without a prompt");
const promptsBefore = countMatches(/\[event\] prompt sid=/);
const forwardedFalseBefore2 = countMatches(/forwarded set-enabled=false to daemon/);
writeState({ presenceEnabled: false });
// No prompt here: the 5s tick must redeem the flip on its own.
ok(await waitForCount(/forwarded set-enabled=false to daemon/, forwardedFalseBefore2, 15000, "tick forward"), "tick forwards the marker flip");
ok(countMatches(/\[event\] prompt sid=/) === promptsBefore, "no prompt needed for the tick forward");
const forwardedTrueBefore3 = countMatches(/forwarded set-enabled=true to daemon/);
writeState({ presenceEnabled: true });
ok(await waitForCount(/forwarded set-enabled=true to daemon/, forwardedTrueBefore3, 15000, "tick re-enable"), "tick forwards re-enable");

section("cleanup");
await cleanup();
killSandboxDaemon();
ok(await waitPidGone(10000), "sandbox daemon exited");

console.log("");
console.log(`V2-ENTRY: ${failed === 0 ? "PASSED" : "FAILED"} (${passed} passed, ${failed} failed)`);
try { rmSync(process.env.OPENCODE_CONFIG_DIR, { recursive: true, force: true }); } catch {}
process.exit(failed === 0 ? 0 : 1);
