import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { OPENCODE_DIR, RESTART_SIGNAL } from "../shared/paths.js";
import { restartDiscord } from "./platform/index.js";
import { confirm } from "./prompt.js";

export async function restart() {
    console.log("\nRestarting Discord desktop client...\n");

    if (!existsSync(OPENCODE_DIR)) {
        mkdirSync(OPENCODE_DIR, { recursive: true });
    }

    try {
        writeFileSync(RESTART_SIGNAL, String(process.pid));
        console.log(`Wrote restart signal: ${RESTART_SIGNAL}`);
    } catch (e) {
        console.error(`Failed to write restart signal: ${e.message}`);
        process.exit(1);
    }

    const ok = await confirm("\nAlso restart the Discord desktop app now?", { defaultYes: true });
    if (!ok) {
        console.log("\nRestart signal written. The plugin will reload on next event.");
        console.log("(Or run 'opencode-rpc restart' again to also restart Discord.)\n");
        return;
    }

    try {
        await restartDiscord();
        console.log("\nDiscord restart triggered.\n");
    } catch (e) {
        console.error(`\nFailed to restart Discord: ${e.message}\n`);
        process.exit(1);
    }
}
