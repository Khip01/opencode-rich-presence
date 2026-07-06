// Local presence renderer + daemon client wrapper.
//
// Phase 2 architecture:
//   1. Plugin renders presence payload locally (uses template engine)
//   2. Plugin sends the RENDERED payload + session metadata to daemon
//   3. Daemon picks the global most-recently-active rendered payload
//      across all connected OpenCode instances
//   4. Daemon pushes the picked payload to Discord via the single
//      persistent IPC connection it holds
//
// Why the plugin renders, not the daemon:
//   - JSON serialization over the local socket loses class methods
//     and getters on the SessionState. If the daemon received the
//     raw session object, getTemplateVars() would break on the
//     deserialized object (cost/contextTokens getters are gone).
//   - The plugin already renders the payload for the activity log,
//     so doing it once and shipping the rendered result is natural.
//   - The daemon stays simple: it picks a payload, pushes it. No
//     template knowledge, no config knowledge (the plugin sends its
//     own config-derived render).

import { activity } from "../shared/logger.js";
import {
    truncate,
    renderTemplate,
    getTemplateVars,
    chooseTemplates,
    selectIdleTemplates,
} from "./template-engine.js";
import { DaemonClient } from "./daemon-client.js";

// Render the presence payload that the daemon WILL push to Discord
// for the given session. Returns { details, state, largeImageKey,
// largeImageText, smallImageText } or null when nothing should
// display.
//
// Every render is logged with both the source template and the
// resolved output so the user can verify what we sent to the daemon.
export function renderPresence(session, config) {
    if (!config) return null;
    const isIdle = !session || session.state === "Waiting for command";
    const tmpls = isIdle
        ? selectIdleTemplates(config.templates)
        : chooseTemplates(config.templates, session?.state);

    const vars = getTemplateVars(session);
    const sid = session?.sessionID ? session.sessionID.slice(-8) : "?";

    const detailsSrc = tmpls.details ?? "";
    const stateSrc = tmpls.state ?? "";
    const litSrc = tmpls.largeImageText ?? "OpenCode";
    const sitSrc = tmpls.smallImageText ?? "";

    const details = truncate(renderTemplate(detailsSrc, vars), 128);
    const state = truncate(renderTemplate(stateSrc, vars), 128);
    const largeImageText = truncate(renderTemplate(litSrc, vars), 128);
    const smallImageText = sitSrc ? truncate(renderTemplate(sitSrc, vars), 128) : undefined;

    activity(
        "template",
        `sid=${sid} ` +
        `details="${detailsSrc}" -> "${details}" ` +
        `state="${stateSrc}" -> "${state}"`,
    );

    return {
        details,
        state,
        largeImageKey: config.largeImageKey,
        largeImageText,
        smallImageText,
    };
}

// Phase 2: log the would-push payload for the activity log. The
// actual send to the daemon is in `sendStateToDaemon` below.
export function pushPresence(rendered) {
    if (!rendered) return;
    activity(
        "push",
        `would-push details="${rendered.details || ""}" state="${rendered.state || ""}"`,
    );
}

// ─── Daemon lifecycle ─────────────────────────────────────────────────────

let daemonClient = null;
let _connected = false;

export function getDaemonClient() {
    if (!daemonClient) daemonClient = new DaemonClient({ timeoutMs: 2000 });
    return daemonClient;
}

// Try to connect to the daemon. Returns true on success, false if no
// daemon is running or connect failed. The plugin uses this after
// spawning the daemon (or whenever it loses the connection).
export async function ensureConnected() {
    const c = getDaemonClient();
    if (c.isConnected()) return true;
    const ok = await c.connect(process.pid);
    _connected = ok;
    if (ok) activity("daemon", "connected to daemon");
    else activity("daemon", `connect failed: ${c.lastError || "no daemon"}`);
    return ok;
}

// Send the rendered payload + minimal session metadata to the daemon.
// The daemon uses lastActivity + isActive to pick the global winner.
// We do NOT send the raw session because JSON serialization loses
// the getter methods that the template engine depends on.
export function sendStateToDaemon(session, rendered) {
    const c = getDaemonClient();
    if (!c.isConnected()) return false;
    const minimalSession = session ? {
        sessionID: session.sessionID,
        state: session.state,
        lastActivity: session.lastActivity,
    } : null;
    const ok = c.sendState(process.pid, minimalSession, rendered);
    if (ok) {
        activity("push", "sent rendered payload to daemon");
    } else {
        activity("push", `failed to send: ${c.lastError || "not connected"}`);
    }
    return ok;
}

export function disconnectFromDaemon() {
    if (!daemonClient) return;
    try {
        daemonClient.sendGoodbye(process.pid);
    } catch {}
    daemonClient.disconnect();
    _connected = false;
    activity("daemon", "disconnected");
}

export function startPresence() {
    activity("presence", "start (Phase 2: daemon-based push)");
}

export function stopPresence() {
    activity("presence", "stop (Phase 2: daemon-based push)");
    disconnectFromDaemon();
}

export function getPresenceStatus() {
    return {
        phase: 2,
        connected: _connected,
    };
}
