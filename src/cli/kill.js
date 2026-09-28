import { existsSync, unlinkSync } from "node:fs";
import { DAEMON_PID_FILE } from "../shared/paths.js";
import { readDaemonPid, unlinkSocketPath } from "../shared/daemon-liveness.js";
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
    const pid = readDaemonPid();
    if (pid !== null) {
        try {
            process.kill(pid, "SIGTERM");
            killedPid = pid;
            await new Promise((r) => setTimeout(r, 500));
            try { process.kill(pid, "SIGKILL"); } catch {}
        } catch {}
    }
    if (existsSync(DAEMON_PID_FILE)) {
        try { unlinkSync(DAEMON_PID_FILE); } catch {}
    }

    // No-op on Windows, where the IPC address is a named pipe owned by
    // the process and removed automatically when it exits.
    unlinkSocketPath();

    console.log("");
    if (killedPid) {
        console.log(`Daemon stopped (pid ${killedPid}).`);
    } else {
        console.log("No running daemon found.");
    }
    console.log("Run 'opencode-rpc spawn' to start it again.");
}