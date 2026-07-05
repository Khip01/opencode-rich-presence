import { existsSync } from "node:fs";
import { ACTIVITY_LOG } from "../shared/paths.js";

// Phase 1 has no worker subprocess (and no Discord push). The previous
// restart semantics (kill worker -> plugin respawns it) do not apply.
//
// In Phase 1, `restart` is a soft "start over" for the plugin side: it
// truncates the activity log so you get a clean history next time
// OpenCode starts. The user can achieve the same effect with
// `opencode-rpc install` and a fresh OpenCode launch, but this command
// exists for parity with the v2.0.x CLI surface.
//
// Phase 2 will redefine this to manage the daemon subprocess: kill the
// daemon so it is respawned by the next firing OpenCode. The CLI surface
// (the `restart` subcommand name) stays stable across both phases.
export async function restart() {
    console.log("\nopencode-rich-presence restart (Phase 1)\n");
    console.log("Phase 1 has no Discord worker. This command rotates the activity log so");
    console.log("the next OpenCode launch starts with a clean history.");
    console.log("");

    if (existsSync(ACTIVITY_LOG)) {
        try {
            const { renameSync } = await import("node:fs");
            const backup = `${ACTIVITY_LOG}.prev`;
            renameSync(ACTIVITY_LOG, backup);
            console.log(`Moved ${ACTIVITY_LOG}`);
            console.log(`       to ${backup}`);
        } catch (e) {
            console.log(`Failed to rotate activity log: ${e.message}`);
        }
    } else {
        console.log(`No activity log at ${ACTIVITY_LOG} (nothing to rotate).`);
    }

    console.log("");
    console.log("Next steps:");
    console.log("  1. Restart OpenCode so it reloads the plugin and starts writing to a fresh log.");
    console.log(`  2. tail -f ${ACTIVITY_LOG}  to follow the next session.`);
    console.log("");
    console.log("Phase 2 will redefine `restart` to manage the Discord daemon subprocess.");
}
