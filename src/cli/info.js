import { existsSync, statSync, readFileSync, lstatSync, readlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { platform, version as nodeVersion, execPath } from "node:process";
import { CONFIG_PATH, OUTPUT_FILE, LOCK_FILE, DEBUG_LOG } from "../shared/paths.js";
import { getPlatformName } from "./platform/index.js";

const PLUGIN_NAME = "opencode-rich-presence";

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

export async function info() {
    const home = homedir();
    const opencodeDir = process.env.OPENCODE_CONFIG_DIR || `${home}/.config/opencode`;
    const cfg = readJsonSafe(CONFIG_PATH);
    const lock = readJsonSafe(LOCK_FILE);

    const lockStat = existsSync(LOCK_FILE) ? statSync(LOCK_FILE) : null;
    const outputStat = existsSync(OUTPUT_FILE) ? statSync(OUTPUT_FILE) : null;
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
    lines.push(`  Output file    : ${OUTPUT_FILE} ${outputStat ? `[${formatBytes(outputStat.size)}, modified ${outputStat.mtime.toISOString()}]` : "[missing]"}`);
    lines.push(`  Lock file      : ${LOCK_FILE} ${lock ? "[present]" : "[absent]"}`);
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
        lines.push("Lock (leader instance)");
        lines.push(`  PID            : ${lock.pid}`);
        lines.push(`  Started        : ${new Date(lock.started).toISOString()}`);
        lines.push(`  Age            : ${age}s`);
        lines.push(lock.pid === process.pid ? "  Status         : YOU are leader" : `  Status         : another instance (pid ${lock.pid}) is leader`);
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

    console.log(lines.join("\n"));
}
