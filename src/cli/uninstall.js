import { existsSync, unlinkSync, readFileSync, writeFileSync, renameSync, lstatSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { CONFIG_PATH, LOCK_FILE, RESTART_SIGNAL, OUTPUT_FILE, OPENCODE_DIR } from "../shared/paths.js";
import { confirm } from "./prompt.js";

const PLUGIN_NAME = "opencode-rich-presence";
const PLUGIN_DEP = "@xhayper/discord-rpc";

export async function uninstall() {
    console.log("\nopencode-rich-presence uninstaller\n");

    let removed = 0;

    // Runtime files written by the plugin while OpenCode is running. Safe to delete
    // unconditionally: they are regenerated on next plugin start if reinstalled.
    console.log("Cleaning up plugin-generated runtime files:");
    for (const f of [LOCK_FILE, RESTART_SIGNAL, OUTPUT_FILE]) {
        if (tryRemove(f)) removed++;
    }

    // Local plugin symlink installed by `opencode-rpc install`. Created so OpenCode
    // can load the plugin without it being on the npm registry.
    const pluginLink = join(OPENCODE_DIR, "plugins", `${PLUGIN_NAME}.js`);
    if (existsSync(pluginLink)) {
        let isSymlink = false;
        try { isSymlink = lstatSync(pluginLink).isSymbolicLink(); } catch {}
        if (isSymlink) {
            if (tryRemove(pluginLink)) removed++;
        } else {
            console.log(`  Skipped ${pluginLink}: not a symlink (remove manually if you want it gone)`);
        }
    }

    // The dependency the installer added to ~/.config/opencode/package.json.
    // Remove from package.json AND from node_modules (via npm install) so the user's
    // OpenCode dir does not carry leftover presence plugin artifacts.
    if (removePluginDependency()) removed++;

    // Discord config file: ask before deleting (default N). This file holds the
    // user's Discord App ID and custom templates. Back up before delete if user agrees.
    if (await maybeDeleteConfig()) removed++;

    // Show explicit instruction for removing the plugin entry from opencode.jsonc.
    // We do NOT touch this file because other plugins may share it.
    showOpencodeJsoncHint();

    console.log("");
    console.log("Final cleanup (run manually if you want a full uninstall):");
    console.log(`  npm uninstall -g ${PLUGIN_NAME}    (removes the CLI globally)`);
    console.log("");
    console.log(`Done. Removed ${removed} plugin-generated file(s).`);
}

function tryRemove(filePath) {
    try {
        unlinkSync(filePath);
        console.log(`  removed ${filePath}`);
        return true;
    } catch (e) {
        if (e.code === "ENOENT") return false;
        console.log(`  failed to remove ${filePath}: ${e.message}`);
        return false;
    }
}

// Remove @xhayper/discord-rpc from ~/.config/opencode/package.json. This dependency
// was added by `opencode-rpc install` so the worker subprocess could resolve it. On
// uninstall we reverse the change and re-run `npm install` in the config directory
// so node_modules is pruned too.
function removePluginDependency() {
    const pkgPath = join(OPENCODE_DIR, "package.json");
    if (!existsSync(pkgPath)) return false;

    let pkg;
    try { pkg = JSON.parse(readFileSync(pkgPath, "utf-8")); } catch { return false; }
    if (!pkg.dependencies || !pkg.dependencies[PLUGIN_DEP]) return false;

    delete pkg.dependencies[PLUGIN_DEP];
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
    console.log(`  removed ${PLUGIN_DEP} from ${pkgPath}`);

    try {
        console.log(`  running npm install to prune ${PLUGIN_DEP} from node_modules...`);
        execSync("npm install --no-audit --no-fund", { cwd: OPENCODE_DIR, stdio: "inherit" });
    } catch (e) {
        console.log(`  npm install failed (you can run it manually): ${e.message}`);
    }
    return true;
}

// Ask user before deleting the Discord config (default N). If user agrees, back up
// the file with a timestamp suffix and remove the original.
async function maybeDeleteConfig() {
    if (!existsSync(CONFIG_PATH)) return false;

    console.log("");
    const ok = await confirm(`Delete ${CONFIG_PATH}?`, { defaultYes: false });
    if (!ok) {
        console.log(`  Kept. The file remains at ${CONFIG_PATH}.`);
        return false;
    }

    const backup = `${CONFIG_PATH}.backup-${Date.now()}`;
    try {
        renameSync(CONFIG_PATH, backup);
        console.log(`  Backed up to: ${backup}`);
        console.log(`  This file is persistent (in your home dir, NOT in /tmp).`);
        console.log(`  Delete it manually when you no longer need it.`);
        return true;
    } catch (e) {
        console.log(`  Backup/remove failed: ${e.message}`);
        return false;
    }
}

// Print a clear instruction for removing the plugin entry from opencode.jsonc.
// We do not modify this file because other plugins or settings live there.
function showOpencodeJsoncHint() {
    console.log("");
    console.log("Manual edit required in OpenCode config:");
    const configFile = existsSync(join(OPENCODE_DIR, "opencode.jsonc"))
        ? join(OPENCODE_DIR, "opencode.jsonc")
        : join(OPENCODE_DIR, "opencode.json");

    console.log(`  ${configFile}`);
    console.log("");
    console.log(`  Remove this entry from the "plugin" array:`);
    console.log("");
    console.log(`    "plugin": [`);
    console.log(`      "opencode-rich-presence"     <-- DELETE THIS LINE`);
    console.log(`    ]`);
}
