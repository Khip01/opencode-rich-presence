import "./test-env.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX = mkdtempSync(join(tmpdir(), `orp-winpath-${process.pid}-`));
process.env.OPENCODE_CONFIG_DIR = SANDBOX;
process.env.XDG_RUNTIME_DIR = SANDBOX;

const { DAEMON_SOCKET, DAEMON_PID_FILE, IS_WINDOWS } = await import("../src/shared/paths.js");
const { isPidAlive, readDaemonPid, isDaemonAlive, isDaemonReady, unlinkSocketPath } =
    await import("../src/shared/daemon-liveness.js");

let passed = 0, failed = 0;
function ok(cond, msg) {
    try { assert.ok(cond, msg); passed += 1; console.log(`  \u2713 ${msg}`); }
    catch (e) { failed += 1; console.log(`  \u2717 ${msg}`); console.log(`    ${e.message}`); }
}
function eq(a, b, msg) {
    try { assert.deepEqual(a, b, msg); passed += 1; console.log(`  \u2713 ${msg}`); }
    catch (e) { failed += 1; console.log(`  \u2717 ${msg}`); console.log(`    ${e.message}`); }
}
function section(name) { console.log(`\n== ${name} ==`); }

function writePid(raw) { writeFileSync(DAEMON_PID_FILE, raw, "utf-8"); }
function clearPid() { try { rmSync(DAEMON_PID_FILE, { force: true }); } catch {} }

// ── 1. isPidAlive ─────────────────────────────────────────────────
section("isPidAlive");

ok(isPidAlive(process.pid), "current process is alive");
ok(!isPidAlive(0), "pid 0 is never treated as alive");
ok(!isPidAlive(-1), "negative pid is never treated as alive");
ok(!isPidAlive(null), "null is never treated as alive");
ok(!isPidAlive(undefined), "undefined is never treated as alive");
ok(!isPidAlive(1.5), "fractional pid is never treated as alive");

// A pid that is almost certainly free. Linux caps pids well below this
// on any normal box; on Windows the OS rejects the number outright.
ok(!isPidAlive(999999), "out-of-range pid is not alive");

// ── 2. readDaemonPid ──────────────────────────────────────────────
section("readDaemonPid");

clearPid();
eq(readDaemonPid(), null, "no PID file reads as null");

writePid("");
eq(readDaemonPid(), null, "empty PID file reads as null");

writePid("   \n  ");
eq(readDaemonPid(), null, "whitespace-only PID file reads as null");

writePid("not-a-number");
eq(readDaemonPid(), null, "non-numeric PID file reads as null");

writePid("0");
eq(readDaemonPid(), null, "pid 0 is rejected");

writePid(`${process.pid}\n`);
eq(readDaemonPid(), process.pid, "current pid round-trips");

writePid(`${process.pid}   \n`);
eq(readDaemonPid(), process.pid, "trailing whitespace is trimmed");

// ── 3. isDaemonAlive ──────────────────────────────────────────────
section("isDaemonAlive");

clearPid();
ok(!isDaemonAlive(), "no PID file means no daemon");

writePid("999999");
ok(!isDaemonAlive(), "PID file pointing at a dead pid means no daemon");

writePid(`${process.pid}`);
ok(isDaemonAlive(), "PID file pointing at a live pid means daemon alive");

// A stale socket file on POSIX must NOT be reported as a live daemon.
// This is the regression that matters: the old code trusted
// existsSync(DAEMON_SOCKET), so a crashed daemon that left its socket
// file behind looked healthy and the plugin refused to respawn.
clearPid();
if (!IS_WINDOWS) {
    const fd = openSync(DAEMON_SOCKET, "w");
    closeSync(fd);
    ok(existsSync(DAEMON_SOCKET), "stale socket file exists on disk");
    ok(!isDaemonAlive(), "stale socket file alone does NOT report a live daemon");
}

// ── 4. isDaemonReady ──────────────────────────────────────────────
// One step stricter than isDaemonAlive. main() writes the PID file
// before it calls listen(), so for a brief window the process is alive
// but not bound. Waiting only on isDaemonAlive would let the plugin
// connect too early and hit ECONNREFUSED.
section("isDaemonReady");

clearPid();
if (!IS_WINDOWS) {
    // No PID file: never ready, regardless of a leftover socket file.
    const fd0 = openSync(DAEMON_SOCKET, "w");
    closeSync(fd0);
    ok(!isDaemonReady(), "no PID file means not ready (even with a socket file on disk)");
    rmSync(DAEMON_SOCKET, { force: true });

    // PID alive but not bound: the post-spawn startup window.
    writePid(`${process.pid}`);
    ok(isDaemonAlive() === true, "preflight: process is alive");
    ok(!existsSync(DAEMON_SOCKET), "socket file absent, daemon has not bound yet");
    ok(isDaemonAlive() && !isDaemonReady(),
        "alive but not bound is NOT ready (startup window)");

    // PID alive and bound: ready.
    const fd1 = openSync(DAEMON_SOCKET, "w");
    closeSync(fd1);
    ok(isDaemonReady(), "alive plus a bound socket means ready");

    // PID dead but socket file left behind: not ready.
    rmSync(DAEMON_PID_FILE, { force: true });
    writePid("999999");
    ok(!isDaemonReady(), "dead PID with a leftover socket file is not ready");
} else {
    writePid(`${process.pid}`);
    ok(isDaemonReady(), "Windows: a live PID is the best synchronous readiness signal");
    rmSync(DAEMON_PID_FILE, { force: true });
    ok(!isDaemonReady(), "Windows: no PID file means not ready");
}

// ── 5. unlinkSocketPath ───────────────────────────────────────────
section("unlinkSocketPath");

clearPid();
if (!IS_WINDOWS) {
    const fd = openSync(DAEMON_SOCKET, "w");
    closeSync(fd);
    ok(unlinkSocketPath(), "unlinkSocketPath removes an existing socket file");
    ok(!existsSync(DAEMON_SOCKET), "socket file is gone after unlinkSocketPath");
    ok(!unlinkSocketPath(), "unlinkSocketPath is a no-op when the file is absent");
} else {
    ok(!unlinkSocketPath(), "unlinkSocketPath is a no-op on Windows (pipes cannot be unlinked)");
}

// ── 6. path shape ─────────────────────────────────────────────────
section("IPC address shape");

if (IS_WINDOWS) {
    ok(DAEMON_SOCKET.startsWith("\\\\.\\pipe\\"), "Windows address is a named pipe");
    ok(DAEMON_SOCKET.endsWith(`opencode-rich-presence-${DAEMON_SOCKET.split("-").pop()}`),
        "Windows pipe name carries a per-user scope suffix");
    ok(!DAEMON_SOCKET.includes(".sock"), "Windows address has no .sock suffix");
} else {
    ok(DAEMON_SOCKET.endsWith(".opencode-rich-presence.sock"),
        "POSIX address keeps the .sock filename (unchanged from v3.3.0)");
    ok(DAEMON_SOCKET.startsWith(SANDBOX), "POSIX address honors OPENCODE_CONFIG_DIR");
    ok(!DAEMON_SOCKET.includes("\\\\"), "POSIX address has no pipe prefix");
}

// ── 7. no double-prefix anywhere ──────────────────────────────────
// The original PR moved the full pipe name into paths.js but left the
// per-module socketPathForPlatform() helpers in place, so on/off
// connected to \\.\pipe\\.\pipe\opencode-rich-presence. Guard against
// anyone reintroducing a prefix on top of DAEMON_SOCKET.
section("no double prefixing");

const sources = [
    "src/shared/paths.js",
    "src/shared/presence-control.js",
    "src/shared/daemon-liveness.js",
    "src/plugin/daemon-client.js",
    "src/plugin/daemon-spawner.js",
    "src/plugin/index.js",
    "src/worker/daemon.mjs",
    "src/worker/discord-ipc.mjs",
    "src/cli/info.js",
    "src/cli/kill.js",
    "src/cli/restart.js",
    "src/cli/spawn.js",
    "src/cli/uninstall.js",
];

let prefixBuilders = [];
let existsOnSocket = [];
let unlinkOnSocket = [];
for (const rel of sources) {
    const text = readFileSync(join(ROOT, rel), "utf-8");
    if (text.includes("function socketPathForPlatform")) prefixBuilders.push(rel);
    // existsSync/unlinkSync applied to the IPC address directly is wrong on
    // Windows. daemon-liveness.js is the one place allowed to stat it, and
    // only behind an IS_WINDOWS guard.
    if (/existsSync\(\s*DAEMON_SOCKET\s*\)/.test(text) && rel !== "src/shared/daemon-liveness.js") {
        existsOnSocket.push(rel);
    }
    if (/unlinkSync\(\s*DAEMON_SOCKET\s*\)/.test(text) && rel !== "src/shared/daemon-liveness.js") {
        unlinkOnSocket.push(rel);
    }
}

eq(prefixBuilders, [], "no socketPathForPlatform() helper remains");
eq(existsOnSocket, [], "no module stats DAEMON_SOCKET directly");
eq(unlinkOnSocket, [], "no module unlinks DAEMON_SOCKET directly");

// daemon-liveness.js is the single place allowed to touch the raw path,
// and only after an explicit Windows guard.
{
    const text = readFileSync(join(ROOT, "src/shared/daemon-liveness.js"), "utf-8");
    const unlinkFn = text.slice(text.indexOf("export function unlinkSocketPath"));
    ok(unlinkFn.includes("if (IS_WINDOWS) return false;"),
        "unlinkSocketPath() short-circuits on Windows before touching the path");
}

// ── 8. Discord IPC candidates ─────────────────────────────────────
// The original PR added the Windows pipe list but left the
// existsSync pre-filter in place, so every candidate was skipped and the
// handshake could never succeed.
section("Discord IPC candidates");

{
    const text = readFileSync(join(ROOT, "src/worker/discord-ipc.mjs"), "utf-8");
    ok(!/if \(!existsSync\(socketPath\)\) continue;/.test(text),
        "connect loop no longer pre-filters candidates with a bare existsSync");
    ok(text.includes("function shouldProbe("),
        "connect loop uses a platform-aware shouldProbe() helper");
    const probe = text.slice(text.indexOf("function shouldProbe("));
    ok(/if \(process\.platform === "win32"\) return true;/.test(probe),
        "shouldProbe() returns true for pipes on Windows instead of skipping them");
    ok(text.includes("discord-ipc-"),
        "Windows Discord pipe candidates are still generated");
    // Ids 0-9 loop, so the upper bound must be present.
    ok(/for \(let id = 0; id <= 9; id\+\+\)/.test(text),
        "Windows Discord pipe ids 0-9 are enumerated");
    // POSIX behavior must be untouched.
    ok(text.includes('process.env.XDG_RUNTIME_DIR') && text.includes('"/tmp"'),
        "POSIX Discord socket directory list is unchanged");
}

console.log("");
console.log(`WIN-PATH: ${failed === 0 ? "PASSED" : "FAILED"} (${passed} passed, ${failed} failed)`);
try { rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
process.exit(failed === 0 ? 0 : 1);
