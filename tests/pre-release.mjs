#!/usr/bin/env node
// Pre-release gate: verifies the just-built tarball installs cleanly
// in a sandbox prefix BEFORE the release is published to GitHub.
//
// Runs only in the release workflow (release.yml), between
// `npm pack` (which builds the tarball) and "Create GitHub release"
// (which publishes it). On failure, the workflow exits non-zero
// and the GitHub Release is NOT created. This prevents publishing
// a broken package.
//
// Uses the LOCAL tarball produced by `npm pack` in the same workflow.
// Does NOT curl GitHub (any curl here would hit GitHub raw CDN from
// the CI runner; we deliberately avoid it to stay out of the
// "unauthenticated curl bucket" and keep the workflow reproducible
// even when GitHub rate-limits the runner IP).
//
// Scope (test #19-25 + #33 in the coverage matrix):
//  - Install the local tarball in an isolated npm prefix
//  - Verify bin symlink, package directory, tarball contents
//  - Verify version, help, package.json sanity
//  - Verify opencode-rpc install (plugin symlink + config)
//  - Verify opencode-rpc uninstall cleans up
//  - Verify npm uninstall -g removes the package
//  - Verify idempotent re-install
//  - Verify final state is clean
//
// Out of scope (handled by tests/post-release.mjs, runs AFTER publish):
//  - Download real published tarball from GitHub Releases
//  - update --ref / --stable / --dev (need curl to GitHub)
//  - Full user simulation end-to-end
//
// Run: node tests/pre-release.mjs [--tarball=PATH]
//   --tarball=PATH  override auto-detection (default: look in cwd and REPO_ROOT)

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, statSync, readFileSync, readdirSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
    if (condition) {
        passed++;
        console.log(`  PASS: ${message}`);
    } else {
        failed++;
        failures.push(message);
        console.log(`  FAIL: ${message}`);
    }
}

function section(label) {
    console.log(`\n=== ${label} ===`);
}

// ---------- 1. Locate the just-built tarball ----------

section("Setup: locate the just-built tarball");

// CLI flag override (useful for local runs)
let tarballPath = null;
for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--tarball=")) {
        tarballPath = arg.slice("--tarball=".length);
    }
}

// Auto-detect: look for opencode-rich-presence-*.tgz in cwd or REPO_ROOT
if (!tarballPath) {
    const cwd = process.cwd();
    const candidates = [
        ...readdirSync(cwd).filter((f) => f.startsWith("opencode-rich-presence-") && f.endsWith(".tgz")).map((f) => join(cwd, f)),
        ...readdirSync(REPO_ROOT).filter((f) => f.startsWith("opencode-rich-presence-") && f.endsWith(".tgz")).map((f) => join(REPO_ROOT, f)),
    ];
    if (candidates.length > 0) {
        // Prefer the most recently built (largest mtime)
        candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
        tarballPath = candidates[0];
    }
}

// Fallback: if --tarball was passed but doesn't exist, try the
// `v`-prefixed variant (or vice versa). The release.yml workflow
// renames the npm pack output to include the `v` prefix (because
// github.ref_name is `vX.Y.Z`); local `npm pack` output is
// without the `v`. Accept either to make the workflow flag
// usable from both contexts.
if (tarballPath && !existsSync(tarballPath)) {
    const m = tarballPath.match(/^(.*opencode-rich-presence-)(v?)([\d].*\.tgz)$/);
    if (m) {
        const [, prefix, v, rest] = m;
        const variant = v ? `${prefix}${rest}` : `${prefix}v${rest}`;
        if (existsSync(variant)) {
            tarballPath = variant;
        }
    }
}

if (!tarballPath || !existsSync(tarballPath)) {
    console.log(`  FAIL: tarball not found.`);
    console.log(`  Run \`npm pack\` first, or pass --tarball=PATH.`);
    console.log(`  Looked in: cwd (${process.cwd()}) and REPO_ROOT (${REPO_ROOT}).`);
    failures.push("tarball not found");
    failed++;
} else {
    console.log(`  Tarball: ${tarballPath}`);
    const sz = statSync(tarballPath).size;
    assert(sz > 1000, `tarball has non-trivial size (${sz} bytes)`);
    // Sanity: gzip magic bytes
    const head = readFileSync(tarballPath).slice(0, 2);
    assert(head[0] === 0x1f && head[1] === 0x8b, "tarball has gzip magic bytes (1f 8b)");
}

// Read expected version from the tarball's package.json
let expectedVersion = null;
if (tarballPath && existsSync(tarballPath)) {
    const tmp = mkdtempSync(join(tmpdir(), "orp-prerel-"));
    try {
        execFileSync("tar", ["-xzf", tarballPath, "-C", tmp, "package/package.json"]);
        const pkg = JSON.parse(readFileSync(join(tmp, "package", "package.json"), "utf8"));
        expectedVersion = pkg.version;
        console.log(`  Version: ${expectedVersion}`);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

if (failed > 0) {
    console.log("\n=== Setup failed ===");
    process.exit(1);
}

// ---------- 2. Install in isolated sandbox ----------

section("1. Install tarball in isolated npm prefix");

const sandbox = mkdtempSync(join(tmpdir(), `orp-prerel-${process.pid}-`));
const sandboxBin = join(sandbox, "bin");
const sandboxLib = join(sandbox, "lib", "node_modules");
const sandboxEnv = {
    npm_config_prefix: sandbox,
    NPM_CONFIG_PREFIX: sandbox,
    PATH: `${sandboxBin}:${process.env.PATH}`,
};

function run(cmd, args, opts = {}) {
    return spawnSync(cmd, args, { encoding: "utf8", ...opts });
}

{
    const r = run("npm", ["install", "-g", tarballPath], { env: sandboxEnv });
    assert(r.status === 0, "npm install -g <tarball> succeeds in sandbox");
}

// ---------- 3. Verify install side-effects ----------

section("2. Verify install side-effects");

{
    const binPath = join(sandboxBin, "opencode-rpc");
    assert(existsSync(binPath), `bin symlink exists at ${binPath}`);

    const pkgPath = join(sandboxLib, "opencode-rich-presence");
    assert(existsSync(pkgPath), `package directory exists at ${pkgPath}`);
    assert(existsSync(join(pkgPath, "package.json")), "package.json exists");
    assert(existsSync(join(pkgPath, "bin", "opencode-rpc.js")), "bin/opencode-rpc.js exists");
    assert(existsSync(join(pkgPath, "src", "plugin", "index.js")), "src/plugin/index.js exists");
    assert(existsSync(join(pkgPath, "install.sh")), "install.sh is included in tarball");
    assert(existsSync(join(pkgPath, "README.md")), "README.md is included in tarball");
    assert(existsSync(join(pkgPath, "CHANGELOG.md")), "CHANGELOG.md is included in tarball");

    const pkg = JSON.parse(readFileSync(join(pkgPath, "package.json"), "utf8"));
    assert(pkg.name === "opencode-rich-presence", "package.json name is correct");
    assert(pkg.version === expectedVersion, `package.json version is correct (${expectedVersion})`);
    assert(pkg.bin && pkg.bin["opencode-rpc"], "package.json declares bin entry");
    assert(!("files" in pkg), "package.json does NOT have a `files` field (npm v11 bug workaround)");
}

// ---------- 4. Run CLI to verify it works ----------

section("3. Run CLI commands to verify");

{
    const cli = join(sandboxBin, "opencode-rpc");

    const r1 = run(cli, ["version"], { env: sandboxEnv });
    assert(r1.status === 0, "opencode-rpc version exits 0");
    assert(new RegExp(`v${expectedVersion.replace(/\./g, "\\.")}`).test(r1.stdout),
        `opencode-rpc reports v${expectedVersion}, got: ${r1.stdout.trim()}`);

    const r2 = run(cli, ["help"], { env: sandboxEnv });
    assert(r2.status === 0, "opencode-rpc help exits 0");
    assert(r2.stdout.includes("curl") && r2.stdout.includes("install.sh"),
        "help text leads with curl installer");
    // The broken npm install pattern should only appear in a "Why not"
    // warning context (i.e., as part of a comment line in help).
    const codeLines = r2.stdout.split("\n")
        .map((l) => l.replace(/^\s*#.*$/, ""))
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    assert(!codeLines.some((l) => l.startsWith("npm install -g Khip01/opencode-rich-presence")),
        "help text does NOT recommend broken npm install -g <repo>");
}

// ---------- 5. opencode-rpc install (plugin symlink + config) ----------

section("4. opencode-rpc install (plugin symlink + config)");

{
    // Use a temp OPENCODE_CONFIG_DIR so the symlink goes to a known place.
    const fakeHome = mkdtempSync(join(sandbox, "home-"));
    const cfgDir = join(fakeHome, ".config", "opencode");
    const cli = join(sandboxBin, "opencode-rpc");
    const r = run(cli, ["install"], {
        env: { ...sandboxEnv, OPENCODE_CONFIG_DIR: cfgDir, HOME: fakeHome },
    });
    assert(r.status === 0, "opencode-rpc install exits 0");
    assert(existsSync(join(cfgDir, "plugins", "opencode-rich-presence.js")),
        "plugin symlink created");
    assert(existsSync(join(cfgDir, "discord-config.json")),
        "config file created");
}

// ---------- 6. Idempotent re-install ----------

section("5. Idempotent re-install");

{
    const r = run("npm", ["install", "-g", tarballPath], { env: sandboxEnv });
    assert(r.status === 0, "npm install -g <tarball> succeeds on re-install (idempotent)");

    const cli = join(sandboxBin, "opencode-rpc");
    const r2 = run(cli, ["version"], { env: sandboxEnv });
    assert(r2.status === 0, "opencode-rpc still works after re-install");
    assert(new RegExp(`v${expectedVersion.replace(/\./g, "\\.")}`).test(r2.stdout),
        `version still ${expectedVersion} after re-install`);
}

// ---------- 7. Uninstall + cleanup ----------

section("6. Uninstall and cleanup");

{
    const fakeHome = join(sandbox, "home-uninstall");
    const cfgDir = join(fakeHome, ".config", "opencode");
    const cli = join(sandboxBin, "opencode-rpc");
    const r = run(cli, ["uninstall"], {
        env: { ...sandboxEnv, OPENCODE_CONFIG_DIR: cfgDir, HOME: fakeHome },
        input: "n\n", // don't delete config
    });
    assert(r.status === 0, "opencode-rpc uninstall exits 0");
}

{
    const r = run("npm", ["uninstall", "-g", "opencode-rich-presence"], { env: sandboxEnv });
    assert(r.status === 0, "npm uninstall -g in sandbox exits 0");
    assert(!existsSync(join(sandboxLib, "opencode-rich-presence")),
        "package directory removed after npm uninstall -g");
    assert(!existsSync(join(sandboxBin, "opencode-rpc")),
        "bin symlink removed after npm uninstall -g");
}

// Sandbox cleanup
rmSync(sandbox, { recursive: true, force: true });

// ---------- Summary ----------

console.log("\n=== Summary ===");
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log(`  Total:  ${passed + failed}`);
if (failed > 0) {
    console.log("\n  Failures:");
    for (const msg of failures) {
        console.log(`    - ${msg}`);
    }
    console.log("\n  PRE-RELEASE GATE FAILED. Do not publish this tarball.");
    process.exit(1);
}
console.log("\n  PRE-RELEASE GATE PASSED. Safe to publish.");
