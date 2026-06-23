import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import { RESTART_SIGNAL, WORKER_SOURCE } from "../shared/paths.js";
import { log } from "../shared/logger.js";

// Cross-platform node/bun executable discovery.
// Tries: current process (if it's node/bun) -> known install paths -> PATH fallback.
export function findNodeExecutable() {
    const ep = process.execPath || "";
    const bn = basename(ep).toLowerCase();
    if (["node", "node.exe", "bun", "bun.exe"].includes(bn)) return ep;

    const home = homedir();
    const ver = process.versions?.node || "";
    const candidates = [
        ver ? join(home, ".nvm", "versions", "node", `v${ver}`, "bin", "node") : null,
        // Unix-like
        "/usr/bin/node",
        "/usr/local/bin/node",
        "/opt/homebrew/bin/node",
        // Windows
        process.env.ProgramFiles ? join(process.env.ProgramFiles, "nodejs", "node.exe") : null,
        process.env["ProgramFiles(x86)"] ? join(process.env["ProgramFiles(x86)"], "nodejs", "node.exe") : null,
        process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "nodejs", "node.exe") : null,
        // macOS (Intel) fallback
        "/usr/local/opt/node/bin/node",
    ].filter(Boolean);

    for (const p of candidates) {
        try { accessSync(p, constants.X_OK); return p; } catch {}
    }
    return "node"; // PATH fallback
}

const NODE_EXECUTABLE = findNodeExecutable();

// Spawns the worker subprocess and routes its stdout/stderr messages to onMessage/onStderr callbacks.
// Returns a handle with .kill() for graceful shutdown.
export function spawnWorker({ env, onMessage, onStderr, onExit }) {
    const wp = WORKER_SOURCE;
    log(`Spawn worker: ${wp} (${NODE_EXECUTABLE})`);

    const proc = spawn(NODE_EXECUTABLE, [wp], {
        stdio: ["pipe", "pipe", "pipe"],
        env,
        detached: false,
    });

    let stdoutBuf = "";
    proc.stdout.setEncoding("utf-8");
    proc.stdout.on("data", (c) => {
        stdoutBuf += c;
        let i, l;
        while ((i = stdoutBuf.indexOf("\n")) !== -1) {
            l = stdoutBuf.slice(0, i).trim();
            stdoutBuf = stdoutBuf.slice(i + 1);
            if (!l) continue;
            try {
                const m = JSON.parse(l);
                onMessage?.(m);
            } catch {}
        }
    });

    proc.stderr.setEncoding("utf-8");
    proc.stderr.on("data", (c) => log("[worker stderr]", c.trim()));

    proc.on("exit", (code, sig) => {
        log(`Worker exited: code=${code} sig=${sig}`);

        // Detect intentional restart signal (from CLI restart command)
        let isIntentionalRestart = false;
        try {
            if (existsSync(RESTART_SIGNAL)) {
                isIntentionalRestart = true;
                try { require("node:fs").unlinkSync(RESTART_SIGNAL); } catch {}
                log("Restart signal detected - will wait 2s for IPC socket to release");
            }
        } catch {}

        onExit?.({ code, signal: sig, isIntentionalRestart });
    });

    proc.on("error", (e) => { log(`Worker error: ${e.message}`); });

    return proc;
}
