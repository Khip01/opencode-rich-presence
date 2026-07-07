// Daemon spawner: spawns the daemon subprocess on first firing.
//
// The plugin uses this when a chat.message fires and the daemon
// socket is not present. We:
//   1. Spawn `node <pkg>/src/worker/daemon.mjs` detached
//   2. Poll for the daemon socket file to appear (up to timeout)
//   3. Return success if the socket is present
//
// If the spawn fails or the socket does not appear in time, we return
// false and the plugin falls back to local-only behavior (Phase 1
// style log).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { DAEMON_SOCKET } from "../shared/paths.js";
import { log, activity } from "../shared/logger.js";

// Generous timeout: after a previous daemon exits, Linux can hold
// the Unix socket in TIME_WAIT for several seconds before the OS
// fully releases it. The daemon retries listen() with backoff for
// up to 15s, so we wait at least that long here.
const SPAWN_TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 100;

// Find a node executable. Same approach as the previous worker-spawner.
function findNodeExecutable() {
    const ep = process.execPath || "";
    const bn = basename(ep).toLowerCase();
    if (["node", "node.exe"].includes(bn)) return ep;
    const ver = process.versions?.node || "";
    if (ver) {
        const p = join(homedir(), ".nvm", "versions", "node", `v${ver}`, "bin", "node");
        if (existsSync(p)) return p;
    }
    const fallbacks = ["/usr/bin/node", "/usr/local/bin/node", "/opt/homebrew/bin/node"];
    for (const p of fallbacks) if (existsSync(p)) return p;
    return "node";
}

let spawning = false;
let lastSpawnAt = 0;
const MIN_SPAWN_INTERVAL_MS = 2000; // debounce so two simultaneous chat.messages don't both spawn

export async function ensureDaemonRunning() {
    if (existsSync(DAEMON_SOCKET)) {
        return true;
    }
    if (spawning) {
        // Wait for the in-flight spawn to finish.
        const start = Date.now();
        while (spawning && Date.now() - start < SPAWN_TIMEOUT_MS) {
            await new Promise((r) => setTimeout(r, 50));
        }
        return existsSync(DAEMON_SOCKET);
    }
    if (Date.now() - lastSpawnAt < MIN_SPAWN_INTERVAL_MS) {
        // Someone just tried to spawn. Give them a moment.
        return existsSync(DAEMON_SOCKET);
    }
    spawning = true;
    lastSpawnAt = Date.now();
    try {
        const ok = await spawnDaemon();
        return ok;
    } finally {
        spawning = false;
    }
}

async function spawnDaemon() {
    // The daemon source path is computed from the plugin entry path
    // so it follows the npm symlink correctly.
    const pluginUrl = new URL("../worker/daemon.mjs", import.meta.url);
    const daemonSource = fileURLToPath(pluginUrl);

    if (!existsSync(daemonSource)) {
        log(`daemon source missing: ${daemonSource}`);
        activity("daemon", `spawn failed: source missing at ${daemonSource}`);
        return false;
    }

    const nodeExe = findNodeExecutable();
    log(`Spawning daemon: ${nodeExe} ${daemonSource}`);
    activity("daemon", `spawning ${nodeExe} ${daemonSource}`);

    let proc;
    try {
        proc = spawn(nodeExe, [daemonSource], {
            detached: true,
            // stdio: stderr was previously "pipe" so the parent could
            // see crash output. But a piped stderr is a Linux pipe fd;
            // when the parent opencode process exits the pipe closes,
            // and any subsequent daemon write to stderr throws EPIPE.
            // That EPIPE was leaking as an uncaughtException in the
            // daemon and terminating it with code=1, so the next
            // opencode launch spawned a fresh daemon instead of
            // reusing the alive one. Switch stderr to "ignore" so
            // no pipe is created. Daemon logs already go to the
            // activity log via appendFileSync (see logToFile), so
            // stderr is redundant.
            stdio: ["ignore", "ignore", "ignore"],
            env: { ...process.env },
        });
    } catch (e) {
        log(`daemon spawn threw: ${e?.message || e}`);
        activity("daemon", `spawn threw: ${e?.message || e}`);
        return false;
    }

    proc.unref();

    // Wait for the socket file to appear.
    const start = Date.now();
    while (Date.now() - start < SPAWN_TIMEOUT_MS) {
        if (existsSync(DAEMON_SOCKET)) {
            // Give the daemon a brief moment to start listening.
            await new Promise((r) => setTimeout(r, 100));
            return true;
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    log(`daemon socket did not appear within ${SPAWN_TIMEOUT_MS}ms`);
    activity("daemon", `spawn timeout: socket did not appear in ${SPAWN_TIMEOUT_MS}ms`);
    return false;
}
