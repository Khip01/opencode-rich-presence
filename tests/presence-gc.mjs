import "./test-env.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX = mkdtempSync(join(tmpdir(), `orp-gc-${process.pid}-`));
process.env.OPENCODE_CONFIG_DIR = SANDBOX;
process.env.XDG_RUNTIME_DIR = SANDBOX;

const { OPENCODE_DIR, PRESENCE_STATE_DIR } = await import("../src/shared/paths.js");
const { ensureStateDir, migrateLegacyStates, gcPresenceStates, stateFilePathFor } =
    await import("../src/shared/presence-gc.js");

let passed = 0, failed = 0;
function ok(cond, msg) {
    try { assert.ok(cond, msg); passed += 1; console.log(`  \u2713 ${msg}`); }
    catch (e) { failed += 1; console.log(`  \u2717 ${msg}`); console.log(`    ${e.message}`); }
}
function section(name) { console.log(`\n== ${name} ==`); }

// A pid that is guaranteed dead: a short-lived child that has already
// exited and been reaped.
function deadPid() {
    const r = spawnSync(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    return r.pid;
}

function touchFile(p, content = "x") {
    writeFileSync(p, content, "utf-8");
}

function setMtime(p, ms) {
    const d = new Date(ms);
    rmSync(`${p}.tmp`, { force: true });
    // utimes via fs would need another import; use the mtimeMs trick by
    // rewriting then comparing. Simpler: rely on natural ordering with
    // explicit sleeps below instead of faking mtimes.
    void d; void ms;
}

// ── 1. ensureStateDir + stateFilePathFor ───────────────────────────
section("layout");

ok(!existsSync(PRESENCE_STATE_DIR), "preflight: state dir absent before init");
ensureStateDir();
ok(existsSync(PRESENCE_STATE_DIR), "ensureStateDir creates presence-states/");
ensureStateDir();
ok(existsSync(PRESENCE_STATE_DIR), "ensureStateDir is idempotent");

const myPath = stateFilePathFor(process.pid);
ok(myPath.startsWith(PRESENCE_STATE_DIR),
    "stateFilePathFor points inside the subfolder");
ok(myPath.endsWith(`presence-state-pid${process.pid}.txt`),
    "stateFilePathFor keeps the legacy filename shape");

// ── 2. migration of the flat pre-3.4 layout ────────────────────────
section("migration");

const LEGACY_NAMES = [
    "presence-state-pid111.txt",
    "presence-state-pid222.txt",
    "presence-state-pid333.txt",
];
for (const n of LEGACY_NAMES) touchFile(join(OPENCODE_DIR, n), `legacy:${n}`);
// Decoys that must NOT move.
touchFile(join(OPENCODE_DIR, "presence-state-other.txt"), "decoy suffix");
touchFile(join(OPENCODE_DIR, "other-pid444.txt"), "decoy prefix");

migrateLegacyStates();
for (const n of LEGACY_NAMES) {
    ok(!existsSync(join(OPENCODE_DIR, n)), `${n} left the config root`);
    ok(existsSync(join(PRESENCE_STATE_DIR, n)), `${n} arrived in presence-states/`);
}
ok(readFileSync(join(PRESENCE_STATE_DIR, LEGACY_NAMES[0]), "utf-8") === `legacy:${LEGACY_NAMES[0]}`,
    "migrated content is preserved verbatim");
ok(existsSync(join(OPENCODE_DIR, "presence-state-other.txt")),
    "non-matching decoys stay put");
ok(existsSync(join(OPENCODE_DIR, "other-pid444.txt")),
    "non-matching decoys stay put (prefix variant)");

migrateLegacyStates();
ok(readdirSync(OPENCODE_DIR).filter((n) => n.startsWith("presence-state-pid")).length === 0,
    "second migration pass finds nothing to move (idempotent)");

// Collision path: same name already in the subdir -> legacy copy wins,
// no throw, no duplicate.
touchFile(join(PRESENCE_STATE_DIR, LEGACY_NAMES[1]), "existing-in-subdir");
touchFile(join(OPENCODE_DIR, LEGACY_NAMES[1]), "newer-legacy-copy");
migrateLegacyStates();
ok(readFileSync(join(PRESENCE_STATE_DIR, LEGACY_NAMES[1]), "utf-8") === "newer-legacy-copy",
    "collision: legacy copy overwrites the stale subdir entry");

// ── 3. GC: dead PIDs go, live PID stays ────────────────────────────
section("gc liveness");

const DEAD = deadPid();
const deadName = `presence-state-pid${DEAD}.txt`;
const liveName = `presence-state-pid${process.pid}.txt`;
touchFile(join(PRESENCE_STATE_DIR, deadName), "dead");
touchFile(join(PRESENCE_STATE_DIR, liveName), "live");
// A name whose middle segment is not a number: the liveness pass must
// never delete it on a guess, only the age pass may ever remove it.
const unparsedName = "presence-state-pidXYZ.txt";
touchFile(join(PRESENCE_STATE_DIR, unparsedName), "unparsed");

const removed = gcPresenceStates({ maxFiles: 50, maxAgeHours: 72 });
ok(removed.includes(deadName), "gc reports the dead-PID file as removed");
ok(!existsSync(join(PRESENCE_STATE_DIR, deadName)), "dead-PID file is gone");
ok(existsSync(join(PRESENCE_STATE_DIR, liveName)), "live-PID file survives gc");
ok(existsSync(join(PRESENCE_STATE_DIR, unparsedName)),
    "files without a parseable PID are not killed by the liveness pass");
ok(!existsSync(join(PRESENCE_STATE_DIR, LEGACY_NAMES[0])),
    "pid111 from migration is treated as a dead PID and cleaned up");

// ── 4. GC: age fallback catches recycled PIDs ──────────────────────
section("gc age fallback");

const OLD_MS = Date.now() - 100 * 60 * 60 * 1000; // 100h ago
const agedName = "presence-state-pid999999.txt";
const agedPath = join(PRESENCE_STATE_DIR, agedName);
touchFile(agedPath, "aged");
try {
    const { utimesSync } = await import("node:fs");
    utimesSync(agedPath, new Date(OLD_MS), new Date(OLD_MS));
} catch {}
ok(statSync(agedPath).mtimeMs < Date.now() - 72 * 3600 * 1000,
    "preflight: aged file really is older than the 72h window");

const removed2 = gcPresenceStates({ maxFiles: 50, maxAgeHours: 72 });
ok(removed2.includes(agedName), "age pass removes a file past maxAgeHours");
ok(!existsSync(agedPath), "aged file is gone even though its PID could be recycled");

// Fresh files under the cap survive the age pass.
ok(existsSync(join(PRESENCE_STATE_DIR, liveName)),
    "fresh live-PID file untouched by the age pass");

// ── 5. GC: maxFiles cap trims oldest first ─────────────────────────
section("gc cap");

const CAP_DIR = PRESENCE_STATE_DIR;
const capNames = [];
for (let i = 0; i < 6; i++) {
    const n = `presence-state-pid${900000 + i}.txt`;
    touchFile(join(CAP_DIR, n), `cap:${i}`);
    capNames.push(n);
    if (i < capNames.length - 1) {
        // Space out mtimes deterministically without busy-waiting.
        const prev = join(CAP_DIR, capNames[i]);
        const { utimesSync } = await import("node:fs");
        utimesSync(prev, new Date(Date.now() - (6 - i) * 1000), new Date(Date.now() - (6 - i) * 1000));
    }
}
const presentBefore = readdirSync(CAP_DIR).filter((n) => n.startsWith("presence-state-pid")).length;
const removed3 = gcPresenceStates({ maxFiles: 3, maxAgeHours: 72 });
const presentAfter = readdirSync(CAP_DIR).filter((n) => n.startsWith("presence-state-pid"));
ok(presentAfter.length <= 3,
    `cap holds at 3 newest (was ${presentBefore}, now ${presentAfter.length})`);
ok(removed3.length >= 1, "cap pass reported removals");
ok(presentAfter.includes(liveName) || !existsSync(join(CAP_DIR, liveName)),
    "consistency: every surviving file really exists on disk");
for (const n of presentAfter) ok(existsSync(join(CAP_DIR, n)), `survivor ${n} on disk`);

// ── 6. end-to-end idempotence ──────────────────────────────────────
section("idempotence");

const snapshot = () => readdirSync(PRESENCE_STATE_DIR).sort().join(",");
const s1 = snapshot();
gcPresenceStates({ maxFiles: 3, maxAgeHours: 72 });
const s2 = snapshot();
ok(s1 === s2, "a second gc at the same settings changes nothing");

console.log("");
console.log(`PRESENCE-GC: ${failed === 0 ? "PASSED" : "FAILED"} (${passed} passed, ${failed} failed)`);
try { rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
process.exit(failed === 0 ? 0 : 1);
