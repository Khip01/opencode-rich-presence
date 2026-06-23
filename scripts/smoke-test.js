#!/usr/bin/env node
// Smoke test: verifies the package is structurally sound without external deps.
// Run: node scripts/smoke-test.js

import { existsSync, readFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const REQUIRED_FILES = [
    "package.json",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "bin/opencode-rpc.js",
    "src/plugin/index.js",
    "src/plugin/template-engine.js",
    "src/plugin/config-resolver.js",
    "src/plugin/coordinator.js",
    "src/plugin/session-state.js",
    "src/plugin/worker-spawner.js",
    "src/plugin/discord-service.js",
    "src/worker/discord-worker.mjs",
    "src/shared/paths.js",
    "src/shared/constants.js",
    "src/shared/logger.js",
    "src/cli/dispatcher.js",
    "src/cli/install.js",
    "src/cli/uninstall.js",
    "src/cli/restart.js",
    "src/cli/update.js",
    "src/cli/info.js",
    "src/cli/help.js",
    "src/cli/version.js",
    "src/cli/prompt.js",
    "src/cli/platform/index.js",
    "src/cli/platform/linux.js",
    "src/cli/platform/macos.js",
    "src/cli/platform/windows.js",
    "config/discord-config.example.json",
    ".github/workflows/test.yml",
    ".github/workflows/release.yml",
];

let errors = 0;
for (const f of REQUIRED_FILES) {
    const p = join(PKG_ROOT, f);
    if (!existsSync(p)) {
        console.error(`  missing: ${f}`);
        errors++;
    }
}

if (errors > 0) {
    console.error(`\n${errors} required file(s) missing.`);
    process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf-8"));
if (pkg.name !== "opencode-rich-presence") {
    console.error(`package.json name mismatch: ${pkg.name}`);
    process.exit(1);
}
if (!pkg.bin || !pkg.bin["opencode-rpc"]) {
    console.error("package.json missing 'opencode-rpc' bin entry");
    process.exit(1);
}
if (!pkg.dependencies || !pkg.dependencies["@xhayper/discord-rpc"]) {
    console.error("package.json missing @xhayper/discord-rpc dependency");
    process.exit(1);
}

// CLI basic execution test
const cliTest = spawnSync("node", [join(PKG_ROOT, "bin/opencode-rpc.js"), "version"], { encoding: "utf-8" });
if (cliTest.status !== 0) {
    console.error("CLI version command failed:");
    console.error(cliTest.stderr);
    process.exit(1);
}

const helpTest = spawnSync("node", [join(PKG_ROOT, "bin/opencode-rpc.js"), "help"], { encoding: "utf-8" });
if (helpTest.status !== 0) {
    console.error("CLI help command failed:");
    console.error(helpTest.stderr);
    process.exit(1);
}

console.log("Smoke test passed.");
console.log(`  ${REQUIRED_FILES.length} files verified`);
console.log(`  package: ${pkg.name}@${pkg.version}`);
console.log(`  CLI version: ${cliTest.stdout.trim()}`);
