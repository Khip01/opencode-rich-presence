import { existsSync, statSync, readFileSync, lstatSync, readlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { platform, version as nodeVersion, execPath } from "node:process";
import { CONFIG_PATH, OUTPUT_FILE, ACTIVITY_LOG, DEBUG_LOG, OPENCODE_DIR } from "../shared/paths.js";
import { getPlatformName } from "./platform/index.js";

const PLUGIN_NAME = "opencode-rich-presence";
// Legacy lock file path from v2.x. Phase 1 has no leader election
// but the file may still exist from older installs; report its state
// for the user's situational awareness.
const LEGACY_LOCK_FILE = join(OPENCODE_DIR, ".opencode-rich-presence.lock");
// How many recent activity-log lines to include in `info` output. The full
// log is append-only at ACTIVITY_LOG; this slice just gives the user a
// quick view of what the plugin has been doing.
const ACTIVITY_TAIL_LINES = 30;

function readJsonSafe(path) {
    try {
        return JSON.parse(readFileSync(path, "utf-8"));
    } catch { return null; }
}

function formatBytes(b) {
    if (!b) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0;
    while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
    return `${b.toFixed(1)} ${units[i]}`;
}

// Read the last `n` lines of a file without slurping the whole thing into
// memory. Used for the activity log, which can grow large over time.
function tailLines(filePath, n) {
    try {
        const raw = readFileSync(filePath, "utf-8");
        const lines = raw.split("\n");
        // Drop trailing empty line so we don't show a blank entry.
        if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
        return lines.slice(-n);
    } catch { return []; }
}

export async function info() {
    const home = homedir();
    const opencodeDir = process.env.OPENCODE_CONFIG_DIR || `${home}/.config/opencode`;
    const cfg = readJsonSafe(CONFIG_PATH);
    const lock = readJsonSafe(LEGACY_LOCK_FILE);

    const outputStat = existsSync(OUTPUT_FILE) ? statSync(OUTPUT_FILE) : null;
    const activityStat = existsSync(ACTIVITY_LOG) ? statSync(ACTIVITY_LOG) : null;
    const debugStat = existsSync(DEBUG_LOG) ? statSync(DEBUG_LOG) : null;

    const lines = [];
    lines.push("");
    lines.push("opencode-rich-presence - diagnostics");
    lines.push("=".repeat(50));
    lines.push("");
    lines.push("Environment");
    lines.push(`  Platform       : ${getPlatformName()} (${platform})`);
    lines.push(`  Node.js        : ${nodeVersion}`);
    lines.push(`  Exec           : ${execPath}`);
    lines.push("");
    lines.push("Paths");
    lines.push(`  OpenCode dir   : ${opencodeDir}`);
    lines.push(`  Config         : ${CONFIG_PATH} ${existsSync(CONFIG_PATH) ? "[exists]" : "[missing]"}`);
    lines.push(`  Default state  : ${OUTPUT_FILE} ${outputStat ? `[${formatBytes(outputStat.size)}, modified ${outputStat.mtime.toISOString()}]` : "[missing]"}`);
    lines.push(`  Activity log   : ${ACTIVITY_LOG} ${activityStat ? `[${formatBytes(activityStat.size)}, ${activityStat.size > 0 ? "tail " + ACTIVITY_TAIL_LINES + " lines below" : "empty"}]` : "[absent]"}`);
    lines.push(`  Legacy lock    : ${LEGACY_LOCK_FILE} ${lock ? "[present; v2.x artifact, ignored in Phase 1]" : "[absent]"}`);
    lines.push(`  Debug log      : ${DEBUG_LOG} ${debugStat ? `[${formatBytes(debugStat.size)}]` : "[absent]"}`);
    lines.push("");

    if (cfg) {
        const maskedId = cfg.discordAppId ? `${cfg.discordAppId.substring(0, 4)}...${cfg.discordAppId.slice(-4)}` : "(not set)";
        lines.push("Config (discord-config.json)");
        lines.push(`  App ID         : ${maskedId}`);
        lines.push(`  Image key      : ${cfg.discordLargeImageKey || "(default)"}`);
        lines.push(`  Image text     : ${cfg.discordLargeImageText || "(default)"}`);
        lines.push(`  Currency       : ${cfg.currency || "$"}`);
        lines.push(`  Custom template: ${cfg.presence ? "yes" : "no"}`);
        lines.push("");
    } else {
        lines.push("Config: not found. Run `opencode-rpc install` to create one.");
        lines.push("");
    }

    if (lock) {
        const age = Math.round((Date.now() - (lock.started || 0)) / 1000);
        lines.push("Legacy lock file (v2.x artifact; ignored in Phase 1)");
        lines.push(`  PID            : ${lock.pid}`);
        lines.push(`  Started        : ${new Date(lock.started).toISOString()}`);
        lines.push(`  Age            : ${age}s`);
        lines.push("");
    }

    const pluginLink = join(opencodeDir, "plugins", `${PLUGIN_NAME}.js`);
    let linkStat = null;
    try { linkStat = lstatSync(pluginLink); } catch {}

    lines.push("OpenCode plugin symlink");
    lines.push(`  Path           : ${pluginLink}`);
    if (linkStat) {
        const isLink = linkStat.isSymbolicLink();
        if (isLink) {
            let target = "";
            try { target = readlinkSync(pluginLink); } catch {}
            if (target) {
                lines.push(`  Linked         : yes`);
                lines.push(`  Target         : ${target}`);
            } else {
                lines.push(`  Linked         : yes (target unreadable)`);
            }
        } else {
            lines.push(`  Linked         : NO (regular file at that path, not a symlink)`);
            lines.push(`                  Run \`opencode-rpc install\` to recreate as symlink.`);
        }
    } else {
        lines.push(`  Linked         : NO. Run \`opencode-rpc install\` to create.`);
    }
    lines.push("");

    // Per-instance state files. Phase 1 writes one of these per running
    // OpenCode instance so multi-instance runs do not race on a single
    // file. Listed for the user's situational awareness.
    try {
        const { readdirSync } = await import("node:fs");
        if (existsSync(opencodeDir)) {
            const perInstance = readdirSync(opencodeDir)
                .filter((n) => n.startsWith("presence-state-pid") && n.endsWith(".txt"));
            if (perInstance.length > 0) {
                lines.push(`Per-instance state files (${perInstance.length})`);
                for (const n of perInstance.sort()) {
                    const full = join(opencodeDir, n);
                    const st = statSync(full);
                    lines.push(`  ${n}  [${formatBytes(st.size)}, modified ${st.mtime.toISOString()}]`);
                }
                lines.push("");
            }
        }
    } catch {}

    // Activity log tail. This is the most useful section for the user to
    // see what the plugin has been doing in real time. They can also
    // `tail -f` the file directly.
    if (activityStat && activityStat.size > 0) {
        lines.push(`Activity log (last ${ACTIVITY_TAIL_LINES} entries)`);
        lines.push("-".repeat(50));
        const tail = tailLines(ACTIVITY_LOG, ACTIVITY_TAIL_LINES);
        for (const l of tail) lines.push(`  ${l}`);
        lines.push("-".repeat(50));
        lines.push(`Full log: ${ACTIVITY_LOG}`);
        lines.push("");
    }

    console.log(lines.join("\n"));
}
