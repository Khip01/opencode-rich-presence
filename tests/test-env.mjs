// Test environment setup: isolate from the user's real ~/.config/opencode
// installation so test logs do not mix with running opencode sessions.
//
// This MUST be imported first by any test harness (before ../src/plugin
// or ../src/worker/daemon) so the env vars are in place before those
// modules compute paths at import time.
//
// Usage:
//     import "./test-env.mjs";  // sets up OPENCODE_CONFIG_DIR
//     import { OpencodeRichPresence } from "../src/plugin/index.js";
//
// Or just `node --import ./tests/test-env.mjs tests/...harness.mjs`.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.OPENCODE_CONFIG_DIR) {
    const TEST_TMP = mkdtempSync(join(tmpdir(), `orp-test-${process.pid}-${Date.now()}-`));
    process.env.OPENCODE_CONFIG_DIR = TEST_TMP;
    // Daemon looks for discord-ipc in XDG_RUNTIME_DIR first. Point it at
    // the same temp dir so any future mock Discord IPC server we add
    // has a predictable location.
    process.env.XDG_RUNTIME_DIR = TEST_TMP;
}
