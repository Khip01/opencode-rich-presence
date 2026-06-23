import { readFile } from "node:fs/promises";
import { CONFIG_PATH } from "../shared/paths.js";
import { DEFAULT_PRESENCE_TEMPLATES, STATE, FALLBACK_APP_ID, FALLBACK_IMAGE_KEY } from "../shared/constants.js";
import { log } from "../shared/logger.js";

function resolveEnvConfig() {
    return {
        appId: process.env.DISCORD_APP_ID || null,
        largeImageKey: process.env.DISCORD_LARGE_IMAGE_KEY || null,
        largeImageText: process.env.DISCORD_LARGE_IMAGE_TEXT || "OpenCode",
    };
}

function mergeTemplates(userTmpl, defaults) {
    if (!userTmpl || typeof userTmpl !== "object") return defaults;
    const out = { ...defaults };
    if (userTmpl.details !== undefined) out.details = String(userTmpl.details);
    if (userTmpl.state !== undefined) out.state = String(userTmpl.state);
    if (userTmpl.largeImageText !== undefined) out.largeImageText = String(userTmpl.largeImageText);
    if (userTmpl.smallImageText !== undefined) out.smallImageText = String(userTmpl.smallImageText);
    if (userTmpl.idle && typeof userTmpl.idle === "object") {
        out.idle = { ...defaults.idle, ...userTmpl.idle };
    }
    if (userTmpl.byState && typeof userTmpl.byState === "object") {
        out.byState = {};
        for (const s of Object.values(STATE)) {
            const u = userTmpl.byState[s];
            const d = defaults.byState[s];
            out.byState[s] = u && typeof u === "object" ? { ...(d || {}), ...u } : d;
        }
    }
    return out;
}

export async function loadConfig() {
    const envCfg = resolveEnvConfig();
    let fileCfg = {};

    try {
        const raw = await readFile(CONFIG_PATH, "utf-8");
        fileCfg = JSON.parse(raw);
    } catch {}

    const id = envCfg.appId || fileCfg.discordAppId || null;
    const key = envCfg.largeImageKey || fileCfg.discordLargeImageKey || null;
    const text = envCfg.largeImageText || fileCfg.discordLargeImageText || "OpenCode";
    const userTmpl = fileCfg.presence || null;
    const templates = mergeTemplates(userTmpl, DEFAULT_PRESENCE_TEMPLATES);
    const currency = fileCfg.currency || "$";

    // Priority: env > config file > fallback (developer's verified App ID for out-of-box use).
    const finalAppId = id || fileCfg.discordAppId || FALLBACK_APP_ID;
    const finalKey = key || fileCfg.discordLargeImageKey || FALLBACK_IMAGE_KEY;

    log(`Config: appId=${finalAppId} key=${finalKey} currency=${currency}`);

    return {
        appId: finalAppId,
        largeImageKey: finalKey,
        largeImageText: text,
        currency,
        templates,
    };
}
