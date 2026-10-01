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

section("prompt pushes to the daemon");
hooks.prompt({ sessionID: SID });
ok(await waitFor(/Waiting for command -> Working \(prompt\)/, 30000, "Working transition"), "session transitions to Working on prompt");
ok(await waitFor(/sent rendered payload to daemon/, 30000, "payload send"), "rendered payload sent to daemon");

section("model id keeps one shape");
hooks.context({ sessionID: SID, agent: "build", model: { providerID: "openrouter", id: "gpt-6.1-sol" } });
ok(await waitFor(/gpt-6\.1-sol · Working/, 10000, "bare model render"), "context hook renders the bare model id");
ok(!/openrouter\/gpt-6\.1-sol/.test(logText()), "no provider/model compound id leaks into the render");

section("set-enabled is forwarded and gates sends");
const sentBefore = countMatches(/sent rendered payload to daemon/);
writeState({ presenceEnabled: false });
hooks.prompt({ sessionID: SID });
ok(await waitFor(/forwarded set-enabled=false to daemon/, 15000), "marker flip forwards set-enabled=false");
await new Promise((r) => setTimeout(r, 3000));
ok(countMatches(/sent rendered payload to daemon/) === sentBefore, "payload sends gated while disabled");
writeState({ presenceEnabled: true });
hooks.prompt({ sessionID: SID });
ok(await waitFor(/forwarded set-enabled=true to daemon/, 15000), "re-enable forwards set-enabled=true");
ok(await waitFor(/sent rendered payload to daemon/, 15000) && countMatches(/sent rendered payload to daemon/) > sentBefore, "payload sends resume after re-enable");

section("cleanup");
await cleanup();
const pid = readDaemonPid();
if (pid !== null) {
    try { process.kill(pid, "SIGTERM"); } catch {}
    const start = Date.now();
    while (isPidAlive(pid) && Date.now() - start < 10000) {
        await new Promise((r) => setTimeout(r, 200));
    }
}
ok(pid === null || !isPidAlive(pid), "sandbox daemon exited");

console.log("");
console.log(`V2-ENTRY: ${failed === 0 ? "PASSED" : "FAILED"} (${passed} passed, ${failed} failed)`);
try { rmSync(process.env.OPENCODE_CONFIG_DIR, { recursive: true, force: true }); } catch {}
process.exit(failed === 0 ? 0 : 1);
