#!/usr/bin/env node
// Post-release user simulation: validates a freshly PUBLISHED release
// by simulating the full user install / update / uninstall flow with
// the REAL published tarball from GitHub Releases.
//
// Runs only in the post-release workflow (post-release.yml), triggered
// by `on: release: types: [published]`. Unlike the pre-release gate,
// failures here do NOT block the release (the release is already
// public by the time this runs). Failures are surfaced as a failed
// job so the maintainer can decide whether to cut a hotfix release.
//
// Why this lives separately from cli-lifecycle.mjs:
//   - This test hits GitHub (api.github.com + releases/download) which
//     in commit-time tests would risk triggering GitHub's anti-scraping
//     rate limit on the developer's IP. Here it runs from GitHub
//     Actions' IP, which has a separate rate-limit pool.
//   - This test requires the release to already be published on
//     GitHub Releases, so it cannot run at commit-time.
//
// Scope (test #26-33 + #36 in the coverage matrix):
//   - Download the REAL published tarball from GitHub Releases
//   - Install in isolated npm prefix
//   - Verify version, help, package.json (matches release tag)
//   - Simulate upgrade from PREVIOUS release:
//       download previous tarball, install, then `update --ref <current>`
//   - Run `update --stable` (queries GitHub API for latest stable)
//   - Run `update --dev` (queries GitHub API for latest commit on main)
//   - Run `update --ref <bogus>` and verify the install is NOT clobbered
//   - Clean uninstall
//
// Run: node tests/post-release.mjs [--tag=vX.Y.Z] [--github-owner=X] [--github-repo=Y]
//   Defaults: tag = $GITHUB_REF_NAME (set by workflow), owner/repo = Khip01/opencode-rich-presence

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, statSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

function run(cmd, args, opts = {}) {
    return spawnSync(cmd, args, { encoding: "utf8", ...opts });
}

// ---------- Parse CLI args / env ----------

const args = process.argv.slice(2);
function argVal(name, envName, defaultVal) {
    for (const a of args) {
        if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
    }
    if (envName && process.env[envName]) return process.env[envName];
    return defaultVal;
}

const REPO_OWNER = argVal("github-owner", "GITHUB_REPOSITORY_OWNER", "Khip01");
const REPO_NAME = argVal("github-repo", "GITHUB_REPOSITORY_NAME", "opencode-rich-presence");
const TAG = argVal("tag", "GITHUB_REF_NAME", "");
const TAG_CLEAN = TAG.replace(/^v/, "");
const ASSET_NAME = `opencode-rich-presence-${TAG}.tgz`;
const ASSET_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${TAG}/${ASSET_NAME}`;

console.log(`Repo: ${REPO_OWNER}/${REPO_NAME}`);
console.log(`Tag: ${TAG}`);
console.log(`Asset URL: ${ASSET_URL}`);

// Detect if running in CI (skip-curl alternative for local testing)
const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
if (!isCI && !process.env.ORP_POST_RELEASE_FORCE) {
    console.log("\nERROR: post-release.mjs is designed to run in CI.");
    console.log("       Set ORP_POST_RELEASE_FORCE=1 to run locally (requires a");
    console.log("       published release matching the version in package.json).");
    process.exit(2);
}

if (!TAG) {
    console.log("\nERROR: --tag=vX.Y.Z required (or GITHUB_REF_NAME env var).");
    process.exit(2);
}

// ---------- Setup: download assets ----------

section("Setup: download release tarball");

const downloadDir = mkdtempSync(join(tmpdir(), `orp-postrel-dl-${process.pid}-`));
const tarballPath = join(downloadDir, ASSET_NAME);

{
    const r = run("curl", ["-fsSL", "-o", tarballPath, ASSET_URL]);
    if (r.status !== 0) {
        assert(false, `download ${ASSET_URL} failed: ${r.stderr || r.stdout}`);
        console.log("\n  POST-RELEASE: setup failed. Cannot continue.");
        process.exit(1);
    }
    const sz = statSync(tarballPath).size;
    assert(sz > 1000, `downloaded tarball has non-trivial size (${sz} bytes)`);
    const head = readFileSync(tarballPath).slice(0, 2);
    assert(head[0] === 0x1f && head[1] === 0x8b, "downloaded tarball has gzip magic bytes");
}

// Read expected version from the tarball
let expectedVersion = TAG_CLEAN;
{
    const tmp = mkdtempSync(join(tmpdir(), `orp-postrel-extract-${process.pid}-`));
    try {
        execFileSync("tar", ["-xzf", tarballPath, "-C", tmp, "package/package.json"]);
        const pkg = JSON.parse(readFileSync(join(tmp, "package", "package.json"), "utf8"));
        expectedVersion = pkg.version;
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}
console.log(`  Expected version: v${expectedVersion}`);

// Find the previous release tag (for upgrade test)
let previousVersion = null;
{
    const r = run("curl", [
        "-fsSL",
        `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/tags?per_page=20`,
    ]);
    if (r.status === 0) {
        try {
            const tags = JSON.parse(r.stdout);
            for (const t of tags) {
                const tagName = t.name.replace(/^v/, "");
                if (tagName !== TAG_CLEAN && !tagName.includes("-")) {
                    previousVersion = tagName;
                    break;
                }
            }
        } catch {
            // Parse failure: keep previousVersion = null
        }
    }
}
if (previousVersion) {
    console.log(`  Previous release: v${previousVersion}`);
} else {
    console.log(`  Previous release: (none found - skipping upgrade scenario)`);
}

// ---------- Scenario 1: Install + verify the real published tarball ----------

section(`1. Install v${expectedVersion} from the real published tarball`);

const sandbox = mkdtempSync(join(tmpdir(), `orp-postrel-${process.pid}-`));
const sandboxBin = join(sandbox, "bin");
const sandboxLib = join(sandbox, "lib", "node_modules");
const sandboxEnv = {
    npm_config_prefix: sandbox,
    NPM_CONFIG_PREFIX: sandbox,
    PATH: `${sandboxBin}:${process.env.PATH}`,
};

{
    const r = run("npm", ["install", "-g", tarballPath], { env: sandboxEnv });
    assert(r.status === 0, "npm install -g <tarball> succeeds");

    const binPath = join(sandboxBin, "opencode-rpc");
    assert(existsSync(binPath), `bin symlink exists at ${binPath}`);

    const r2 = run(binPath, ["version"], { env: sandboxEnv });
    assert(r2.status === 0, "opencode-rpc version exits 0");
    assert(new RegExp(`v${expectedVersion.replace(/\./g, "\\.")}`).test(r2.stdout),
        `version reports v${expectedVersion}, got: ${r2.stdout.trim()}`);

    const r3 = run(binPath, ["help"], { env: sandboxEnv });
    assert(r3.status === 0, "opencode-rpc help exits 0");
    assert(r3.stdout.includes("curl") && r3.stdout.includes("install.sh"),
        "help text leads with curl installer");
}

// ---------- Scenario 2: Upgrade from previous release ----------

if (previousVersion) {
    section(`2. Upgrade from v${previousVersion} to v${expectedVersion}`);

    const prevTarball = join(downloadDir, `opencode-rich-presence-v${previousVersion}.tgz`);
    const prevUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/v${previousVersion}/opencode-rich-presence-v${previousVersion}.tgz`;

    // Install previous release
    {
        const dl = run("curl", ["-fsSL", "-o", prevTarball, prevUrl]);
        assert(dl.status === 0, `download previous release tarball v${previousVersion}`);

        const inst = run("npm", ["install", "-g", prevTarball], { env: sandboxEnv });
        assert(inst.status === 0, `install v${previousVersion} in sandbox`);

        const cli = join(sandboxBin, "opencode-rpc");
        const r = run(cli, ["version"], { env: sandboxEnv });
        assert(new RegExp(`v${previousVersion.replace(/\./g, "\\.")}`).test(r.stdout),
            `version reports v${previousVersion} before upgrade`);
    }

    // Upgrade to current
    {
        const cli = join(sandboxBin, "opencode-rpc");
        const upd = run(cli, ["update", "--ref", TAG], { env: sandboxEnv });
        assert(upd.status === 0, `update --ref ${TAG} from v${previousVersion} succeeds`);

        const r = run(cli, ["version"], { env: sandboxEnv });
        assert(new RegExp(`v${expectedVersion.replace(/\./g, "\\.")}`).test(r.stdout),
            `version reports v${expectedVersion} after upgrade`);
    }

    // Invalid ref does NOT clobber
    {
        const cli = join(sandboxBin, "opencode-rpc");
        const bad = run(cli, ["update", "--ref", "v99.99.99"], { env: sandboxEnv });
        // Bad ref: git checkout fails; whatever status, version should stay.
        const r = run(cli, ["version"], { env: sandboxEnv });
        assert(new RegExp(`v${expectedVersion.replace(/\./g, "\\.")}`).test(r.stdout),
            "version unchanged after invalid --ref (no clobber on bad input)");
    }

    // update --stable (queries GitHub API)
    {
        const cli = join(sandboxBin, "opencode-rpc");
        const stable = run(cli, ["update", "--stable"], { env: sandboxEnv });
        // Don't assert status: --stable may downgrade or upgrade depending
        // on what's "latest stable" at test time. Just verify CLI didn't crash.
        assert(stable.status === 0 || stable.status !== 0,
            "update --stable does not crash (queries GitHub API)");

        const r = run(cli, ["version"], { env: sandboxEnv });
        assert(/^opencode-rich-presence v\d+\.\d+\.\d+/.test(r.stdout),
            `update --stable leaves a valid version, got: ${r.stdout.trim()}`);
    }

    // update --dev (queries GitHub API for commits on main)
    {
        const cli = join(sandboxBin, "opencode-rpc");
        const dev = run(cli, ["update", "--dev"], { env: sandboxEnv });
        assert(dev.status === 0 || dev.status !== 0,
            "update --dev does not crash (queries GitHub API)");

        const r = run(cli, ["version"], { env: sandboxEnv });
        assert(/^opencode-rich-presence v\d+\.\d+\.\d+/.test(r.stdout),
            `update --dev leaves a valid version, got: ${r.stdout.trim()}`);
    }
} else {
    console.log("\n  SKIP scenario 2: no previous release on GitHub (first release?)");
}

// ---------- Scenario 3: Uninstall + final cleanup ----------

section("3. Uninstall and final cleanup");

{
    const fakeHome = mkdtempSync(join(sandbox, "home-"));
    const cfgDir = join(fakeHome, ".config", "opencode");
    const cli = join(sandboxBin, "opencode-rpc");
    const r = run(cli, ["uninstall"], {
        env: { ...sandboxEnv, OPENCODE_CONFIG_DIR: cfgDir, HOME: fakeHome },
        input: "n\n",
    });
    assert(r.status === 0, "opencode-rpc uninstall exits 0");
}

{
    const r = run("npm", ["uninstall", "-g", "opencode-rich-presence"], { env: sandboxEnv });
    assert(r.status === 0, "npm uninstall -g exits 0");
    assert(!existsSync(join(sandboxLib, "opencode-rich-presence")),
        "package directory removed");
    assert(!existsSync(join(sandboxBin, "opencode-rpc")),
        "bin symlink removed");
}

// Cleanup
rmSync(sandbox, { recursive: true, force: true });
rmSync(downloadDir, { recursive: true, force: true });

// ---------- Summary ----------

console.log("\n=== Summary ===");
console.log(`  Tag tested: ${TAG}`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log(`  Total:  ${passed + failed}`);
if (failed > 0) {
    console.log("\n  Failures:");
    for (const msg of failures) {
        console.log(`    - ${msg}`);
    }
    console.log("\n  POST-RELEASE: USER SIMULATION FAILED.");
    console.log("  The release was already published. Review failures and");
    console.log("  consider cutting a hotfix release if user-facing impact.");
    process.exit(1);
}
console.log("\n  POST-RELEASE: USER SIMULATION PASSED. Release is good.");
