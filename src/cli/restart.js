import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { platform } from "node:process";
import { homedir } from "node:os";
import { join } from "node:path";
import { RESTART_SIGNAL, OPENCODE_DIR, CONFIG_PATH } from "../shared/paths.js";
import { getPlatformName } from "./platform/index.js";

// Kill the discord-worker.mjs subprocess (NOT Discord Desktop).
// The plugin sees the restart signal, reloads config, and respawns the worker.
function killWorker() {
    const isWin = platform === "win32";

    if (isWin) {
        // Windows: use wmic to find node processes with discord-worker.mjs in command line
        try {
            const out = execSync(
                `wmic process where "name='node.exe'" get processid,commandline /format:csv`,
                { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }
            );
            const lines = out.split("\n").slice(1);
            const pids = [];
            for (const line of lines) {
                if (line.includes("discord-worker.mjs")) {
                    const match = /,(\d+)\s*$/.exec(line);
                    if (match) pids.push(match[1]);
                }
            }
            if (pids.length) {
                execSync(`taskkill /PID ${pids.join(",")} /T /F`, { stdio: "ignore" });
                return pids.length;
            }
        } catch {}
        return 0;
    }

    // Linux/macOS: use pgrep
    try {
        const out = execSync("pgrep -f discord-worker.mjs", { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] });
        const pids = out.trim().split("\n").filter(Boolean);
        if (pids.length) {
            try { execSync(`kill -TERM ${pids.join(" ")}`, { stdio: "ignore" }); } catch {}
            return pids.length;
        }
    } catch {}
    return 0;
}

function readConfigSummary() {
    if (!existsSync(CONFIG_PATH)) {
        return { exists: false, appId: null, asset: null };
    }
    try {
        const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
        return { exists: true, appId: cfg.discordAppId || null, asset: cfg.discordLargeImageKey || null };
    } catch {
        return { exists: true, appId: null, asset: null };
    }
}

export async function restart() {
    console.log("\nopencode-rich-presence worker restart\n");

    if (!existsSync(OPENCODE_DIR)) {
        console.error(`OpenCode config directory does not exist: ${OPENCODE_DIR}`);
        console.error("Run `opencode-rpc install` first.");
        process.exit(1);
    }

    // Step 1: write signal file
    writeFileSync(RESTART_SIGNAL, String(process.pid));
    console.log(`Restart signal written: ${RESTART_SIGNAL}`);

    // Step 2: kill worker (graceful)
    const killed = killWorker();
    if (killed > 0) {
        console.log(`Killed ${killed} worker process(es).`);
    } else {
        console.log("No running workers found.");
        console.log("(Signal file still in place. Plugin will pick it up on next event.)");
    }

    // Step 3: print current config
    console.log("\nCurrent Discord config:");
    const cfg = readConfigSummary();
    if (!cfg.exists) {
        console.log(`  Config file not found: ${CONFIG_PATH}`);
        console.log("  Using environment variables or fallback defaults.");
    } else {
        console.log(`  Config file: ${CONFIG_PATH}`);
        console.log(`  App ID : ${cfg.appId || "<not set>"}`);
        console.log(`  Asset  : ${cfg.asset || "<not set>"}`);
    }
    console.log(`  DISCORD_APP_ID env         : ${process.env.DISCORD_APP_ID || "<not set>"}`);
    console.log(`  DISCORD_LARGE_IMAGE_KEY env: ${process.env.DISCORD_LARGE_IMAGE_KEY || "<not set>"}`);

    // Step 4: next steps
    console.log("\nNext steps:");
    console.log("Plugin detects restart signal:");
    console.log("  1. Waiting 2s for old IPC socket to release");
    console.log("  2. Reloading config");
    console.log("  3. Spawning new worker");
    console.log("\nMonitor with:");
    console.log("  tail -f ~/.config/opencode/presence-state.txt");
    console.log("\nExpected within ~7 seconds: `Discord: connected`");
    console.log(`\nNote: Discord Desktop is not restarted by this command.`);
    console.log(`If Discord Desktop itself is stuck, close and reopen it manually.`);
    console.log(`Detected platform: ${getPlatformName()}\n`);
}
