import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { PRESENCE_STATE } from "./paths.js";

const DEFAULTS = {
    presenceEnabled: true,
    daemonStopped: false,
};

const TMP_PATH = `${PRESENCE_STATE}.tmp`;

function coerce(v, fallback) {
    return typeof v === "boolean" ? v : fallback;
}

export function readState() {
    let parsed = null;
    try {
        parsed = JSON.parse(readFileSync(PRESENCE_STATE, "utf-8"));
    } catch {
        return { ...DEFAULTS, updatedAt: 0 };
    }
    if (!parsed || typeof parsed !== "object") {
        return { ...DEFAULTS, updatedAt: 0 };
    }
    return {
        presenceEnabled: coerce(parsed.presenceEnabled, DEFAULTS.presenceEnabled),
        daemonStopped: coerce(parsed.daemonStopped, DEFAULTS.daemonStopped),
        updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
    };
}

export function writeState(patch) {
    const current = readState();
    const next = {
        presenceEnabled: coerce(patch?.presenceEnabled, current.presenceEnabled),
        daemonStopped: coerce(patch?.daemonStopped, current.daemonStopped),
        updatedAt: Date.now(),
    };
    try {
        writeFileSync(TMP_PATH, JSON.stringify(next, null, 2) + "\n", "utf-8");
        renameSync(TMP_PATH, PRESENCE_STATE);
    } catch {
        try { unlinkSync(TMP_PATH); } catch {}
    }
    return next;
}

export default { readState, writeState };