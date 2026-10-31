import "./test-env.mjs";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs";

// V2 entry harness: drives src/plugin/index.v2.js with a mocked V2
// plugin context (no OpenCode v2 binary needed). Covers the review
// surface for the v2 port:
//   - setup registers prompt/context/tool hooks and completes
//   - prompt transitions a session to Working and pushes to the daemon
//   - the context hook stores the bare model id (one shape, like V1)
//   - native V2 events update state, model, usage, and completion
//   - flipping the presence marker forwards set-enabled to the daemon
//     and gates payload sends until re-enabled
//
// Like presence-toggle, this harness spawns a REAL daemon (from this
// repo's src/worker) inside the OPENCODE_CONFIG_DIR sandbox, then
// SIGTERMs it during cleanup. No Discord is needed: pushes are
// asserted via the activity log with discord=disconnected.

const { ACTIVITY_LOG, CONFIG_PATH, CLIENT_HEARTBEAT } = await import("../src/shared/paths.js");
const { writeState } = await import("../src/shared/presence-state.js");
const { readDaemonPid, isPidAlive } = await import("../src/shared/daemon-liveness.js");
const def = (await import("../src/plugin/index.v2.js")).default;

const SID = "ses_v2harness01";
let contextMessages = [
    { id: "msg_v2_restore_1", type: "assistant", time: { created: Date.now() } },
    { id: "msg_v2_restore_2", type: "assistant", time: { created: Date.now() + 1 } },
];

writeFileSync(CONFIG_PATH, JSON.stringify({
    presence: {
        byState: {
            Working: { state: "{contextLimitCompact} token · {prompts} prompts{{#if effort}} · {effortCapital}{{/if}}" },
            Typing: { state: "{contextLimitCompact} token · {prompts} prompts" },
        },
    },
}), "utf-8");

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
async function waitForCondition(fn, timeoutMs, what) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (fn()) return true;
        await new Promise((r) => setTimeout(r, 100));
    }
    console.log(`    [timeout waiting for ${what || "condition"}]`);
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
let subscribeEvents = [];
let subscribeResolve = null;
let subscribeCalls = 0;
let endStreamRequested = false;
// Controllable session.get() extras: when set, the mock reports session
// time fields (e.g. the server-side idle stamp) to the plugin.
let mockSessionGetTime = null;
const subscribeReady = new Promise((resolve) => { subscribeResolve = resolve; });
const mockCtx = {
    location: { directory: "/tmp/orp-v2-harness-proj" },
    options: {},
    model: {
        list: async () => [
            { id: "gpt-6.1-sol", providerID: "openrouter", limit: { context: 1000000 } },
            { id: "xkiro/openai/gpt-6-luna", providerID: "xkiro", limit: { context: 393216 } },
        ],
    },
    session: {
        hook: async (name, cb) => { hooks[name] = cb; return { dispose: async () => {} }; },
        get: async ({ sessionID }) => ({ id: sessionID, ...(mockSessionGetTime ? { time: mockSessionGetTime } : {}) }),
        context: async () => contextMessages,
    },
    tool: {
        hook: async (name, cb) => { toolHooks[name] = cb; return { dispose: async () => {} }; },
    },
    data: {
        session: {
            message: {
                sync: async (sessionID) => {},
                list: (sessionID) => {
                    return Array.from({ length: 42 }, (_, i) => ({ id: `user_${i}`, type: "user", info: { id: `user_${i}`, type: "user" } }));
                },
            },
        },
    },
    client: {
        message: {
            list: async ({ sessionID, type, limit, cursor }) => {
                if (type === "user") {
                    const allUsers = Array.from({ length: 42 }, (_, i) => ({ id: `user_${i}`, type: "user" }));
                    const start = cursor ? parseInt(cursor, 10) : 0;
                    const page = allUsers.slice(start, start + (limit || 200));
                    const next = start + page.length < allUsers.length ? String(start + page.length) : undefined;
                    return { data: page, cursor: { next } };
                }
                return { data: [], cursor: {} };
            },
        },
    },
    event: {
        subscribe: async function* () {
            subscribeCalls += 1;
            subscribeResolve?.();
            while (true) {
                if (endStreamRequested) {
                    endStreamRequested = false;
                    return;
                }
                if (subscribeEvents.length === 0) {
                    await new Promise((resolve) => { subscribeResolve = resolve; });
                    continue;
                }
                yield subscribeEvents.shift();
            }
        },
    },
};

function emit(event) {
    subscribeEvents.push(event);
    subscribeResolve?.();
    subscribeResolve = null;
}

// Simulate a silent stream end (service restart / location shutdown): the
// generator returns so the for-await loop in the plugin sees a clean end.
function endEventStream() {
    endStreamRequested = true;
    subscribeResolve?.();
    subscribeResolve = null;
}

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
ok(await waitFor(/gpt-6\.1-sol · (Working|Typing)/, 10000, "bare model render"), "context hook renders the bare model id");
ok(!/openrouter\/gpt-6\.1-sol/.test(logText()), "no provider/model compound id leaks into the render");
hooks.context({ sessionID: SID, agent: "build", model: { providerID: "openrouter", id: "gpt-6.1-sol", variant: "high" } });
ok(await waitFor(/1M token · \d+ prompts · High/, 10000, "high effort render"), "V2 standard high effort renders with typography helper");
hooks.context({ sessionID: SID, agent: "build", model: { providerID: "xkiro", id: "gpt-6-luna" } });
ok(await waitFor(/393\.2K token/, 10000, "prefixed model limit render"), "provider-prefixed model id resolves its context limit");
ok(await waitFor(/2 prompts/, 10000, "assistant prompt fallback"), "assistant history repairs the V2 prompt count");

section("stale context cannot mark a new execution completed");
contextMessages = [{
    id: "msg_v2_stale_completed",
    type: "assistant",
    time: { created: Date.now() - 5000, completed: Date.now() - 4000 },
}];
const staleCompletionBefore = countMatches(/poll: assistant message completed/);
hooks.prompt({ sessionID: SID, messageID: "prompt_stale_context_guard" });
ok(await waitFor(/poll state ignored sid=arness01 execution active, latest=assistant/, 10000), "stale completed assistant history is ignored during a new prompt");
await new Promise((r) => setTimeout(r, 500));
ok(
    countMatches(/poll: assistant message completed/) === staleCompletionBefore,
    "stale context does not create a false completed transition",
);
contextMessages = [
    { id: "msg_v2_restore_1", type: "assistant", time: { created: Date.now() } },
    { id: "msg_v2_restore_2", type: "assistant", time: { created: Date.now() + 1 } },
];

section("native V2 events update session state and usage");
await subscribeReady;
const stoppedStepWorkingBefore = countMatches(/\[state\].*-> Working \(session\.step\.ended\)/);
emit({
    type: "session.step.started",
    location: { directory: mockCtx.location.directory },
    created: Date.now(),
    data: {
        sessionID: SID,
        assistantMessageID: "msg_v2_step_1",
        agent: "build",
        model: { providerID: "openrouter", id: "gpt-6.1-sol" },
        started: Date.now(),
    },
});
ok(await waitFor(/session\.step\.started sid=arness01/, 10000), "native step event is consumed");
emit({
    type: "session.step.ended",
    location: { directory: mockCtx.location.directory },
    created: Date.now(),
    data: {
        sessionID: SID,
        assistantMessageID: "msg_v2_step_1",
        finish: "stop",
        cost: 0.0123,
        tokens: { input: 1200, output: 80, reasoning: 20, cache: { read: 300, write: 0 } },
    },
});
ok(await waitFor(/session\.step\.ended sid=arness01/, 10000), "native step completion is consumed");
ok(await waitFor(/sid=arness01 cost=\$0\.0123 ctx=1500/, 10000), "native V2 usage updates token and cost state");
ok(
    countMatches(/\[state\].*-> Working \(session\.step\.ended\)/) === stoppedStepWorkingBefore,
    "a stopped model step does not masquerade as a Working tool step",
);
emit({
    type: "session.execution.succeeded",
    location: { directory: mockCtx.location.directory },
    created: Date.now(),
    data: { sessionID: SID },
});
ok(await waitFor(/-> Waiting for command \(session\.execution\.succeeded\)/, 10000), "native execution success clears the active state");

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

section("context tokens use per-message data not aggregate totals");
emit({
    type: "session.usage.updated",
    location: { directory: mockCtx.location.directory },
    created: Date.now(),
    data: {
        sessionID: SID,
        cost: 1.07,
        tokens: { input: 63000000, output: 500000, reasoning: 200000, cache: { read: 0, write: 0 } },
    },
});
await new Promise((r) => setTimeout(r, 500));
ok(!/63[,.]?7?M? token|63700000/.test(logText()), "aggregate usage totals do not leak into context display");

section("execution.started does not double-count prompts");
const promptCountBefore = countMatches(/\[event\] prompt sid=/);
emit({
    type: "session.execution.started",
    location: { directory: mockCtx.location.directory },
    created: Date.now(),
    data: { sessionID: SID, id: "exec_test_1" },
});
ok(await waitFor(/session\.execution\.started sid=arness01/, 10000), "execution.started event consumed");
await new Promise((r) => setTimeout(r, 500));
const promptCountAfter = countMatches(/\[event\] prompt sid=/);
ok(promptCountAfter === promptCountBefore, `execution.started does not addPrompt (before=${promptCountBefore}, after=${promptCountAfter})`);

section("full prompt count from database");
// SQLite may not have the test session; fallback to session.context
// which returns mock messages. Verify the count is logged.
ok(await waitFor(/full prompt count=\d+/, 15000, "full count"), "full prompt count is logged from database or fallback");

section("stuck guard watchdog releases a lost turn");
// A dead event stream drops session.execution.succeeded and strands the
// guard. With no activity beyond the watchdog timeout the guard must
// release even without an idle stamp (server never stamped one).
process.env.ORP_STUCK_GUARD_MS = "300";
const watchdogBefore = countMatches(/poll watchdog released sid=arness01/);
contextMessages = [{ id: "msg_v2_user_only", type: "user", time: { created: Date.now() - 1000 } }];
hooks.prompt({ sessionID: SID, messageID: "prompt_watchdog_stuck" });
await new Promise((r) => setTimeout(r, 500));
hooks.context({ sessionID: SID, agent: "build", model: { providerID: "openrouter", id: "gpt-6.1-sol" } });
ok(await waitForCount(/poll watchdog released sid=arness01/, watchdogBefore, 15000, "watchdog release"), "watchdog releases the guard after a lost terminal event");
ok(await waitFor(/-> Waiting for command \(poll: watchdog released\)/, 15000), "watchdog recovery renders Waiting for command");
delete process.env.ORP_STUCK_GUARD_MS;
contextMessages = [
    { id: "msg_v2_restore_1", type: "assistant", time: { created: Date.now() } },
    { id: "msg_v2_restore_2", type: "assistant", time: { created: Date.now() + 1 } },
];

section("lost terminal event recovers from server idle");
// The turn finished server-side but the terminal event never arrived. The
// completed answer plus the idle stamp (which only advances on a real idle
// transition) proves the turn is over.
const recoveredBefore = countMatches(/poll recovered terminal state sid=arness01 completed=/);
hooks.prompt({ sessionID: SID, messageID: "prompt_lost_terminal" });
const doneAt = Date.now();
contextMessages = [{ id: "msg_v2_done", type: "assistant", time: { created: doneAt - 3000, completed: doneAt } }];
mockSessionGetTime = { idle: doneAt + 100 };
hooks.context({ sessionID: SID, agent: "build", model: { providerID: "openrouter", id: "gpt-6.1-sol" } });
ok(await waitForCount(/poll recovered terminal state sid=arness01 completed=/, recoveredBefore, 15000, "idle recovery"), "completed answer plus server idle releases the lost terminal event");
ok(await waitFor(/-> Waiting for command \(poll: terminal event recovered\)/, 15000), "recovered execution renders Waiting for command");
mockSessionGetTime = null;

section("stale history cannot fake a terminal recovery");
// The answer completed BEFORE the prompt guard was set, so it belongs to the
// previous turn. Even a fresh idle stamp must not release the guard.
const staleRecBefore = countMatches(/poll recovered terminal state sid=arness01/);
const staleIgnBefore = countMatches(/poll state ignored sid=arness01 execution active, latest=assistant/);
const staleAt = Date.now();
contextMessages = [{ id: "msg_v2_stale2", type: "assistant", time: { created: staleAt - 9000, completed: staleAt - 8000 } }];
mockSessionGetTime = { idle: staleAt };
hooks.prompt({ sessionID: SID, messageID: "prompt_stale_recovery" });
await new Promise((r) => setTimeout(r, 500));
hooks.context({ sessionID: SID, agent: "build", model: { providerID: "openrouter", id: "gpt-6.1-sol" } });
ok(await waitForCount(/poll state ignored sid=arness01 execution active, latest=assistant/, staleIgnBefore, 15000, "stale ignore"), "stale completed history is still ignored while a turn is guarded");
ok(countMatches(/poll recovered terminal state sid=arness01/) === staleRecBefore, "stale history never triggers terminal recovery");
mockSessionGetTime = null;

section("event stream resubscribes after a silent end");
// A silent stream end (service restart) must not kill native events for the
// rest of the session's life: the loop resubscribes and events flow again.
const callsBefore = subscribeCalls;
const resubEventBefore = countMatches(/session\.execution\.started sid=arness01/);
endEventStream();
ok(await waitFor(/event stream ended, resubscribing/, 15000), "silent stream end is detected and logged");
ok(await waitForCondition(() => subscribeCalls > callsBefore, 15000, "resubscribe"), "plugin resubscribes after the stream ends");
emit({
    type: "session.execution.started",
    location: { directory: mockCtx.location.directory },
    created: Date.now(),
    data: { sessionID: SID, id: "exec_resub_1" },
});
ok(await waitForCount(/session\.execution\.started sid=arness01/, resubEventBefore, 15000, "post-resubscribe event"), "native events flow again after resubscribe");

// Finish the resubscribed execution so the session is idle for the
// client-presence tests below.
emit({
    type: "session.execution.succeeded",
    location: { directory: mockCtx.location.directory },
    created: Date.now(),
    data: { sessionID: SID },
});
await new Promise((r) => setTimeout(r, 300));

section("client heartbeat keeps idle presence alive");
// Fresh heartbeat = a client window is attached, so the idle presence
// must not auto-clear no matter how long the user reads.
writeFileSync(CLIENT_HEARTBEAT, "");
{
    const fresh = new Date();
    utimesSync(CLIENT_HEARTBEAT, fresh, fresh);
}
await new Promise((r) => setTimeout(r, 7000));
ok(countMatches(/auto-clear \(no client/) === 0, "fresh heartbeat: presence stays");

section("stale heartbeat auto-clears the presence");
// Age the heartbeat beyond the client timeout: every window is closed and
// nothing runs anymore, so the presence must clear and stop pushing.
{
    const old = new Date(Date.now() - 120000);
    utimesSync(CLIENT_HEARTBEAT, old, old);
}
ok(await waitFor(/auto-clear \(no client window attached and nothing running\)/, 15000), "stale heartbeat triggers auto-clear");
{
    const pushedBefore = countMatches(/sent rendered payload to daemon/);
    await new Promise((r) => setTimeout(r, 7000));
    ok(countMatches(/sent rendered payload to daemon/) === pushedBefore, "pushes stop while auto-cleared");
}

section("a client returning resumes the presence");
{
    const fresh = new Date();
    utimesSync(CLIENT_HEARTBEAT, fresh, fresh);
}
ok(await waitFor(/auto-clear: resumed/, 15000), "fresh heartbeat resumes the presence");
{
    const pushedBefore = countMatches(/sent rendered payload to daemon/);
    ok(await waitForCount(/sent rendered payload to daemon/, pushedBefore, 15000, "post-resume push"), "pushes flow again after resume");
}

section("missing heartbeat file keeps legacy always-on behavior");
// No heartbeat file = no TUI part loaded = the client check is disabled
// and the presence must never auto-clear (legacy behavior).
rmSync(CLIENT_HEARTBEAT, { force: true });
{
    const clearBefore = countMatches(/auto-clear \(no client/);
    await new Promise((r) => setTimeout(r, 7000));
    ok(countMatches(/auto-clear \(no client/) === clearBefore, "no heartbeat file: no auto-clear");
}

section("location.shutdown clears presence");
emit({
    type: "location.shutdown",
    location: { directory: mockCtx.location.directory },
    created: Date.now(),
    data: {},
});
ok(await waitFor(/location\.shutdown, clearing presence/, 10000), "location.shutdown handled and logged");

section("cleanup");
await cleanup();
killSandboxDaemon();
ok(await waitPidGone(10000), "sandbox daemon exited");

console.log("");
console.log(`V2-ENTRY: ${failed === 0 ? "PASSED" : "FAILED"} (${passed} passed, ${failed} failed)`);
try { rmSync(process.env.OPENCODE_CONFIG_DIR, { recursive: true, force: true }); } catch {}
process.exit(failed === 0 ? 0 : 1);
