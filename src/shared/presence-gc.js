import { readdirSync, mkdirSync, renameSync, statSync, unlinkSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { OPENCODE_DIR, PRESENCE_STATE_DIR } from "./paths.js";
import { isPidAlive } from "./daemon-liveness.js";

const STATE_PREFIX = "presence-state-pid";
const STATE_SUFFIX = ".txt";

function stateFilesIn(dir) {
    let names;
    try {
        names = readdirSync(dir);
    } catch {
        return [];
    }
    return names.filter((n) => n.startsWith(STATE_PREFIX) && n.endsWith(STATE_SUFFIX));
}

export function ensureStateDir() {
    mkdirSync(PRESENCE_STATE_DIR, { recursive: true });
}

// One-shot migration of the pre-3.4 layout, where per-instance state
// files sat directly in OPENCODE_DIR and buried the real config files
// under hundreds of entries. Idempotent: a second call finds nothing to
// move. A name collision (same PID reusing a slot before GC ran) always
// takes the copy from the config root: that is the live writer's file,
// while anything already sitting in the subdir is stale residue from a
// dead instance. Deterministic by construction, so it does not depend on
// sub-millisecond mtime resolution.
export function migrateLegacyStates() {
    ensureStateDir();
    const moved = [];
    for (const name of stateFilesIn(OPENCODE_DIR)) {
        const src = join(OPENCODE_DIR, name);
        const dst = join(PRESENCE_STATE_DIR, name);
        try {
            if (existsSync(dst)) unlinkSync(dst);
        } catch {}
        try {
            renameSync(src, dst);
            moved.push(name);
        } catch {}
    }
    return moved;
}

function pidOf(fileName) {
    const raw = fileName.slice(STATE_PREFIX.length, -STATE_SUFFIX.length);
    const pid = parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
}

// Drop state snapshots nobody can be reading any more. Two independent
// reasons, either sufficient:
//   - the PID it was written by is gone, so no process owns the file
//   - it is older than maxAgeHours, which catches PIDs recycled onto an
//     unrelated long-lived process (isPidAlive would say "alive")
// Then cap the survivors at maxFiles newest by mtime, so a pathological
// burst of OpenCode instances cannot grow the directory without bound.
export function gcPresenceStates({ maxFiles = 20, maxAgeHours = 72 } = {}) {
    ensureStateDir();
    const now = Date.now();
    const maxAgeMs = maxAgeHours * 3600 * 1000;
    const removed = [];

    const entries = [];
    for (const name of stateFilesIn(PRESENCE_STATE_DIR)) {
        const path = join(PRESENCE_STATE_DIR, name);
        let st;
        try {
            st = statSync(path);
        } catch {
            continue;
        }
        if (!st.isFile()) continue;
        entries.push({ name, path, mtimeMs: st.mtimeMs });
    }

    const survivors = [];
    for (const e of entries) {
        const pid = pidOf(e.name);
        // Only a clearly-dead PID justifies deletion here. A name whose
        // PID cannot be parsed is left alone by the liveness pass and
        // falls through to the age check below, so malformed or exotic
        // filenames are never destroyed on a guess.
        if (pid !== null && !isPidAlive(pid)) {
            try {
                unlinkSync(e.path);
                removed.push(e.name);
            } catch {}
            continue;
        }
        if (now - e.mtimeMs > maxAgeMs) {
            try {
                unlinkSync(e.path);
                removed.push(e.name);
            } catch {}
            continue;
        }
        survivors.push(e);
    }

    survivors.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const e of survivors.slice(maxFiles)) {
        try {
            unlinkSync(e.path);
            removed.push(e.name);
        } catch {}
    }

    return removed;
}

export function stateFilePathFor(pid) {
    return join(PRESENCE_STATE_DIR, `${STATE_PREFIX}${pid}${STATE_SUFFIX}`);
}

export { STATE_PREFIX, STATE_SUFFIX };