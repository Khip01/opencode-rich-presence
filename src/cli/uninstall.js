import { existsSync, unlinkSync, renameSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { CONFIG_PATH, LOCK_FILE, RESTART_SIGNAL, OUTPUT_FILE } from "../shared/paths.js";
import { confirm } from "./prompt.js";

export async function uninstall() {
    console.log("\nopencode-rich-presence uninstaller\n");

    const home = homedir();
    const opencodeCfg = join(home, ".config", "opencode", "opencode.json");
    const opencodeCfgJsonc = join(home, ".config", "opencode", "opencode.jsonc");

    console.log("Step 1: Remove plugin from OpenCode config\n");
    for (const p of [opencodeCfgJsonc, opencodeCfg]) {
        if (!existsSync(p)) continue;
        const raw = readFileSync(p, "utf-8");
        if (!raw.includes("opencode-rich-presence")) continue;
        console.log(`  Found reference in: ${p}`);
        console.log('  Manually remove the line: "opencode-rich-presence" from the "plugin" array.');
    }
    console.log("  (or run: opencode and use /config to edit)\n");

    console.log("Step 2: Clean up generated files\n");
    for (const f of [LOCK_FILE, RESTART_SIGNAL, OUTPUT_FILE]) {
        if (!existsSync(f)) continue;
        const ok = await confirm(`  Delete ${f}?`, { defaultYes: false });
        if (ok) {
            try { unlinkSync(f); console.log(`    deleted`); }
            catch (e) { console.log(`    failed: ${e.message}`); }
        }
    }

    if (existsSync(CONFIG_PATH)) {
        const ok = await confirm(`\n  Delete ${CONFIG_PATH}?`, { defaultYes: false });
        if (ok) {
            const backup = `${CONFIG_PATH}.backup-${Date.now()}`;
            try {
                renameSync(CONFIG_PATH, backup);
                console.log(`    moved to ${backup}`);
            } catch (e) {
                console.log(`    failed: ${e.message}`);
            }
        }
    }

    console.log("\nStep 3: Remove CLI globally (optional)\n");
    console.log("  npm uninstall -g opencode-rich-presence\n");
    console.log("Done.\n");
}
