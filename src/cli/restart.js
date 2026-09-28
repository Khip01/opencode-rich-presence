import { existsSync, unlinkSync } from "node:fs";
import { ACTIVITY_LOG, DAEMON_SOCKET, DAEMON_PID_FILE } from "../shared/paths.js";
import { readDaemonPid, unlinkSocketPath } from "../shared/daemon-liveness.js";

// Phase 2 daemon restart: kill the daemon subprocess so the next
// OpenCode firing spawns a fresh one with a clean state. We also
// rotate the activity log for a clean diagnostic history.
export async function restart() {
    console.log("\nopencode-rich-presence restart (Phase 2)\n");

    // Kill the daemon if it is running. We do this by reading its
    // PID file and sending SIGTERM. SIGKILL after 2s grace if it
    // does not exit.
    let killedPid = null;
    const pid = readDaemonPid();
    if (pid !== null) {
        try {
            process.kill(pid, "SIGTERM");
            killedPid = pid;
            console.log(`Sent SIGTERM to daemon (pid ${pid})`);
            // Give it a moment to clean up.
            await new Promise((r) => setTimeout(r, 500));
            try { process.kill(pid, "SIGKILL"); } catch {}
        } catch (e) {
            console.log(`Could not signal daemon pid ${pid}: ${e.message}`);
        }
    }
    if (existsSync(DAEMON_PID_FILE)) {
        try { unlinkSync(DAEMON_PID_FILE); } catch {}
    }

    // Only POSIX has a socket file to clear; on Windows the named pipe
    // disappears with the process.
    if (unlinkSocketPath()) {
        console.log(`Removed stale socket: ${DAEMON_SOCKET}`);
    }

    if (existsSync(ACTIVITY_LOG)) {
        try {
            const { renameSync } = await import("node:fs");
            const backup = `${ACTIVITY_LOG}.prev`;
            renameSync(ACTIVITY_LOG, backup);
            console.log(`Rotated activity log to ${backup}`);
        } catch (e) {
            console.log(`Failed to rotate activity log: ${e.message}`);
        }
    } else {
        console.log(`No activity log at ${ACTIVITY_LOG} (nothing to rotate).`);
    }

    console.log("");
    console.log("Next steps:");
    console.log("  1. The next OpenCode chat.message will spawn a fresh daemon.");
    console.log(`  2. tail -f ${ACTIVITY_LOG} to follow the next session.`);
    if (killedPid) {
        console.log(`  (Killed old daemon pid ${killedPid}; it will respawn on next firing.)`);
    }
}
