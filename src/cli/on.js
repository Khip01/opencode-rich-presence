import { writeState } from "../shared/presence-state.js";
import { sendControl } from "../shared/presence-control.js";

export async function on() {
    console.log("");
    const st = writeState({ presenceEnabled: true });
    const delivered = await sendControl({ type: "set-enabled", enabled: true });
    console.log("Rich Presence: enabled");
    console.log("");
    if (delivered) {
        console.log("Daemon notified. Presence resumes immediately.");
    } else {
        console.log("No running daemon found. The next chat.message will start one.");
    }
    if (st.daemonStopped) {
        console.log("");
        console.log("Note: the daemon was killed with 'opencode-rpc kill'.");
        console.log("Run 'opencode-rpc spawn' to start it again.");
    }
}