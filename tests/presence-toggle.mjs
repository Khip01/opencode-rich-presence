import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "bin", "opencode-rpc.js");

const SANDBOX = mkdtempSync(join(tmpdir(), `orp-toggle-${process.pid}-`));
process.env.OPENCODE_CONFIG_DIR = SANDBOX;
process.env.XDG_RUNTIME_DIR = SANDBOX;

const { readState, writeState } = await import("../src/shared/presence-state.js");
const { PRESENCE_STATE } = await import("../src/shared/paths.js");

let passed = 0, failed = 0;
function ok(cond, msg) {
    try { assert.ok(cond, msg); passed += 1; console.log(`  \u2713 ${msg}`); }
    catch (e) { failed += 1; console.log(`  \u2717 ${msg}`); console.log(`    ${e.message}`); }
}
function section(name) { console.log(`\n== ${name} ==`); }

function runCli(args, { input = "" } = {}) {
    return spawnSync(process.execPath, [CLI, ...args], {
        encoding: "utf-8",
        input,
        timeout: 20000,
        env: { ...process.env, OPENCODE_CONFIG_DIR: SANDBOX, XDG_RUNTIME_DIR: SANDBOX },
    });
}

function clearState() {
    try { if (existsSync(PRESENCE_STATE)) writeFileSync(PRESENCE_STATE, "", "utf-8"); } catch {}
}

// ── 1. state marker defaults + fallback ──────────────────────────
section("state marker");

clearState();
{
    const s = readState();
    ok(s.presenceEnabled === true, "default: presenceEnabled true when file missing/empty");
    ok(s.daemonStopped === false, "default: daemonStopped false when file missing/empty");
    ok(s.updatedAt === 0, "default: updatedAt 0");
}

writeFileSync(PRESENCE_STATE, "{ this is not json", "utf-8");
{
    const s = readState();
    ok(s.presenceEnabled === true, "corrupt file: falls back to enabled=true (no throw)");
    ok(s.daemonStopped === false, "corrupt file: falls back to daemonStopped=false");
}

writeFileSync(PRESENCE_STATE, JSON.stringify({ presenceEnabled: "yes", daemonStopped: 1 }), "utf-8");
{
    const s = readState();
    ok(s.presenceEnabled === true, "wrong types: non-boolean presenceEnabled coerced to default true");
    ok(s.daemonStopped === false, "wrong types: non-boolean daemonStopped coerced to default false");
}

// ── 2. writeState merge semantics ────────────────────────────────
section("writeState");

clearState();
{
    const w = writeState({ presenceEnabled: false });
    ok(w.presenceEnabled === false, "write presenceEnabled=false applied");
    ok(w.daemonStopped === false, "write does not touch daemonStopped");
    ok(typeof w.updatedAt === "number" && w.updatedAt > 0, "write stamps updatedAt");
    const r = readState();
    ok(r.presenceEnabled === false, "readback sees presenceEnabled=false");
}

{
    const w = writeState({ daemonStopped: true });
    ok(w.presenceEnabled === false, "merge keeps presenceEnabled=false");
    ok(w.daemonStopped === true, "merge sets daemonStopped=true");
}

// ── 3. dispatcher recognizes new commands ────────────────────────
section("dispatcher");

for (const cmd of ["on", "off", "kill", "spawn"]) {
    const r = runCli([cmd], { input: "n\n" });
    const combined = `${r.stdout || ""}${r.stderr || ""}`;
    ok(!combined.includes("Unknown command"),
        `dispatcher recognizes '${cmd}' (no Unknown command)`);
}

// ── 4. help output ───────────────────────────────────────────────
section("help");

{
    const r = runCli(["help"]);
    ok(r.status === 0, "help exits 0");
    const out = r.stdout || "";
    ok(out.includes("Enable Rich Presence"), "help lists 'on' description");
    ok(out.includes("Disable Rich Presence"), "help lists 'off' description");
    ok(out.includes("Stop the daemon permanently"), "help lists 'kill' description");
    ok(out.includes("Start the daemon again"), "help lists 'spawn' description");
    ok(out.includes("Restart the daemon"), "help lists 'restart' description");
    ok(out.includes("curl") && out.includes("install.sh"), "help keeps curl installer line");
    ok(out.includes("Presence") && out.includes("Daemon") && out.includes("Setup"),
        "help is grouped by category");
    const codeLines = out.split("\n").map((l) => l.trimStart());
    ok(!codeLines.some((l) => l.startsWith("npm install -g Khip01/opencode-rich-presence")),
        "help does not recommend broken npm install -g <repo>");
}

// ── 5. colors disabled when piped ────────────────────────────────
section("colors");

{
    const r = runCli(["help"]);
    ok(!/\u001b\[/.test(r.stdout || ""), "help piped: no ANSI escape bytes");
}

// ── 6. on / off commands ─────────────────────────────────────────
section("on/off");

clearState();
{
    const r = runCli(["off"]);
    ok(r.status === 0, "'off' exits 0");
    const s = readState();
    ok(s.presenceEnabled === false, "'off' persists presenceEnabled=false");
    ok(s.daemonStopped === false, "'off' leaves daemon alive (daemonStopped=false)");
}

{
    const r = runCli(["on"]);
    ok(r.status === 0, "'on' exits 0");
    const s = readState();
    ok(s.presenceEnabled === true, "'on' persists presenceEnabled=true");
}

// ── 7. kill confirmation ─────────────────────────────────────────
section("kill");

clearState();
writeState({ presenceEnabled: true, daemonStopped: false });
{
    const r = runCli(["kill"], { input: "n\n" });
    ok(r.status === 0, "kill with 'n' exits 0");
    ok((r.stdout || "").includes("Cancelled"), "kill with 'n' prints Cancelled");
    const s = readState();
    ok(s.daemonStopped === false, "kill with 'n' leaves daemonStopped=false");
}

{
    const r = runCli(["kill"], { input: "y\n" });
    ok(r.status === 0, "kill with 'y' exits 0");
    const s = readState();
    ok(s.daemonStopped === true, "kill with 'y' sets daemonStopped=true");
    ok(s.presenceEnabled === true, "kill does not disable presence (only stops daemon)");
}

{
    const out = (runCli(["kill"], { input: "y\n" }).stdout || "");
    ok(out.includes("WARNING"), "kill prints WARNING");
    ok(out.includes("spawn"), "kill points to 'spawn' for recovery");
}

// ── 8. spawn refuses when presence disabled ──────────────────────
section("spawn");

clearState();
writeState({ presenceEnabled: false, daemonStopped: true });
{
    const r = runCli(["spawn"]);
    ok(r.status === 0, "spawn exits 0 when presence disabled");
    ok((r.stdout || "").includes("Presence is disabled"), "spawn refuses and tells user to run 'on'");
    const s = readState();
    ok(s.daemonStopped === true, "spawn does not clear daemonStopped when presence disabled");
}

// ── summary ──────────────────────────────────────────────────────
console.log(`\n== Summary ==`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
if (failed > 0) {
    console.log("  PRESENCE-TOGGLE: FAILED");
    process.exit(1);
}
console.log("  PRESENCE-TOGGLE: PASSED");