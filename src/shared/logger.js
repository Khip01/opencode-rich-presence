import { appendFileSync } from "node:fs";
import { DEBUG_LOG } from "./paths.js";

const DEBUG = process.env.OPENCODE_RICH_PRESENCE_DEBUG === "true";
const TAG = "[opencode-rich-presence]";

export function log(...args) {
    const line = TAG + " " + args.join(" ");
    if (DEBUG) {
        try { console.log(line); } catch {}
    }
    try { appendFileSync(DEBUG_LOG, line + "\n"); } catch {}
}

export function debug(...args) {
    if (DEBUG) log("[debug]", ...args);
}

export function warn(...args) {
    log("[warn]", ...args);
}

export function error(...args) {
    log("[error]", ...args);
}
