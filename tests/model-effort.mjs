import assert from "node:assert/strict";
import {
    extractModelReference,
    findModelInfo,
    modelReferenceFromInfo,
    rememberModelInfo,
    resolveEffort,
} from "../src/plugin/model-effort.js";

let passed = 0;
let failed = 0;

function ok(condition, message) {
    try {
        assert.ok(condition, message);
        passed += 1;
        console.log(`  ✓ ${message}`);
    } catch (error) {
        failed += 1;
        console.log(`  ✗ ${message}`);
        console.log(`    ${error.message}`);
    }
}

console.log("\n== model reference extraction ==");
{
    const ref = extractModelReference("openai/gpt-6.1-sol#high");
    ok(ref.id === "gpt-6.1-sol", "string reference extracts model id");
    ok(ref.providerID === "openai", "string reference extracts provider");
    ok(ref.variant === "high" && ref.hasVariant, "string reference extracts variant");
}
{
    const ref = extractModelReference({ providerID: "openai", id: "gpt-6.1-sol", variant: "deep" });
    ok(ref.id === "gpt-6.1-sol" && ref.providerID === "openai", "object reference extracts provider and id");
    ok(ref.variant === "deep" && ref.hasVariant, "object reference extracts custom variant");
}
{
    const ref = extractModelReference({ modelID: "gpt-6.1-sol#medium" });
    ok(ref.id === "gpt-6.1-sol" && ref.variant === "medium", "legacy modelID suffix extracts variant");
}
{
    const ref = extractModelReference(modelReferenceFromInfo({ model: { providerID: "openai", id: "gpt-6.1-sol", variant: "high" } }));
    ok(ref.id === "gpt-6.1-sol" && ref.variant === "high", "nested model reference keeps variant");
}

console.log("\n== effort resolution ==");
for (const value of ["none", "minimal", "low", "medium", "high", "max", "xhigh"]) {
    ok(resolveEffort(value) === value, `standard variant ${value} resolves directly`);
}
ok(resolveEffort(undefined) === "", "missing variant resolves empty");
ok(resolveEffort("deep", { variants: [{ id: "deep", settings: { reasoningEffort: "HIGH" } }] }) === "high", "custom alias resolves reasoningEffort");
ok(resolveEffort("custom", { variants: [{ id: "custom", settings: {} }] }) === "", "custom alias without effort resolves empty");
ok(resolveEffort("deep", { variants: [{ id: "deep", reasoningEffort: "low" }] }) === "low", "legacy custom reasoningEffort shape resolves");

console.log("\n== model catalog lookup ==");
{
    const catalog = new Map();
    const model = {
        id: "gpt-6.1-sol",
        providerID: "openai",
        variants: [{ id: "deep", settings: { reasoningEffort: "high" } }],
    };
    rememberModelInfo(catalog, model);
    ok(findModelInfo(catalog, "openai", "gpt-6.1-sol") === model, "catalog finds provider-qualified model");
    ok(resolveEffort("deep", findModelInfo(catalog, "openai", "gpt-6.1-sol")) === "high", "catalog model resolves custom alias");
}

console.log(`\n=== Summary ===\n  Passed: ${passed}\n  Failed: ${failed}`);
if (failed) {
    console.log("  FAILED\n");
    process.exit(1);
} else {
    console.log("  ALL SCENARIOS PASSED\n");
}
