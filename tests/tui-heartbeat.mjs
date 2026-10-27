#!/usr/bin/env node
// TUI part harness: verifies src/plugin/index.tui.js keeps the client
// heartbeat file fresh while it runs and stops after cleanup.
//
// The heartbeat is the only "a client window is attached" signal the
// server part gets (OpenCode emits no client disconnect event), so the
// touching behavior and the unref'd interval are load-bearing.

import "./test-env.mjs";
import assert from "node:assert/strict";
import { existsSync, rmSync, statSync } from "node:fs";

const { CLIENT_HEARTBEAT } = await import("../src/shared/paths.js");
const tui = (await import("../src/plugin/index.tui.js")).default;
const { beat, HEARTBEAT_INTERVAL_MS } = await import("../src/plugin/index.tui.js");

let failed = 0;
let passed = 0;
function ok(cond, msg) {
    if (cond) { passed++; console.log(`  ok   ${msg}`); }
    else { failed++; console.log(`  FAIL ${msg}`); }
}

console.log("== beat() touches the heartbeat file ==");
rmSync(CLIENT_HEARTBEAT, { force: true });
beat();
ok(existsSync(CLIENT_HEARTBEAT), "beat() creates the heartbeat file");
const t0 = statSync(CLIENT_HEARTBEAT).mtimeMs;
await new Promise((r) => setTimeout(r, 30));
beat();
ok(statSync(CLIENT_HEARTBEAT).mtimeMs >= t0, "beat() bumps the mtime");

console.log("\n== setup() heartbeats, cleanup() stops ==");
ok(typeof tui.setup === "function", "TUI part exposes setup()");
const cleanup = tui.setup();
ok(typeof cleanup === "function", "setup() returns a cleanup function");
const t1 = statSync(CLIENT_HEARTBEAT).mtimeMs;
await new Promise((r) => setTimeout(r, HEARTBEAT_INTERVAL_MS + 2000));
ok(statSync(CLIENT_HEARTBEAT).mtimeMs > t1, "heartbeat ticks while the client runs");
cleanup();
const t2 = statSync(CLIENT_HEARTBEAT).mtimeMs;
await new Promise((r) => setTimeout(r, HEARTBEAT_INTERVAL_MS + 2000));
ok(statSync(CLIENT_HEARTBEAT).mtimeMs === t2, "cleanup stops the heartbeat");

console.log("");
console.log(`TUI-HEARTBEAT: ${failed === 0 ? "PASSED" : "FAILED"} (${passed} passed, ${failed} failed)`);
try { rmSync(process.env.OPENCODE_CONFIG_DIR, { recursive: true, force: true }); } catch {}
process.exit(failed === 0 ? 0 : 1);
