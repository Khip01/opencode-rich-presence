#!/usr/bin/env node
// Regression test for template selection: a session in the
// "Waiting for command" state must NOT be treated as idle.
//
// Bug being guarded: a completed session (state "Waiting for
// command") used to fall through to the `idle` template set, whose
// details hardcode "• $0 spent". The accumulated cost was correct
// (never reset) but the rendered text showed $0. The fix routes a
// WAITING session through `chooseTemplates` so
// `byState["Waiting for command"]` (dynamic {costCompact}) takes
// effect. Only a truly absent session (no session at all) uses the
// idle template set.
//
// Run: node tests/template-selection.mjs

// MUST come first so OPENCODE_CONFIG_DIR is set before plugin
// import paths are computed at module-load time.
import "./test-env.mjs";

import { renderPresence } from "../src/plugin/local-presence.js";
import { STATE } from "../src/shared/constants.js";

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

// Config shaped like loadConfig() output. idle.details hardcodes
// "$0 spent" (the exact bug scenario); byState templates use the
// dynamic cost expression.
function makeConfig() {
    return {
        appId: "1512803991300476989",
        largeImageKey: "opencode-logo-too-opencode-rpc",
        largeImageText: "OpenCode",
        currency: "$",
        templates: {
            details: "{model} ({mode}) {costCompact} spent",
            state: "{state}",
            largeImageText: "OpenCode",
            smallImageText: "Provider: {provider}",
            byState: {
                "Waiting for command": {
                    details: "{model} ({mode}) {{#if cost == \"free\"}} • $0 spent{{else}}{costCompact} spent{{/if}}",
                    state: "Completed! • {prompts} prompts",
                },
                Working: {
                    details: "{model} ({mode}) Working",
                    state: "Working",
                },
                Thinking: {
                    details: "{model} ({mode}) Thinking",
                    state: "Thinking",
                },
                Typing: {
                    details: "{model} ({mode}) Typing",
                    state: "Typing",
                },
                Asking: {
                    details: "{model} ({mode}) Asking",
                    state: "Asking",
                },
            },
            idle: {
                details: "{model|OpenCode} ({mode|standby}) • $0 spent",
                state: "Completed! • {prompts|0} prompts",
            },
            home: {
                details: "OpenCode",
                state: "Ready",
            },
        },
    };
}

// Session shaped like a SessionState with real accumulated cost.
function makeSession(overrides = {}) {
    return {
        sessionID: "ses_regression_abcdef12",
        provider: "Khip01",
        model: "deepseek-v4-pro",
        mode: "plan",
        state: STATE.WAITING,
        startedAt: Date.now() - 60000,
        modelLimit: 1000000,
        contextTokens: 61000,
        totalTokens: 61000,
        cost: 0.2644,
        currency: "$",
        promptCount: 4658,
        ...overrides,
    };
}

console.log("\n=== 1. WAITING session renders byState dynamic cost (not idle) ===");
{
    const rendered = renderPresence(makeSession(), makeConfig());
    assert(rendered !== null, "renderPresence returns a payload");
    assert(rendered.details.includes("0.26 spent"), `details shows real cost (got "${rendered.details}")`);
    assert(!rendered.details.includes("$0 spent"), "details does NOT hardcode $0 spent");
    assert(rendered.state.includes("Completed!"), `state uses byState WAITING text (got "${rendered.state}")`);
}

console.log("\n=== 2. WAITING session with zero cost still shows free/$0 (not idle bypass) ===");
{
    const rendered = renderPresence(makeSession({ cost: 0 }), makeConfig());
    assert(rendered.details.includes("$0 spent"), `zero cost shows $0 spent (got "${rendered.details}")`);
}

console.log("\n=== 3. Null session (no session at all) uses idle templates ===");
{
    const rendered = renderPresence(null, makeConfig());
    assert(rendered !== null, "renderPresence(null) returns a payload");
    assert(rendered.details.includes("$0 spent"), "null session idle shows $0 spent");
    // Distinctive: the idle template is the ONLY source with a
    // hardcoded "$0 spent" in this config; byState WAITING uses the
    // dynamic cost expression, so a WAITING session never renders
    // this literal when cost is non-zero (asserted in scenario 1).
    assert(!rendered.details.includes("0.26"), "null session has no session cost");
}

console.log("\n=== 4. Active states still use byState templates ===");
{
    for (const st of [STATE.WORKING, STATE.THINKING, STATE.TYPING, STATE.ASKING]) {
        const rendered = renderPresence(makeSession({ state: st }), makeConfig());
        const expected = st;
        assert(rendered.state === expected, `state ${st} renders byState template (got "${rendered.state}")`);
    }
}

console.log("\n=== 5. WAITING uses byState even when idle template exists ===");
{
    // Same config: idle.details hardcodes $0, byState WAITING uses
    // dynamic cost. The WAITING session must pick the byState one.
    const rendered = renderPresence(makeSession(), makeConfig());
    const srcIdle = "• $0 spent";
    assert(rendered.details.includes("0.26 spent") && !rendered.details.includes("$0 spent"),
        "WAITING session selects dynamic-cost byState template, not idle");
    void srcIdle;
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
