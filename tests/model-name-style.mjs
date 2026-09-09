import assert from "node:assert/strict";
import {
    formatModelCode,
    formatModelName,
    getTemplateVars,
    renderTemplate,
} from "../src/plugin/template-engine.js";
import { renderPresence } from "../src/plugin/local-presence.js";
import { STATE } from "../src/shared/constants.js";

let passed = 0;
let failed = 0;

function ok(cond, msg) {
    try {
        assert.ok(cond, msg);
        passed += 1;
        console.log(`  ✓ ${msg}`);
    } catch (e) {
        failed += 1;
        console.log(`  ✗ ${msg}`);
        console.log(`    ${e.message}`);
    }
}

// ── formatModelCode ──────────────────────────────────────────────
console.log("\n== formatModelCode ==");

ok(formatModelCode("oc/muse-spark-1.2-contributor-free") === "muse-spark-1.2-contributor-free", 'single-level prefix: oc/... -> code');
ok(formatModelCode("kc/stepfun/step-3.7-flash:free") === "step-3.7-flash:free", "multi-level prefix: kc/stepfun/... -> code");
ok(formatModelCode("a/b/c/d-model") === "d-model", "three-level prefix -> code");
ok(formatModelCode("no-slash-model") === "no-slash-model", "no slash -> identity");
ok(formatModelCode("a/b") === "b", "single slash two segments");
ok(formatModelCode("?") === "?", "fallback ? stays ?");
ok(formatModelCode(null) === "?", "null stays ?");
ok(formatModelCode(undefined) === "?", "undefined stays ?");
ok(formatModelCode("") === "?", "empty string stays ?");

// ── formatModelName ──────────────────────────────────────────────
console.log("\n== formatModelName ==");

ok(formatModelName("muse-spark-1.2-contributor-free") === "Muse Spark 1.2 Contributor Free", "Title Case: muse-spark-1.2-contributor-free");
ok(formatModelName("step-3.7-flash:free") === "Step 3.7 Flash Free", "dash and colon replaced: step-3.7-flash:free");
ok(formatModelName("snake_case_model") === "Snake Case Model", "underscore replaced");
ok(formatModelName("mix_of-delims:here") === "Mix Of Delims Here", "mixed delims");
ok(formatModelName("?") === "?", "fallback ? stays ?");
ok(formatModelName(null) === "?", "null stays ?");
ok(formatModelName("") === "?", "empty stays ?");

// dots preserved
ok(formatModelName("model-1.2.3-beta") === "Model 1.2.3 Beta", "dots preserved as part of version");

// ── getTemplateVars model variants ───────────────────────────────
console.log("\n== getTemplateVars model variants ==");

function varsForModel(raw) {
    return getTemplateVars({ model: raw, state: STATE.WORKING });
}

{
    const v = varsForModel("oc/muse-spark-1.2-contributor-free");
    ok(v.model === "oc/muse-spark-1.2-contributor-free", "vars.model is raw full");
    ok(v.modelCode === "muse-spark-1.2-contributor-free", "vars.modelCode is code");
    ok(v.modelName === "Muse Spark 1.2 Contributor Free", "vars.modelName is Title Case");
    ok(v.modelNameLower === "muse spark 1.2 contributor free", "vars.modelNameLower is lowercase");
}

{
    const v = varsForModel("kc/stepfun/step-3.7-flash:free");
    ok(v.model === "kc/stepfun/step-3.7-flash:free", "multi-prefix raw preserved");
    ok(v.modelCode === "step-3.7-flash:free", "multi-prefix code");
    ok(v.modelName === "Step 3.7 Flash Free", "multi-prefix name");
    ok(v.modelNameLower === "step 3.7 flash free", "multi-prefix lower");
}

{
    const v = getTemplateVars({ state: STATE.WORKING }); // no model
    ok(v.model === "?", "missing model -> ?");
    ok(v.modelCode === "?", "missing modelCode -> ?");
    ok(v.modelName === "?", "missing modelName -> ?");
    ok(v.modelNameLower === "?", "missing modelNameLower -> ?");
}

{
    const v = getTemplateVars(null); // null session
    ok(v.model === "?", "null session model -> ?");
    ok(v.modelCode === "?", "null session modelCode -> ?");
    ok(v.modelName === "?", "null session modelName -> ?");
    ok(v.modelNameLower === "?", "null session modelNameLower -> ?");
}

// ── renderTemplate integration ──────────────────────────────────
console.log("\n== renderTemplate integration ==");

{
    const v = varsForModel("oc/muse-spark-1.2-contributor-free");
    ok(renderTemplate("{model}", v) === "oc/muse-spark-1.2-contributor-free", "render {model}");
    ok(renderTemplate("{modelCode}", v) === "muse-spark-1.2-contributor-free", "render {modelCode}");
    ok(renderTemplate("{modelName}", v) === "Muse Spark 1.2 Contributor Free", "render {modelName}");
    ok(renderTemplate("{modelNameLower}", v) === "muse spark 1.2 contributor free", "render {modelNameLower}");
    ok(
        renderTemplate("{model} | {modelCode} | {modelName}", v) ===
            "oc/muse-spark-1.2-contributor-free | muse-spark-1.2-contributor-free | Muse Spark 1.2 Contributor Free",
        "mix all variants in one string",
    );
    ok(renderTemplate("{modelCode|OpenCode}", v) === "muse-spark-1.2-contributor-free", "fallback not used when present");
}

{
    const v = getTemplateVars(null);
    ok(renderTemplate("{modelCode|OpenCode}", v) === "?", "null session modelCode is defined (?), fallback not used");
}

// ── renderPresence integration ──────────────────────────────────
console.log("\n== renderPresence integration ==");

{
    const session = {
        sessionID: "ses_model_test",
        model: "oc/muse-spark-1.2-contributor-free",
        state: STATE.WORKING,
        provider: "oc",
        lastActivity: Date.now(),
        startedAt: Date.now(),
    };
    const config = {
        largeImageKey: "opencode-logo",
        templates: {
            details: "{modelName} ({mode})",
            state: "{modelCode}",
            largeImageText: "{model} full",
            smallImageText: "{modelNameLower}",
            byState: {
                [STATE.WORKING]: {
                    details: "{modelName} ({mode})",
                    state: "{modelCode}",
                },
            },
        },
    };
    const rendered = renderPresence(session, config);
    ok(rendered.details.includes("Muse Spark 1.2 Contributor Free"), "renderPresence Working details uses modelName");
    ok(rendered.state === "muse-spark-1.2-contributor-free", "renderPresence Working state uses modelCode");
    ok(rendered.largeImageText === "oc/muse-spark-1.2-contributor-free full", "renderPresence largeImageText uses model");
    ok(rendered.smallImageText === "muse spark 1.2 contributor free", "renderPresence smallImageText uses modelNameLower");
}

// ── Summary ─────────────────────────────────────────────────────
console.log(`\n=== Summary ===\n  Passed: ${passed}\n  Failed: ${failed}`);
if (failed) {
    console.log("  FAILED — some assertions did not pass.\n");
    process.exit(1);
} else {
    console.log("  ALL SCENARIOS PASSED\n");
}
