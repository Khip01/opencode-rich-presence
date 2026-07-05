import { appendFileSync } from "node:fs";
import { ACTIVITY_LOG, DEBUG_LOG } from "./paths.js";

const DEBUG = process.env.OPENCODE_RICH_PRESENCE_DEBUG === "true";
const TAG = "[opencode-rich-presence]";

// Append-only debug log. Mirrors the previous behavior so existing `tail -f
// /tmp/opencode-rich-presence-debug.log` workflows keep working. The
// activity log (below) carries the user-facing chronology; this log keeps
// internal debug breadcrumbs that are too noisy for the activity log
// (e.g. retry counts, internal buffer state).
export function log(...args) {
    const line = TAG + " " + args.join(" ");
    if (DEBUG) {
        try { console.log(line); } catch {}
    }
    try { appendFileSync(DEBUG_LOG, line + "\n"); } catch {}
}

// Append-only activity log entry. Format:
//
//     [2026-07-05 14:30:25.789] [pid 12345] [tag] message
//
// pid lets you grep per-instance when multiple OpenCode windows write to
// the same file (Phase 1 multi-instance design). tag is a short bracketed
// category for grep-ability. Examples:
//   [load]       plugin lifecycle
//   [config]     config resolution
//   [event]      raw SDK event received
//   [state]      session state transition
//   [session]    session metadata changed
//   [stats]      session stats (cost/tokens/context) updated
//   [display]    which session is displayed changed
//   [template]   template rendered
//   [queue]      session added/removed from local queue
//   [check]      periodic activity check
//   [push]       presence payload (Phase 1: would-push; Phase 2: actual push)
//
// We append (not rewrite) so the log is a real history. The file grows
// monotonically; the user (or a future cleanup pass) can rotate it.
export function activity(tag, message) {
    const ts = new Date().toISOString().replace("T", " ").replace("Z", "");
    const pidTag = `[pid ${process.pid}]`;
    const line = `[${ts}] ${pidTag} [${tag}] ${message}`;
    try { appendFileSync(ACTIVITY_LOG, line + "\n"); } catch {}
    // Mirror to debug log so both files stay in sync when the user is
    // debugging either way.
    try { appendFileSync(DEBUG_LOG, TAG + " " + line + "\n"); } catch {}
    if (DEBUG) {
        try { console.log(line); } catch {}
    }
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
