import { writeState } from "../shared/presence-state.js";
import { sendControl } from "../shared/presence-control.js";

export async function on() {
    console.log("");
    // `on` means "resume now", so it also clears the kill lock. Leaving
    // daemonStopped set made the plugin refuse to spawn (and, in the
    // first cut, refuse to even use a daemon that was demonstrably
    // alive), so `on` looked broken until `spawn` was run manually.
    writeState({ presenceEnabled: true, daemonStopped: false });
    const delivered = await sendControl({ type: "set-enabled", enabled: true });
    console.log("Rich Presence: enabled");
    console.log("");
    if (delivered) {
        console.log("Daemon notified. Presence resumes immediately.");
    } else {
        console.log("No running daemon found. It starts on the next chat.message.");
        console.log("If you stopped it with 'opencode-rpc kill', run 'opencode-rpc spawn'.");
    }
}