import assert from "node:assert/strict";
import { applyReplacements, getTemplateVars, renderTemplate } from "../src/plugin/template-engine.js";
import { renderPresence } from "../src/plugin/local-presence.js";
import { STATE } from "../src/shared/constants.js";

let passed = 0, failed = 0;
function ok(cond, msg) {
    try { assert.ok(cond, msg); passed += 1; console.log(`  \u2713 ${msg}`); }
    catch (e) { failed += 1; console.log(`  \u2717 ${msg}`); console.log(`    ${e.message}`); }
}

// ── applyReplacements: wildcard modes ────────────────────────────
console.log("\n== wildcard modes ==");

// exact: no *
{
    const vars = { mode: "plan", modelName: "Muse Spark Free" };
    applyReplacements(vars, [{ vars: ["mode"], from: "plan", to: "Planning" }]);
    ok(vars.mode === "Planning", "exact: plan -> Planning");
}
{
    const vars = { mode: "planMode" };
    applyReplacements(vars, [{ vars: ["mode"], from: "plan", to: "Planning" }]);
    ok(vars.mode === "planMode", "exact: plan does not match planMode");
}

// prefix: core*
{
    const vars = { modelName: "Free Trial Model" };
    applyReplacements(vars, [{ vars: ["modelName"], from: "Free*", to: "" }]);
    ok(vars.modelName === " Trial Model", "prefix Free* strips leading Free");
}
{
    const vars = { modelName: "Muse Spark Free" };
    applyReplacements(vars, [{ vars: ["modelName"], from: "Free*", to: "" }]);
    ok(vars.modelName === "Muse Spark Free", "prefix Free* does not match Muse Spark Free");
}

// suffix: *core
{
    const vars = { modelName: "Muse Spark Free" };
    applyReplacements(vars, [{ vars: ["modelName"], from: "* Free", to: "" }]);
    ok(vars.modelName === "Muse Spark", "suffix * Free strips trailing  Free");
}
{
    const vars = { modelName: "Muse Spark Free Edition" };
    applyReplacements(vars, [{ vars: ["modelName"], from: "* Free", to: "" }]);
    ok(vars.modelName === "Muse Spark Free Edition", "suffix * Free does not match when not at end");
}

// contains: *core* (global)
{
    const vars = { mode: "plan-plan" };
    applyReplacements(vars, [{ vars: ["mode"], from: "*plan*", to: "x" }]);
    ok(vars.mode === "x-x", "contains *plan* replaces all occurrences");
}
{
    const vars = { modelName: "Muse Spark Free Free" };
    applyReplacements(vars, [{ vars: ["modelName"], from: "*Free*", to: "" }]);
    ok(vars.modelName === "Muse Spark  ", "contains *Free* removes all");
}

// suffix with plain Free (no leading space): *Free matches trailing "Free" including MoFree context
{
    const vars = { modelName: "MoFree" };
    applyReplacements(vars, [{ vars: ["modelName"], from: "*Free", to: "" }]);
    ok(vars.modelName === "Mo", "*Free on MoFree -> Mo");
}
{
    const vars = { modelName: "MoFree" };
    applyReplacements(vars, [{ vars: ["modelName"], from: "* Free", to: "" }]);
    ok(vars.modelName === "MoFree", "* Free on MoFree stays MoFree (needs space)");
}

// ── multi-var, multi-rule chaining ──────────────────────────────
console.log("\n== multi-var and chaining ==");

{
    const vars = {
        model: "oc/muse-spark-1.2-contributor-free",
        modelCode: "muse-spark-1.2-contributor-free",
        modelName: "Muse Spark 1.2 Contributor Free",
        modelNameLower: "muse spark 1.2 contributor free",
    };
    // Case-sensitive: * Free (capital F) only matches vars that end with capital Free.
    applyReplacements(vars, [{ vars: ["model", "modelName", "modelCode", "modelNameLower"], from: "* Free", to: "" }]);
    ok(vars.model === "oc/muse-spark-1.2-contributor-free", "multi-var: model full has no ' Free' suffix -> untouched");
    ok(vars.modelName === "Muse Spark 1.2 Contributor", "multi-var: modelName Free stripped with * Free");
    ok(vars.modelNameLower === "muse spark 1.2 contributor free", "multi-var: modelNameLower untouched by * Free (lowercase free, case-sensitive)");
}
{
    // To also strip the lowercase variant, add a second rule.
    const vars = {
        modelNameLower: "muse spark 1.2 contributor free",
    };
    applyReplacements(vars, [{ vars: ["modelNameLower"], from: "* free", to: "" }]);
    ok(vars.modelNameLower === "muse spark 1.2 contributor", "multi-var: modelNameLower stripped with * free (lowercase)");
}
{
    const vars = { modelName: "Muse Spark 1.2 Contributor Free" };
    applyReplacements(vars, [
        { vars: ["modelName"], from: "*Free", to: "" },
        { vars: ["modelName"], from: "* ", to: "" }, // chain: trailing space left after Free removal
    ]);
    ok(vars.modelName === "Muse Spark 1.2 Contributor", "chaining: Free then trailing space");
}

// ── case sensitive ──────────────────────────────────────────────
console.log("\n== case sensitive ==");

{
    const vars = { modelName: "Muse Spark Free" };
    applyReplacements(vars, [{ vars: ["modelName"], from: "Free", to: "" }]);
    ok(vars.modelName === "Muse Spark Free", "exact Free does not match 'Muse Spark Free' whole string");
}
{
    const vars = { modelName: "Muse Spark Free" };
    applyReplacements(vars, [{ vars: ["modelName"], from: "* Free", to: "" }]);
    ok(vars.modelName === "Muse Spark", "suffix * Free is case-sensitive and matches");
}
{
    const vars = { modelName: "Muse Spark free" };
    applyReplacements(vars, [{ vars: ["modelName"], from: "* Free", to: "" }]);
    ok(vars.modelName === "Muse Spark free", "case mismatch: * Free does not match lowercase free");
}
{
    const vars = { modelName: "Muse Spark FREE" };
    applyReplacements(vars, [{ vars: ["modelName"], from: "*FREE", to: "" }]);
    ok(vars.modelName === "Muse Spark ", "*FREE exact casing only");
}

// ── invalid rules (skipped) ────────────────────────────────────
console.log("\n== invalid rules skipped ==");

{
    const vars = { modelName: "Muse Spark Free" };
    applyReplacements(vars, [{ vars: ["modelName"], from: "", to: "" }]);
    ok(vars.modelName === "Muse Spark Free", "empty from skipped");
}
{
    const vars = { modelName: "Muse Spark Free" };
    applyReplacements(vars, [{ vars: ["modelName"], from: "*", to: "" }]);
    ok(vars.modelName === "Muse Spark Free", "from * only skipped");
}
{
    const vars = { modelName: "Muse Spark Free" };
    applyReplacements(vars, [{ vars: ["modelName"], from: "**", to: "" }]);
    ok(vars.modelName === "Muse Spark Free", "from ** skipped");
}
{
    const vars = { modelName: "Muse Spark Free" };
    applyReplacements(vars, [{ vars: ["modelName"], from: "a*b", to: "" }]);
    ok(vars.modelName === "Muse Spark Free", "interior * skipped");
}
{
    const vars = { modelName: "Muse Spark Free" };
    applyReplacements(vars, [{ vars: ["unknownVar"], from: "Free", to: "" }]);
    ok(vars.modelName === "Muse Spark Free", "unknown var skipped");
}
{
    const vars = { modelName: "Muse Spark Free" };
    applyReplacements(vars, [{ vars: [], from: "*Free", to: "" }]);
    ok(vars.modelName === "Muse Spark Free", "empty vars array skipped");
}

// ── duplicate identik (same vn+from+to) dedup ───────────────────
console.log("\n== duplicate handling ==");

{
    const vars = { modelName: "Muse Spark Free" };
    applyReplacements(vars, [
        { vars: ["modelName"], from: "* Free", to: "" },
        { vars: ["modelName"], from: "* Free", to: "" }, // identical dup
    ]);
    ok(vars.modelName === "Muse Spark", "duplicate identical skipped, first applies");
}
{
    const vars = { modelName: "Muse Spark FREE" };
    applyReplacements(vars, [
        { vars: ["modelName"], from: "* Free", to: "" },
        { vars: ["modelName"], from: "* FREE", to: "" }, // different casing -> not dupe, second matches
    ]);
    ok(vars.modelName === "Muse Spark", "different casing not considered duplicate, second rule strips FREE");
}

// ── getTemplateVars + replacements integration ───────────────────
console.log("\n== getTemplateVars + replacements ==");

{
    const v = getTemplateVars({ model: "oc/muse-spark-1.2-contributor-free", state: STATE.WORKING }, [{ vars: ["modelName"], from: "* Free", to: "" }]);
    ok(v.modelName === "Muse Spark 1.2 Contributor", "getTemplateVars applies replacement to modelName");
    ok(v.model === "oc/muse-spark-1.2-contributor-free", "getTemplateVars leaves model untouched when not targeted");
}
{
    const v = getTemplateVars({ mode: "plan", state: STATE.WORKING }, [{ vars: ["mode"], from: "plan", to: "Planning" }]);
    ok(v.mode === "Planning", "getTemplateVars exact on mode");
}

// ── renderPresence + replacements ────────────────────────────────
console.log("\n== renderPresence + replacements ==");

{
    const session = {
        sessionID: "ses_repl",
        model: "oc/muse-spark-1.2-contributor-free",
        state: STATE.WORKING,
        provider: "oc",
        lastActivity: Date.now(),
        startedAt: Date.now(),
    };
    const config = {
        largeImageKey: "opencode-logo",
        replacements: [{ vars: ["modelName"], from: "* Free", to: "" }],
        templates: {
            details: "{modelName} ({mode})",
            state: "{modelCode}",
            largeImageText: "{model} full",
            smallImageText: "{provider}",
            byState: { [STATE.WORKING]: { details: "{modelName} ({mode})", state: "{modelCode}" } },
        },
    };
    const r = renderPresence(session, config);
    ok(r.details.includes("Muse Spark 1.2 Contributor"), "renderPresence details has Free stripped");
    ok(!r.details.includes("Free"), "renderPresence details no Free remains");
    ok(r.state === "muse-spark-1.2-contributor-free", "renderPresence state unaffected when not targeted");
}

// ── renderTemplate after replacement (fallback syntax still works) ─
console.log("\n== renderTemplate after replacement ==");

{
    const v = getTemplateVars({ model: "oc/muse", state: STATE.WORKING }, []);
    ok(renderTemplate("{modelName|fallback}", v) === "Muse", "fallback not used when present after replacement");
}
{
    const v = getTemplateVars(null, [{ vars: ["modelName"], from: "Muse", to: "" }]);
    ok(v.modelName === "?", "null session modelName is ?, replacement on ? with exact Muse does not match");
}

// ── Summary ─────────────────────────────────────────────────────
console.log(`\n=== Summary ===\n  Passed: ${passed}\n  Failed: ${failed}`);
if (failed) { console.log("  FAILED\n"); process.exit(1); } else { console.log("  ALL SCENARIOS PASSED\n"); }
