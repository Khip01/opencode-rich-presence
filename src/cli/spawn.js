import { spawnDaemonDetached, waitForDaemonSocket } from "../plugin/daemon-spawner.js";
import { readState, writeState } from "../shared/presence-state.js";
import { sendControl } from "../shared/presence-control.js";
import { readDaemonPid, isPidAlive } from "../shared/daemon-liveness.js";

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

    // Singleton guard: only one daemon may hold the IPC address and the
    // Discord IPC connection at a time. A second daemon would remove the
    // first one's address and steal the Discord connection from it, so
    // the plugin's pushes (still going through the first daemon) would
    // stop reaching Discord until the plugin reconnects. This check is
    // PID-based rather than path-based so it also works on Windows,
    // where the address is a named pipe rather than a file.
    const existingPid = readDaemonPid();
    if (existingPid !== null && existingPid !== process.pid && isPidAlive(existingPid)) {
        console.log(`Daemon is already running (pid ${existingPid}).`);
        console.log("Nothing to do. Use 'opencode-rpc restart' if you need");
        console.log("to force a fresh daemon.");
        return;
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
        console.log("Daemon did not come up in time.");
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