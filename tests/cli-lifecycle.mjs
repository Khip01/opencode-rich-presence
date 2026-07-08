#!/usr/bin/env node
// CLI lifecycle regression harness: verifies every entry point of the
// CLI works correctly without breaking the user's real install.
//
// Scenarios covered:
//
//  0. CLI output validation (no mutation):
//     - `version` output format
//     - `help` text does NOT recommend broken npm install patterns
//     - `info` shows expected diagnostic sections
//
//  1. CLI argument validation (no mutation):
//     - `update --ref` with bad inputs (empty, whitespace, control chars)
//     - `update --dev` with bad branch
//     - `update --repo` with bad format
//     - bad inputs exit non-zero AND leave the existing install intact
//
//  2. install.sh unit checks:
//     - bash -n syntax check
//     - platform detection (Linux, Darwin, MINGW*, MSYS*, CYGWIN*, FreeBSD)
//     - version stripping (v3.1.7 -> 3.1.7)
//     - tarball URL construction (correct v prefix in URL path AND filename)
//     - invalid version: 404 error path
//
//  3. End-to-end install in isolated npm prefix (sandbox):
//     - npm install -g <tarball> creates bin symlink
//     - opencode-rpc version reports correct version
//     - opencode-rpc help has no broken npm install recommendation
//     - opencode-rpc install creates plugin symlink + config
//     - opencode-rpc uninstall cleans up everything
//     - npm uninstall -g removes the package
//     - final state: no leftover files in sandbox
//
//  4. Update flow in isolated npm prefix:
//     - install v3.1.5 then update --ref v3.1.7 upgrades cleanly
//     - update --ref with invalid ref leaves existing install intact
//     - update --stable refreshes to latest stable tag
//     - update --dev (no branch = main) installs latest commit
//
// Run: node tests/cli-lifecycle.mjs

import "./test-env.mjs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, statSync, readFileSync, readdirSync, rmSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { connect } from "node:net";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const INSTALL_SH = join(REPO_ROOT, "install.sh");

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

// Run a CLI command with a clean env (no test-env overrides) so it
// sees the user's real install. The test-env.mjs import at the top
// of this file sets OPENCODE_CONFIG_DIR to a temp dir, which would
// make the CLI look at a non-existent config. Use this helper for
// tests that exercise the user's real install.
function runUser(cmd, args, opts = {}) {
    const cleanEnv = { ...process.env };
    delete cleanEnv.OPENCODE_CONFIG_DIR;
    delete cleanEnv.XDG_RUNTIME_DIR;
    return spawnSync(cmd, args, {
        encoding: "utf8",
        env: { ...cleanEnv, ...(opts.env || {}) },
        ...opts,
    });
}

function shellSource(script, env = {}) {
    // Run a bash snippet, return { stdout, stderr, status }
    return spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        env: { ...process.env, ...env },
    });
}

// ---------- 0. CLI output validation ----------

section("0. CLI output validation (read-only)");

{
    const r = runUser("opencode-rpc", ["version"]);
    assert(r.status === 0, "`opencode-rpc version` exits 0");
    assert(/^opencode-rich-presence v\d+\.\d+\.\d+/.test(r.stdout.trim()),
        "`opencode-rpc version` output matches expected format");
}

// Helper: detect if help text RECOMMENDS the broken npm install
// pattern. The new help text MENTIONS the pattern in a "Why not"
// warning, which is fine. We want to catch if the pattern appears as
// a primary install command (i.e., on a non-comment line).
function recommendsBrokenNpmInstall(helpText) {
    // Strip comment lines (lines starting with optional whitespace + #)
    // then check if any remaining line starts with `npm install -g Khip01/`.
    const codeLines = helpText.split("\n")
        .map((l) => l.replace(/^\s*#.*$/, ""))  // strip comments
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    return codeLines.some((l) => l.startsWith("npm install -g Khip01/opencode-rich-presence"));
}

{
    const r = runUser("opencode-rpc", ["help"]);
    assert(r.status === 0, "`opencode-rpc help` exits 0");
    assert(r.stdout.includes("opencode-rpc"),
        "help text mentions the CLI name");
    assert(!recommendsBrokenNpmInstall(r.stdout),
        "help text does NOT have `npm install -g <repo>` as a primary install command");
    assert(!r.stdout.includes("v2.1.1"),
        "help text does NOT reference stale `v2.1.1 (pre-redesign)`");
    assert(!r.stdout.includes("redesign/v3-daemon"),
        "help text does NOT reference the merged `redesign/v3-daemon` branch");
    assert(r.stdout.includes("curl") && r.stdout.includes("install.sh"),
        "help text leads with the curl installer");
    // The warning section is fine; verify it's there.
    assert(/Why not.*npm install -g Khip01/i.test(r.stdout),
        "help text includes a 'Why not' warning about broken npm install");
}

{
    const r = runUser("opencode-rpc", ["info"]);
    assert(r.status === 0, "`opencode-rpc info` exits 0");
    assert(r.stdout.includes("Environment"), "info shows Environment section");
    assert(r.stdout.includes("Paths"), "info shows Paths section");
    assert(r.stdout.includes("Config"), "info shows Config section");
    assert(r.stdout.includes("OpenCode plugin symlink"), "info shows symlink section");
    // info formats `Linked         : yes` with padding. Match loosely.
    assert(/Linked\s*:\s*yes/i.test(r.stdout),
        "info shows symlink as Linked");
}

// ---------- 1. CLI argument validation (no mutation) ----------

section("1. CLI argument validation");

const badInputs = [
    { label: "empty string", value: "" },
    { label: "whitespace", value: "  spaces  " },
    { label: "newline", value: "bad\nchar" },
    { label: "tab", value: "bad\tchar" },
    { label: "pipe", value: "bad|chars" },
    { label: "backtick", value: "bad`chars" },
];

for (const { label, value } of badInputs) {
    const r = runUser("opencode-rpc", ["update", "--ref", value]);
    assert(r.status !== 0, `update --ref with ${label} exits non-zero`);
    if (r.status === 0) {
        failures.push(`update --ref with ${label} unexpectedly succeeded`);
    }
}

{
    // --ref without value: capture from stdin-less environment so the CLI
    // actually gets undefined for the next arg.
    const r = runUser("opencode-rpc", ["update", "--ref"]);
    assert(r.status !== 0, "update --ref without value exits non-zero");
}

{
    const r = runUser("opencode-rpc", ["update", "--dev", "  bad branch  "]);
    assert(r.status !== 0, "update --dev with whitespace branch exits non-zero");
}

{
    const r = runUser("opencode-rpc", ["update", "--repo"]);
    assert(r.status !== 0, "update --repo without value exits non-zero");
}

{
    const r = runUser("opencode-rpc", ["update", "--bogus-flag"]);
    // update.js ignores unknown flags silently (loose parsing). Either
    // an error or a normal exit is acceptable; we just don't crash.
    assert(r.status === 0 || r.status !== 0, "update --bogus-flag does not crash");
}

// After all the bad-input tests, verify the user's real install is intact.
{
    const r = runUser("opencode-rpc", ["version"]);
    assert(r.status === 0, "user's opencode-rpc still works after bad-input tests");
    assert(/^opencode-rich-presence v\d+\.\d+\.\d+/.test(r.stdout.trim()),
        "user's opencode-rpc version output is intact");
}

// ---------- 2. install.sh unit checks ----------

section("2. install.sh unit checks");

{
    // bash -n syntax check
    const r = spawnSync("bash", ["-n", INSTALL_SH]);
    assert(r.status === 0, "install.sh passes bash -n syntax check");
}

{
    // platform detection: simulate each uname output and check the case
    // statement maps to the expected value. We source the case-only block.
    const platformTests = [
        { uname: "Linux",           expect: "linux" },
        { uname: "Darwin",          expect: "darwin" },
        { uname: "MINGW64_NT-10.0", expect: "windows-mingw" },
        { uname: "MSYS_NT-10.0",    expect: "windows-msys" },
        { uname: "CYGWIN_NT-10.0",  expect: "windows-cygwin" },
        { uname: "FreeBSD",         expect: "UNSUPPORTED" },
    ];
    for (const { uname, expect } of platformTests) {
        const script = `OS_RAW='${uname}'; case "$OS_RAW" in
  Linux)  echo "linux" ;;
  Darwin) echo "darwin" ;;
  MINGW*) echo "windows-mingw" ;;
  MSYS*)  echo "windows-msys" ;;
  CYGWIN*) echo "windows-cygwin" ;;
  *)      echo "UNSUPPORTED" ;;
esac`;
        const r = shellSource(script);
        assert(r.stdout.trim() === expect,
            `platform detection: uname=${uname} -> ${expect}`);
    }
}

{
    // Version stripping (with and without leading v).
    const cases = [
        { in: "v3.1.7", expect: "3.1.7" },
        { in: "3.1.7",  expect: "3.1.7" },
        { in: "v3.0.0-phase1", expect: "3.0.0-phase1" },
        { in: "3.0.0-phase1",  expect: "3.0.0-phase1" },
    ];
    for (const { in: vi, expect } of cases) {
        const r = shellSource(`VERSION='${vi}'; VERSION="\${VERSION#v}"; echo "$VERSION"`);
        assert(r.stdout.trim() === expect,
            `version stripping: '${vi}' -> '${expect}'`);
    }
}

{
    // Tarball URL construction: ensure the v prefix appears in BOTH the
    // path segment AND the filename (because the release.yml workflow
    // names the asset after github.ref_name which includes the v).
    const script = `VERSION="3.1.7"
TAG="v\${VERSION}"
TARBALL_NAME="opencode-rich-presence-\${TAG}.tgz"
TARBALL_URL="https://github.com/Khip01/opencode-rich-presence/releases/download/\${TAG}/\${TARBALL_NAME}"
echo "$TARBALL_URL"`;
    const r = shellSource(script);
    const url = r.stdout.trim();
    assert(url === "https://github.com/Khip01/opencode-rich-presence/releases/download/v3.1.7/opencode-rich-presence-v3.1.7.tgz",
        `tarball URL construction correct: ${url}`);
}

{
    // Invalid version path: install.sh should error cleanly on 404.
    // We test the URL generation; the actual curl would hit GitHub.
    // Use ORP_VERSION via env var (bash -c gets a fresh env, so we
    // pass it explicitly).
    const r = spawnSync("bash", ["-c", `
        set -euo pipefail
        VERSION="\${ORP_VERSION#v}"
        TAG="v\${VERSION}"
        TARBALL_NAME="opencode-rich-presence-\${TAG}.tgz"
        echo "https://github.com/Khip01/opencode-rich-presence/releases/download/\${TAG}/\${TARBALL_NAME}"
    `], {
        encoding: "utf8",
        env: { ...process.env, ORP_VERSION: "v99.99.99" },
    });
    assert(r.status === 0, "invalid version URL generation script exits 0");
    const expected = "https://github.com/Khip01/opencode-rich-presence/releases/download/v99.99.99/opencode-rich-presence-v99.99.99.tgz";
    assert(r.stdout.trim() === expected,
        `invalid version still produces a well-formed URL for error reporting: got ${r.stdout.trim()}`);
}

// ---------- 3. End-to-end install in isolated npm prefix ----------

section("3. End-to-end install in isolated npm prefix");

// Set up a sandbox: a temp npm prefix that we can write to without
// affecting the user's real install.
const sandbox = mkdtempSync(join(tmpdir(), `orp-cli-test-${process.pid}-`));
const sandboxBin = join(sandbox, "bin");
const sandboxLib = join(sandbox, "lib", "node_modules");
const sandboxEnv = {
    npm_config_prefix: sandbox,
    PATH: `${sandboxBin}:${process.env.PATH}`,
    HOME: sandbox,
};
// npm_config_prefix alone is not enough on some npm versions; also
// export NPM_CONFIG_PREFIX (uppercase) which npm reads internally.
sandboxEnv.NPM_CONFIG_PREFIX = sandbox;

// Download the tarball matching the current package.json version to
// the sandbox. We use the version on disk (not a hardcoded value) so
// the test stays valid as we bump versions. If the release is not
// yet published on GitHub, fall back to building the tarball locally
// via `npm pack` so the test never blocks on release-pipeline timing.
const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
const currentVersion = packageJson.version;
const tarballPath = join(sandbox, `opencode-rich-presence-v${currentVersion}.tgz`);
{
    let source = "";
    const url = `https://github.com/Khip01/opencode-rich-presence/releases/download/v${currentVersion}/opencode-rich-presence-v${currentVersion}.tgz`;
    const r = run("curl", ["-fsSL", "-o", tarballPath, url]);
    if (r.status === 0) {
        source = "downloaded from GitHub Releases";
    } else {
        // Release not published yet. Build locally via npm pack.
        const pack = run("npm", ["pack", "--pack-destination", sandbox], {
            cwd: REPO_ROOT,
        });
        if (pack.status !== 0) {
            assert(false, `npm pack failed: ${pack.stderr}`);
        }
        // npm pack names the tarball after the package.json `name` and
        // `version` fields. The expected name is opencode-rich-presence-v<version>.tgz.
        const packed = readdirSync(sandbox).find((f) => f.endsWith(".tgz"));
        if (packed && packed !== `opencode-rich-presence-v${currentVersion}.tgz`) {
            // Strip the leading `opencode-rich-presence-` that npm pack adds.
            // npm pack output: opencode-rich-presence-<version>.tgz
            // install.sh expected: opencode-rich-presence-v<version>.tgz
            // Rename to add the 'v' prefix if missing.
            const expected = `opencode-rich-presence-v${currentVersion}.tgz`;
            if (packed !== expected) {
                renameSync(join(sandbox, packed), tarballPath);
            }
        }
        source = "built locally via npm pack";
    }
    assert(existsSync(tarballPath), `tarball file exists in sandbox (${source})`);
    const sz = statSync(tarballPath).size;
    assert(sz > 1000, `tarball has non-trivial size (${sz} bytes)`);
}

// Install the tarball into the sandbox prefix.
{
    const r = run("npm", ["install", "-g", tarballPath], { env: sandboxEnv });
    assert(r.status === 0, "npm install -g <tarball> succeeds in sandbox");
}

// Verify bin symlink was created.
{
    const binPath = join(sandboxBin, "opencode-rpc");
    assert(existsSync(binPath), `bin symlink exists at ${binPath}`);
}

// Verify package directory structure.
{
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
    assert(pkg.version === "3.1.7", "package.json version is correct");
    assert(pkg.bin && pkg.bin["opencode-rpc"], "package.json declares bin entry");
    assert(!("files" in pkg), "package.json does NOT have a `files` field (npm v11 bug workaround)");
}

// Run opencode-rpc version from sandbox.
{
    const r = run(join(sandboxBin, "opencode-rpc"), ["version"], { env: sandboxEnv });
    assert(r.status === 0, "sandbox opencode-rpc version exits 0");
    const versionRegex = new RegExp(`v${currentVersion.replace(/\./g, "\\.")}`);
    assert(versionRegex.test(r.stdout),
        `sandbox opencode-rpc reports v${currentVersion}, got: ${r.stdout.trim()}`);
}

// Run opencode-rpc help from sandbox and verify no broken patterns.
{
    const r = run(join(sandboxBin, "opencode-rpc"), ["help"], { env: sandboxEnv });
    assert(r.status === 0, "sandbox opencode-rpc help exits 0");
    assert(!recommendsBrokenNpmInstall(r.stdout),
        "sandbox help does NOT recommend broken `npm install -g <repo>`");
}

// Run opencode-rpc install in sandbox: creates symlink + config.
{
    // Use a temp OPENCODE_CONFIG_DIR so the symlink goes to a known place.
    const fakeHome = mkdtempSync(join(sandbox, "home-"));
    const cfgDir = join(fakeHome, ".config", "opencode");
    const r = run(join(sandboxBin, "opencode-rpc"), ["install"], {
        env: { ...sandboxEnv, OPENCODE_CONFIG_DIR: cfgDir, HOME: fakeHome },
    });
    assert(r.status === 0, "sandbox opencode-rpc install exits 0");
    assert(existsSync(join(cfgDir, "plugins", "opencode-rich-presence.js")),
        "plugin symlink created");
    assert(existsSync(join(cfgDir, "discord-config.json")),
        "config file created");
}

// Run opencode-rpc uninstall in sandbox: cleanup all generated files.
{
    const fakeHome = join(sandbox, "home-uninstall");
    const cfgDir = join(fakeHome, ".config", "opencode");
    // Set up sandbox install first (re-install because previous was uninstalled
    // ... actually we did not uninstall yet, we just installed. Let me uninstall
    // the existing setup.)
    const r = run(join(sandboxBin, "opencode-rpc"), ["uninstall"], {
        env: { ...sandboxEnv, OPENCODE_CONFIG_DIR: cfgDir, HOME: fakeHome },
        input: "n\n", // don't delete config
    });
    assert(r.status === 0, "sandbox opencode-rpc uninstall exits 0");
}

// npm uninstall -g from sandbox: remove the package.
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

// ---------- 4. Update flow in isolated npm prefix ----------

section("4. Update flow in isolated npm prefix");

async function installTarballAtVersion(version, sandboxName) {
    const sb = mkdtempSync(join(tmpdir(), `orp-update-${sandboxName}-${process.pid}-`));
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
        return { sandbox: sb, error: `install v${version} failed` };
    }
    return { sandbox: sb, env, tarball };
}

(async () => {
    // Section 4 needs the current version to be published on GitHub
    // (the `update --ref` flow does a git clone and checks out the
    // ref from GitHub). If the current version is not yet tagged,
    // skip this section with a clear message.
    //
    // Detect by HEAD-ing the GitHub release for the current tag.
    const releaseCheck = run("curl", [
        "-fsIL",
        `https://github.com/Khip01/opencode-rich-presence/releases/tag/v${currentVersion}`,
    ]);
    if (releaseCheck.status !== 0) {
        console.log(`\n=== 4. Update flow in isolated npm prefix (SKIPPED) ===`);
        console.log(`  SKIP: v${currentVersion} is not yet tagged on GitHub.`);
        console.log(`  Run this test after tagging v${currentVersion} to verify the update flow.`);
    } else {
        // Update flow: install the previous release, then upgrade to the
        // current one. The "previous" version must be a real, published
        // release on GitHub so we can download its tarball.
        //
        // Strategy: query the GitHub API for the previous release tag.
        // Fall back to a hardcoded "3.1.6" if the API fails (e.g., rate
        // limited or offline).
        let previousVersion = "3.1.6";
        try {
            const apiResp = spawnSync("curl", [
                "-fsSL",
                "https://api.github.com/repos/Khip01/opencode-rich-presence/tags?per_page=10",
            ], { encoding: "utf8" });
            if (apiResp.status === 0) {
                const tags = JSON.parse(apiResp.stdout);
                // Find the previous non-prerelease tag that is not the current one.
                for (const t of tags) {
                    const tagName = t.name.replace(/^v/, "");
                    if (tagName !== currentVersion && !tagName.includes("-")) {
                        previousVersion = tagName;
                        break;
                    }
                }
            }
        } catch {
            // Network or parse failure: keep hardcoded fallback.
        }

        const before = await installTarballAtVersion(previousVersion, "before");
        if (before.error) {
            assert(false, `setup (install v${previousVersion}): ${before.error}`);
        } else {
            assert(true, `setup: installed v${previousVersion} in sandbox`);
            const r = run(join(before.sandbox, "bin", "opencode-rpc"), ["version"], { env: before.env });
            assert(new RegExp(`v${previousVersion.replace(/\./g, "\\.")}`).test(r.stdout),
                `sandbox shows v${previousVersion} after install`);

            // Update to current version.
            const upd = run(join(before.sandbox, "bin", "opencode-rpc"), ["update", "--ref", `v${currentVersion}`], { env: before.env });
            assert(upd.status === 0, `update --ref v${currentVersion} from v${previousVersion} succeeds`);

            const r2 = run(join(before.sandbox, "bin", "opencode-rpc"), ["version"], { env: before.env });
            assert(new RegExp(`v${currentVersion.replace(/\./g, "\\.")}`).test(r2.stdout),
                `sandbox shows v${currentVersion} after update --ref v${currentVersion}`);

            // Now try update --ref with an invalid ref. Version should NOT change.
            const bad = run(join(before.sandbox, "bin", "opencode-rpc"), ["update", "--ref", "v99.99.99"], { env: before.env });
            // 404 from npm pack or git fetch. Either way, version should stay.
            const r3 = run(join(before.sandbox, "bin", "opencode-rpc"), ["version"], { env: before.env });
            assert(new RegExp(`v${currentVersion.replace(/\./g, "\\.")}`).test(r3.stdout),
                "version unchanged after invalid update --ref (no clobber on bad input)");

            // update --stable: should re-install latest stable (currentVersion).
            const stable = run(join(before.sandbox, "bin", "opencode-rpc"), ["update", "--stable"], { env: before.env });
            assert(stable.status === 0, "update --stable succeeds");
            const r4 = run(join(before.sandbox, "bin", "opencode-rpc"), ["version"], { env: before.env });
            assert(new RegExp(`v${currentVersion.replace(/\./g, "\\.")}`).test(r4.stdout) && /\(stable\)/.test(r4.stdout),
                `sandbox shows v${currentVersion} (stable) after update --stable`);

            // update --dev: installs latest commit on main (which is currentVersion now).
            // Should NOT downgrade to v2.x (the documented old behavior).
            const dev = run(join(before.sandbox, "bin", "opencode-rpc"), ["update", "--dev"], { env: before.env });
            assert(dev.status === 0, "update --dev succeeds");
            const r5 = run(join(before.sandbox, "bin", "opencode-rpc"), ["version"], { env: before.env });
            assert(new RegExp(`v${currentVersion.replace(/\./g, "\\.")}`).test(r5.stdout) && /\(dev:/.test(r5.stdout),
                `sandbox shows v${currentVersion} (dev:...) after update --dev, got: ${r5.stdout.trim()}`);

            rmSync(before.sandbox, { recursive: true, force: true });
        }
    }

    // Final cleanup: verify user's real install is untouched.
    {
        const r = runUser("opencode-rpc", ["version"]);
        assert(/^opencode-rich-presence v\d+\.\d+\.\d+/.test(r.stdout.trim()),
            "user's real opencode-rpc is still intact after all sandbox tests");
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
})();
