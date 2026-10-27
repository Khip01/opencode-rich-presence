// OpenCode V2 TUI plugin part for opencode-rich-presence.
//
// Runs inside every OpenCode client (TUI) process and touches a heartbeat
// file every few seconds. The server part (index.v2.js) reads that file's
// mtime to know whether a client window is still attached and clears the
// Discord presence shortly after the last window closes.
//
// This heartbeat exists because OpenCode gives server plugins no client
// presence signal at all: the background service (and the server part with
// it) keeps running after the last window closes, and no client disconnect
// event is emitted. When the client process dies without running cleanup
// (the normal /exit path), the touches simply stop and staleness detection
// on the server side takes over.

import { closeSync, openSync, utimesSync } from "node:fs";
import { CLIENT_HEARTBEAT } from "../shared/paths.js";

// `Plugin.define` from the `@opencode/plugin/tui` SDK is the same pure
// identity function as the server entry's; inlined for the zero-dep
// package (see the comment in index.v2.js).
const Plugin = { define(def) { return def; } };

// Comfortably below the server-side staleness timeout (30s by default):
// one delayed tick under UI load must never look like a closed window.
export const HEARTBEAT_INTERVAL_MS = 10_000;

export function beat() {
    const now = new Date();
    try {
        utimesSync(CLIENT_HEARTBEAT, now, now);
    } catch {
        // Missing file: create it empty. Only the mtime matters.
        try {
            const fd = openSync(CLIENT_HEARTBEAT, "a");
            try { closeSync(fd); } catch {}
        } catch {}
    }
}

export default Plugin.define({
    id: "opencode-rich-presence-tui",
    setup() {
        beat();
        const timer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
        // Never keep the client process alive just for the heartbeat.
        timer.unref?.();
        return () => {
            try { clearInterval(timer); } catch {}
        };
    },
});
