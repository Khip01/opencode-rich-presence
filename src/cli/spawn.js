import { spawnDaemonDetached, waitForDaemonSocket } from "../plugin/daemon-spawner.js";
import { readState, writeState } from "../shared/presence-state.js";
import { sendControl } from "../shared/presence-control.js";
import { existsSync, readFileSync } from "node:fs";
import { DAEMON_PID_FILE } from "../shared/paths.js";

export async function spawn() {
    console.log("");
    const st = readState();
    if (!st.presenceEnabled) {
        console.log("Presence is disabled ('opencode-rpc off').");
        console.log("Run 'opencode-rpc on' first, then spawn if still needed.");
        return;
    }

    if (st.daemonStopped) {
        // Clear the kill lock so the auto-spawn path works again even
        // if the explicit spawn below fails.
        writeState({ daemonStopped: false });
    }

    // Singleton guard: only one daemon may hold the socket and the
    // Discord IPC connection at a time. A second daemon would unlink
    // the socket path and steal the Discord connection from the first
    // one, so the plugin's pushes (still going through the first
    // daemon) would stop reaching Discord until the plugin reconnects.
    if (existsSync(DAEMON_PID_FILE)) {
        let existingPid = 0;
        try {
            existingPid = parseInt(readFileSync(DAEMON_PID_FILE, "utf-8").trim(), 10);
        } catch {}
        if (existingPid > 0 && existingPid !== process.pid) {
            let alive = false;
            try { process.kill(existingPid, 0); alive = true; } catch {}
            if (alive) {
                console.log(`Daemon is already running (pid ${existingPid}).`);
                console.log("Nothing to do. Use 'opencode-rpc restart' if you need");
                console.log("to force a fresh daemon.");
                return;
            }
        }
    }

    const pid = spawnDaemonDetached();
    if (!pid) {
        console.log("Failed to spawn the daemon (source missing or spawn error).");
        console.log("Check the activity log for details.");
        return;
    }

    console.log(`Daemon starting (pid ${pid})...`);
    const ok = await waitForDaemonSocket();
    if (!ok) {
        console.log("Daemon socket did not appear in time.");
        console.log("Try 'opencode-rpc restart', or check the activity log.");
        return;
    }

    await sendControl({ type: "set-enabled", enabled: true });

    console.log("");
    console.log("Daemon is up. Presence resumes on the next chat.message.");
    console.log("");
    console.log("Note: Discord can silently rate-limit reconnects after a");
    console.log("full daemon stop. If presence does not appear within a few");
    console.log("minutes, restart Discord Desktop and try again.");
}