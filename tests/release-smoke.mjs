#!/usr/bin/env node
// Release smoke test: verifies the update flow against a freshly
// PUBLISHED release on GitHub. Run ONLY in the release workflow
// (after `npm pack` builds the tarball but before the GitHub
// release is published), so this never runs on a fresh commit.
//
// This complements tests/cli-lifecycle.mjs (which runs at commit
// time on every push to main). The commit-time test cannot exercise
// `update --ref` because that flow does a `git clone` from GitHub
// and checks out the ref — only meaningful when the ref actually
// exists as a published tag.
//
// What this verifies:
//
//  1. The just-built tarball installs cleanly in a sandbox prefix.
//  2. `opencode-rpc update --ref vX.Y.Z` upgrades from the previous
//     release to the new one.
//  3. Invalid `--ref` does NOT clobber the existing install.
//  4. `update --stable` and `update --dev` both work end-to-end.
//
// On failure: the release workflow exits non-zero and the GitHub
// Release is NOT created. This prevents publishing a broken package.
//
// Run: node tests/release-smoke.mjs

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, statSync, readFileSync, readdirSync, rmSync, renameSync, writeFileSync } from "node:fs";
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

function run(cmd, args, opts = {}) {
    return spawnSync(cmd, args, { encoding: "utf8", ...opts });
}

// Read version from package.json (the source we're testing).
const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
const currentVersion = packageJson.version;

// ---------- Setup ----------

section("Setup: identify current version and resolve previous release");

console.log(`  Current version: v${currentVersion}`);

// Find the previous published release tag. Used to install the
// "before" version, then upgrade to the current one.
let previousVersion = null;
{
    const r = run("curl", [
        "-fsSL",
        "https://api.github.com/repos/Khip01/opencode-rich-presence/tags?per_page=20",
    ]);
    if (r.status === 0) {
        try {
            const tags = JSON.parse(r.stdout);
            for (const t of tags) {
                const tagName = t.name.replace(/^v/, "");
                if (tagName !== currentVersion && !tagName.includes("-")) {
                    previousVersion = tagName;
                    break;
                }
            }
        } catch {
            // Parse failure: fall through to error below.
        }
    }
    if (!previousVersion) {
        console.log(`  FAIL: could not resolve previous release tag from GitHub API`);
        console.log(`  Failures:`);
        failures.push("could not resolve previous release tag");
        failed++;
        process.exit(1);
    }
}
console.log(`  Previous release: v${previousVersion}`);

// Locate the just-built tarball. The release workflow runs `npm pack`
// in cwd, producing opencode-rich-presence-<version>.tgz. The workflow
// then renames it to opencode-rich-presence-${{ github.ref_name }}.tgz
// (which includes the `v` prefix). We look for either name.
let tarballPath = null;
{
    const candidates = [
        `opencode-rich-presence-v${currentVersion}.tgz`,
        `opencode-rich-presence-${currentVersion}.tgz`,
    ];
    for (const c of candidates) {
        const p = join(REPO_ROOT, c);
        if (existsSync(p)) {
            tarballPath = p;
            break;
        }
    }
}
if (!tarballPath) {
    console.log(`  FAIL: tarball not found in ${REPO_ROOT}`);
    console.log(`  Expected one of: opencode-rich-presence-{v}${currentVersion}.tgz`);
    failures.push("tarball not found");
    failed++;
    process.exit(1);
}
console.log(`  Tarball: ${tarballPath}`);

// ---------- Helpers ----------

async function downloadAndInstall(version) {
    const sb = mkdtempSync(join(tmpdir(), `orp-release-smoke-${process.pid}-`));
    const env = {
        npm_config_prefix: sb,
        NPM_CONFIG_PREFIX: sb,
        PATH: `${join(sb, "bin")}:${process.env.PATH}`,
    };
    const tarball = join(sb, `orp-${version}.tgz`);
    const url = `https://github.com/Khip01/opencode-rich-presence/releases/download/v${version}/opencode-rich-presence-v${version}.tgz`;
    const dl = run("curl", ["-fsSL", "-o", tarball, url]);
    if (dl.status !== 0) {
        return { sandbox: sb, error: `download v${version} failed` };
    }
    const inst = run("npm", ["install", "-g", tarball], { env });
    if (inst.status !== 0) {
        return { sandbox: sb, error: `install v${version} failed: ${inst.stderr}` };
    }
    return { sandbox: sb, env, tarball };
}

// ---------- Scenario 1: install the just-built tarball ----------

section(`1. Install v${currentVersion} from the just-built tarball`);

{
    const sb = mkdtempSync(join(tmpdir(), `orp-release-smoke-current-${process.pid}-`));
    const env = {
        npm_config_prefix: sb,
        NPM_CONFIG_PREFIX: sb,
        PATH: `${join(sb, "bin")}:${process.env.PATH}`,
    };
    const inst = run("npm", ["install", "-g", tarballPath], { env });
    assert(inst.status === 0, "npm install -g <tarball> succeeds in sandbox");

    const binPath = join(sb, "bin", "opencode-rpc");
    assert(existsSync(binPath), `bin symlink exists at ${binPath}`);

    const r = run(binPath, ["version"], { env });
    assert(r.status === 0, "sandbox opencode-rpc version exits 0");
    assert(new RegExp(`v${currentVersion.replace(/\./g, "\\.")}`).test(r.stdout),
        `sandbox opencode-rpc reports v${currentVersion}, got: ${r.stdout.trim()}`);

    rmSync(sb, { recursive: true, force: true });
}

// ---------- Scenario 2: update flow from previous release ----------

section(`2. Upgrade from v${previousVersion} to v${currentVersion}`);

const before = await downloadAndInstall(previousVersion);
if (before.error) {
    assert(false, `setup (install v${previousVersion}): ${before.error}`);
} else {
    assert(true, `setup: installed v${previousVersion} in sandbox`);

    // Verify version before update.
    {
        const r = run(join(before.sandbox, "bin", "opencode-rpc"), ["version"], { env: before.env });
        assert(new RegExp(`v${previousVersion.replace(/\./g, "\\.")}`).test(r.stdout),
            `sandbox shows v${previousVersion} before update`);
    }

    // Update to current version via CLI.
    {
        const upd = run(join(before.sandbox, "bin", "opencode-rpc"),
            ["update", "--ref", `v${currentVersion}`], { env: before.env });
        assert(upd.status === 0, `update --ref v${currentVersion} from v${previousVersion} succeeds`);

        const r = run(join(before.sandbox, "bin", "opencode-rpc"), ["version"], { env: before.env });
        assert(new RegExp(`v${currentVersion.replace(/\./g, "\\.")}`).test(r.stdout),
            `sandbox shows v${currentVersion} after update --ref v${currentVersion}, got: ${r.stdout.trim()}`);
    }

    // Invalid ref does not clobber.
    {
        const bad = run(join(before.sandbox, "bin", "opencode-rpc"),
            ["update", "--ref", "v99.99.99"], { env: before.env });
        // 404 from git fetch. Whatever status, version should stay.
        const r = run(join(before.sandbox, "bin", "opencode-rpc"), ["version"], { env: before.env });
        assert(new RegExp(`v${currentVersion.replace(/\./g, "\\.")}`).test(r.stdout),
            "version unchanged after invalid update --ref (no clobber on bad input)");
    }

    // update --stable re-installs latest stable tag.
    {
        const stable = run(join(before.sandbox, "bin", "opencode-rpc"),
            ["update", "--stable"], { env: before.env });
        assert(stable.status === 0, "update --stable succeeds");

        const r = run(join(before.sandbox, "bin", "opencode-rpc"), ["version"], { env: before.env });
        assert(new RegExp(`v${currentVersion.replace(/\./g, "\\.")}`).test(r.stdout) && /\(stable\)/.test(r.stdout),
            `sandbox shows v${currentVersion} (stable) after update --stable, got: ${r.stdout.trim()}`);
    }

    // update --dev installs latest commit on main.
    {
        const dev = run(join(before.sandbox, "bin", "opencode-rpc"),
            ["update", "--dev"], { env: before.env });
        assert(dev.status === 0, "update --dev succeeds");

        const r = run(join(before.sandbox, "bin", "opencode-rpc"), ["version"], { env: before.env });
        assert(new RegExp(`v${currentVersion.replace(/\./g, "\\.")}`).test(r.stdout) && /\(dev:/.test(r.stdout),
            `sandbox shows v${currentVersion} (dev:...) after update --dev, got: ${r.stdout.trim()}`);
    }

    rmSync(before.sandbox, { recursive: true, force: true });
}

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
    process.exit(1);
}
console.log("\n  ALL SCENARIOS PASSED");
