// Plugin states. Mirrored in session-state.js via the STATE enum. The
// plugin transitions between these in response to OpenCode SDK events.
export const STATE = {
    WORKING: "Working",
    THINKING: "Thinking",
    TYPING: "Typing",
    ASKING: "Asking",
    WAITING: "Waiting for command",
};

// Local refresh cadence. The plugin polls the OpenCode SDK every
// REFRESH_INTERVAL to catch any events the event stream missed (e.g.
// when the plugin just loaded and needs to reconcile). It is also the
// interval at which `presence-state.txt` is rewritten.
export const REFRESH_INTERVAL = 5000;
// Debounce window for presence-state.txt writes so a burst of events
// only causes one file rewrite.
export const FILE_WRITE_DEBOUNCE_MS = 250;
// Used by restoreSessionMessages to bound the SDK call so a hung server
// cannot stall plugin initialization.
export const RESTORE_TIMEOUT_MS = 5000;
// Discord presence field hard limit. Truncation runs in local-presence.
export const MAX_DISCORD_FIELD = 128;

// Developer's verified Discord App ID. Used as fallback so the plugin
// has a working default out-of-box (Phase 2 will read this to know
// which App ID the daemon should handshake with on first push).
export const FALLBACK_APP_ID = "1512803991300476989";
export const FALLBACK_IMAGE_KEY = "opencode-logo-too-opencode-rpc";

// Model context limits used when no provider data is available. Keys are
// the canonical model IDs OpenCode exposes (model field on events).
export const FALLBACK_MODEL_LIMITS = {
    "minimax-m3": 1048576,
    "minimax-m2.7": 204800,
    "minimax-m2": 204800,
    "kimi-k2.6": 262144,
    "kimi-k2.5": 262144,
    "kimi-k2": 262144,
    "nemotron-3-super-120b-a12b:free": 64000,
    "nemotron-3-nano-omni-30b-a3b-reasoning:free": 64000,
    "laguna-m.1:free": 32000,
    "deepseek-v4-flash-free": 64000,
    "owl-alpha": 32000,
    "nex-n2-pro:free": 64000,
};

// Default presence templates. Phase 1 does not push these to Discord;
// Phase 2 will use the same templates via the daemon. The user's
// discord-config.json `presence` field overrides these (see
// config-resolver.js).
export const DEFAULT_PRESENCE_TEMPLATES = {
    details: "{model} · {mode} · {prompts} prompts",
    state: "{state} · {contextPercent}% ctx",
    largeImageText: "OpenCode",
    smallImageText: "{provider}",
    byState: {
        "Waiting for command": {
            details: "{model} · idle · {elapsed}",
            state: "{prompts} prompts · {context} tok",
        },
        Working: {
            details: "{model} · Working",
            state: "{contextPercent}% ctx",
        },
        Thinking: {
            details: "{model} · Thinking",
            state: "{{#if contextPercent > 50}}Thinking · heavy{else}{contextPercent}% ctx{/if}}",
        },
        Typing: {
            details: "{model} · Typing",
            state: "{{#if contextPercent > 80}}⚠️ {contextPercent}% full{else}{contextPercent}% ctx{/if}}",
        },
        Asking: {
            details: "{model} · Permission needed",
            state: '{{#if mode == "build"}}Build access{else}Plan access{/if}}',
        },
    },
    idle: {
        details: "OpenCode · idle",
        state: "No active session",
        largeImageText: "OpenCode",
        smallImageText: "Idle",
    },
};
