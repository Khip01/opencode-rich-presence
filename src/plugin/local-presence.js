// Local presence renderer. Replaces the previous discord-service.js for Phase 1.
//
// Responsibilities:
//   1. Resolve which template set to use for the current session state
//   2. Render templates against the session variables
//   3. Log every render to the activity log so the user can see exactly
//      what WOULD be pushed to Discord (Phase 2 wires the actual push)
//   4. Expose a clean interface for index.js to call on every state change
//
// No subprocess, no Discord IPC, no leader election. Everything runs in
// the plugin process. Phase 2 introduces a daemon subprocess that owns
// the Discord connection; this module will then delegate the final push
// to the daemon via the daemon-client interface, while keeping the local
// render + log logic identical.

import { activity } from "../shared/logger.js";
import {
    truncate,
    renderTemplate,
    getTemplateVars,
    chooseTemplates,
    selectIdleTemplates,
} from "./template-engine.js";

// Render the presence payload that WOULD be pushed to Discord for the
// given session. Returns { details, state, largeImageKey, largeImageText,
// smallImageText } or null when nothing should display.
//
// Every render is logged with both the source template and the resolved
// output so the user can verify "this is what Discord would show".
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

// Phase 1: the rendered payload is logged as a "would-push" entry so the
// user can see it in the activity log. Phase 2 will replace this body with
// a daemon.send(...) call; the rest of the plugin code stays the same.
export function pushPresence(rendered) {
    if (!rendered) return;
    const details = rendered.details || "";
    const state = rendered.state || "";
    const lit = rendered.largeImageText || "";
    const sit = rendered.smallImageText || "";
    activity("push", `would-push details="${details}" state="${state}" lit="${lit}" sit="${sit}"`);
}

// Phase 1 placeholders. Phase 2 replaces with real daemon lifecycle calls.
export function startPresence() {
    activity("presence", "start (Phase 1: no Discord push)");
}

export function stopPresence() {
    activity("presence", "stop (Phase 1: no Discord push)");
}

export function getPresenceStatus() {
    return { phase: 1, connected: false };
}
