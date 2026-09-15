import { existsSync, unlinkSync, readFileSync } from "node:fs";
import { DAEMON_SOCKET, DAEMON_PID_FILE } from "../shared/paths.js";
import { writeState } from "../shared/presence-state.js";
import { confirm } from "./prompt.js";

export async function kill() {
    console.log("");
    console.log("WARNING: 'kill' permanently stops the daemon and drops the");
    console.log("Discord IPC connection. Only 'opencode-rpc spawn' can start");
    console.log("it again.");
    console.log("");
    console.log("Possible issues after killing:");
    console.log("  - Discord may silently rate-limit reconnects (App-ID");
    console.log("    cooldown). Presence could fail to appear for up to a few");
    console.log("    minutes after spawn.");
    console.log("  - If Discord Desktop is in a bad state, you may need to");
    console.log("    restart it too.");
    console.log("");

    const ok = await confirm("Continue?", { defaultYes: false });
    if (!ok) {
        console.log("Cancelled. Daemon left running.");
        return;
    }

    // Block auto-respawn first so a chat.message fired while we tear
    // down the daemon does not immediately start a new one.
    writeState({ daemonStopped: true });

    let killedPid = null;
    if (existsSync(DAEMON_PID_FILE)) {
        try {
            const pid = parseInt(readFileSync(DAEMON_PID_FILE, "utf-8").trim(), 10);
            if (pid > 0) {
                try {
                    process.kill(pid, "SIGTERM");
                    killedPid = pid;
                    await new Promise((r) => setTimeout(r, 500));
                    try { process.kill(pid, "SIGKILL"); } catch {}
                } catch {}
            }
        } catch {}
        try { unlinkSync(DAEMON_PID_FILE); } catch {}
    }

    if (existsSync(DAEMON_SOCKET)) {
        try { unlinkSync(DAEMON_SOCKET); } catch {}
    }

    console.log("");
    if (killedPid) {
        console.log(`Daemon stopped (pid ${killedPid}).`);
    } else {
        console.log("No running daemon found.");
    }
    console.log("Run 'opencode-rpc spawn' to start it again.");
}