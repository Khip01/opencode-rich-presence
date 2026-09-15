import { writeState } from "../shared/presence-state.js";
import { sendControl } from "../shared/presence-control.js";

export async function off() {
    console.log("");
    writeState({ presenceEnabled: false });
    const delivered = await sendControl({ type: "set-enabled", enabled: false });
    console.log("Rich Presence: disabled");
    console.log("");
    if (delivered) {
        console.log("Daemon notified. Discord activity cleared.");
    } else {
        console.log("No running daemon found. Nothing to clear.");
    }
    console.log("The daemon stays alive so 'opencode-rpc on' resumes instantly.");
}