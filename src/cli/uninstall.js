import { existsSync, unlinkSync, readFileSync, writeFileSync, renameSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_PATH, OUTPUT_FILE, ACTIVITY_LOG, OPENCODE_DIR, DAEMON_SOCKET, DAEMON_PID_FILE, PRESENCE_STATE, IS_WINDOWS, PRESENCE_STATE_DIR } from "../shared/paths.js";
import { readDaemonPid } from "../shared/daemon-liveness.js";
import { confirm } from "./prompt.js";

const PLUGIN_NAME = "opencode-rich-presence";
// Legacy v2.x file paths. May still exist from older installs.
const LEGACY_LOCK_FILE = join(OPENCODE_DIR, ".opencode-rich-presence.lock");
const LEGACY_RESTART_SIGNAL = join(OPENCODE_DIR, ".discord-restart-request");

export async function uninstall() {
    console.log("\nopencode-rich-presence uninstaller\n");

    let removed = 0;

    // Try to stop the daemon first. Reading the PID file and sending
    // SIGTERM is best-effort; if the daemon is not running, this is
    // a no-op.
    const runningPid = readDaemonPid();
    if (runningPid !== null) {
        try { process.kill(runningPid, "SIGTERM"); } catch {}
        console.log(`Signaled daemon pid ${runningPid} to stop.`);
    }

    // Runtime files written by the plugin while OpenCode is running. Safe to delete
    // unconditionally: they are regenerated on next plugin start if reinstalled.
    console.log("Cleaning up plugin-generated runtime files:");
    const runtimeFiles = [
        LEGACY_LOCK_FILE,
        LEGACY_RESTART_SIGNAL,
        OUTPUT_FILE,
        ACTIVITY_LOG,
        DAEMON_PID_FILE,
        PRESENCE_STATE,
    ];
    // The IPC address is a socket file on POSIX but a named pipe on
    // Windows, and a pipe cannot be unlinked: the kernel entry is owned
    // by the daemon process and is gone once it exits. Trying to unlink
    // it would print a confusing failure, so only offer it where it is a
    // real file.
    if (!IS_WINDOWS) runtimeFiles.push(DAEMON_SOCKET);
    for (const f of runtimeFiles) {
        if (tryRemove(f)) removed++;
    }

    // Per-instance state files. Since 3.4 they live under
    // presence-states/; the flat glob below stays as a fallback for
    // installs that never ran the new plugin init.
    try {
        const { readdirSync, rmSync } = await import("node:fs");
        if (existsSync(PRESENCE_STATE_DIR)) {
            rmSync(PRESENCE_STATE_DIR, { recursive: true, force: true });
            removed++;
        }
        const dir = OPENCODE_DIR;
        if (existsSync(dir)) {
            for (const name of readdirSync(dir)) {
                if (name.startsWith("presence-state-pid") && name.endsWith(".txt")) {
                    const full = join(dir, name);
                    if (tryRemove(full)) removed++;
                }
            }
        }
    } catch {}

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

    // Discord config file: ask before deleting (default N). This file holds the
    // user's Discord App ID and custom templates. Back up before delete if user agrees.
    if (await maybeDeleteConfig()) removed++;

    // v2.0.5-era installs added `opencode-rich-presence` to the `plugin` array in
    // opencode.jsonc/.json. That entry makes OpenCode try to fetch the package from
    // the npm registry on every startup, returning 404. Remove the entry as part of
    // uninstall so the user does not carry a stale entry (and a noisy notification)
    // after removing the plugin.
    if (maybeRemoveFromOpencodeConfig()) removed++;

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

// Remove `opencode-rich-presence` from the `plugin` array in the user's
// OpenCode config (opencode.jsonc or opencode.json). v2.0.5-era installs
// added this entry, which makes OpenCode try to fetch the package from the
// npm registry on every startup, returning 404. We auto-remove on uninstall
// because the user is leaving and the entry is now useless. JSONC-tolerant.
function maybeRemoveFromOpencodeConfig() {
    const jsonc = join(OPENCODE_DIR, "opencode.jsonc");
    const json = join(OPENCODE_DIR, "opencode.json");
    const configFile = existsSync(jsonc) ? jsonc : existsSync(json) ? json : null;
    if (!configFile) return false;

    const raw = readFileSync(configFile, "utf-8");
    if (!raw.includes(`"${PLUGIN_NAME}"`)) return false;

    let parsed;
    try {
        const stripped = raw
            .replace(/(?<!:)\/\/.*$/gm, "")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/,(\s*[}\]])/g, "$1");
        parsed = JSON.parse(stripped);
    } catch (e) {
        console.log(`  Could not parse ${configFile} as JSON/JSONC.`);
        console.log(`  Remove "${PLUGIN_NAME}" from the "plugin" array manually.`);
        return false;
    }

    if (!Array.isArray(parsed.plugin) || !parsed.plugin.includes(PLUGIN_NAME)) return false;

    parsed.plugin = parsed.plugin.filter((p) => p !== PLUGIN_NAME);
    writeFileSync(configFile, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
    console.log(`  removed "${PLUGIN_NAME}" entry from ${configFile}`);
    return true;
}
