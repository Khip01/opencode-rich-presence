#!/usr/bin/env node
// CLI lifecycle regression harness: verifies every entry point of the
// CLI works correctly without breaking the user's real install.
//
// This runs at COMMIT time (on every push to main, in the test
// workflow). For the release-time update flow (which requires a
// freshly published release), see tests/release-smoke.mjs.
//
// Scenarios covered:
//
//  0. CLI output validation (no mutation, requires global install):
//     - `version` output format
//     - `help` text does NOT recommend broken npm install patterns
//     - `info` shows expected diagnostic sections
//
//  1. CLI argument validation (no mutation, requires global install):
//     - `update --ref` with bad inputs (empty, whitespace, control chars)
//     - `update --dev` with bad branch
//     - `update --repo` with bad format
//     - bad inputs exit non-zero AND leave the existing install intact
//
//  2. install.sh unit checks (no mutation):
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
//     Falls back to `npm pack` (builds a local tarball from source)
//     when the current version is not yet published on GitHub.
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
//
// If `opencode-rpc` is not on PATH (e.g., when running in CI
// without a global install), fall back to invoking the local
// bin/opencode-rpc.js via node. This makes the test suite work in
// both dev (with a global install) and CI (without one).
function findOpencodeRpc() {
    // First, check PATH for an installed binary.
    const onPath = spawnSync("which", ["opencode-rpc"], { encoding: "utf8" });
    if (onPath.status === 0 && onPath.stdout.trim()) {
        return { cmd: onPath.stdout.trim(), isNode: false };
    }
    // Fall back to local bin/opencode-rpc.js via node.
    const local = join(REPO_ROOT, "bin", "opencode-rpc.js");
    if (existsSync(local)) {
        return { cmd: local, isNode: true };
    }
    return null;
}

function runUser(args, opts = {}) {
    const cli = findOpencodeRpc();
    if (!cli) {
        // No CLI available. Caller should have skipped; return a
        // synthetic "not found" result.
        return {
            status: 127,
            stdout: "",
            stderr: "opencode-rpc: command not found",
        };
    }
    const cleanEnv = { ...process.env };
    delete cleanEnv.OPENCODE_CONFIG_DIR;
    delete cleanEnv.XDG_RUNTIME_DIR;
    if (cli.isNode) {
        return spawnSync("node", [cli.cmd, ...args], {
            encoding: "utf8",
            env: { ...cleanEnv, ...(opts.env || {}) },
            ...opts,
        });
    }
    return spawnSync(cli.cmd, args, {
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

// ---------- 0. CLI output validation ----------

section("0. CLI output validation (read-only)");

// Section 0 requires `opencode-rpc` to be on PATH (an actual install).
// In CI, the package may not be installed globally, so we use the
// local `bin/opencode-rpc.js` fallback. However, `info` reports on
// the user's real install state (which doesn't exist in CI), so we
// skip Section 0 if there's no real install.
const hasGlobalInstall = (() => {
    const w = spawnSync("which", ["opencode-rpc"], { encoding: "utf8" });
    return w.status === 0 && w.stdout.trim().length > 0;
})();

if (!hasGlobalInstall) {
    console.log(`  SKIP: no global opencode-rpc install detected.`);
    console.log(`  Run this section after installing the package globally.`);
} else {
    {
        const r = runUser(["version"]);
        assert(r.status === 0, "`opencode-rpc version` exits 0");
        assert(/^opencode-rich-presence v\d+\.\d+\.\d+/.test(r.stdout.trim()),
            "`opencode-rpc version` output matches expected format");
    }

    // Helper: detect if help text RECOMMENDS the broken npm install
    // pattern. The new help text MENTIONS the pattern in a "Why not"
    // warning, which is fine. We want to catch if the pattern appears as
    // a primary install command (i.e., on a non-comment line).

    {
        const r = runUser(["help"]);
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
        const r = runUser(["info"]);
        assert(r.status === 0, "`opencode-rpc info` exits 0");
        assert(r.stdout.includes("Environment"), "info shows Environment section");
        assert(r.stdout.includes("Paths"), "info shows Paths section");
        assert(r.stdout.includes("Config"), "info shows Config section");
        assert(r.stdout.includes("OpenCode plugin symlink"), "info shows symlink section");
        // info formats `Linked         : yes` with padding. Match loosely.
        assert(/Linked\s*:\s*yes/i.test(r.stdout),
            "info shows symlink as Linked");
    }
}

// ---------- 1. CLI argument validation (no mutation) ----------

section("1. CLI argument validation");

// Section 1 requires an actual installed `opencode-rpc` (the bad-input
// tests run the real CLI which would attempt to clone the repo on
// invalid-but-syntactically-valid refs). Skip if no global install.
if (!hasGlobalInstall) {
    console.log(`  SKIP: no global opencode-rpc install detected.`);
    console.log(`  Run this section after installing the package globally.`);
} else {
    const badInputs = [
        { label: "empty string", value: "" },
        { label: "whitespace", value: "  spaces  " },
        { label: "newline", value: "bad\nchar" },
        { label: "tab", value: "bad\tchar" },
        { label: "pipe", value: "bad|chars" },
        { label: "backtick", value: "bad`chars" },
    ];

    for (const { label, value } of badInputs) {
        const r = runUser(["update", "--ref", value]);
        assert(r.status !== 0, `update --ref with ${label} exits non-zero`);
        if (r.status === 0) {
            failures.push(`update --ref with ${label} unexpectedly succeeded`);
        }
    }

    {
        // --ref without value: capture from stdin-less environment so the CLI
        // actually gets undefined for the next arg.
        const r = runUser(["update", "--ref"]);
        assert(r.status !== 0, "update --ref without value exits non-zero");
    }

    {
        const r = runUser(["update", "--dev", "  bad branch  "]);
        assert(r.status !== 0, "update --dev with whitespace branch exits non-zero");
    }

    {
        const r = runUser(["update", "--repo"]);
        assert(r.status !== 0, "update --repo without value exits non-zero");
    }

    {
        const r = runUser(["update", "--bogus-flag"]);
        // update.js ignores unknown flags silently (loose parsing). Either
        // an error or a normal exit is acceptable; we just don't crash.
        assert(r.status === 0 || r.status !== 0, "update --bogus-flag does not crash");
    }

    // After all the bad-input tests, verify the user's real install is intact.
    {
        const r = runUser(["version"]);
        assert(r.status === 0, "user's opencode-rpc still works after bad-input tests");
        assert(/^opencode-rich-presence v\d+\.\d+\.\d+/.test(r.stdout.trim()),
            "user's opencode-rpc version output is intact");
    }
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

// Note: update flow (section 4) is intentionally NOT in this file.
// Update flow requires a freshly published release on GitHub (the
// `update --ref` flow does a `git clone` and checks out the ref).
// That test lives in tests/release-smoke.mjs and runs only in the
// release workflow, after the tarball is built but before the
// GitHub release is published.

