export const STATE = {
    WORKING: "Working",
    THINKING: "Thinking",
    TYPING: "Typing",
    ASKING: "Asking",
    WAITING: "Waiting for command",
};

export const HEARTBEAT_INTERVAL = 5000;
export const HEARTBEAT_TIMEOUT = 15000;
export const REFRESH_INTERVAL = 5000;
export const FILE_WRITE_DEBOUNCE_MS = 250;
export const DISCORD_DEBOUNCE_MS = 300;
export const DISCORD_CONNECT_TIMEOUT_MS = 8000;
export const DISCORD_MAX_RETRIES = 100;
export const RESTORE_TIMEOUT_MS = 5000;
export const MAX_DISCORD_FIELD = 128;

// Developer's verified Discord App ID (used as fallback so the plugin works out-of-box).
export const FALLBACK_APP_ID = "1512803991300476989";
export const FALLBACK_IMAGE_KEY = "opencode-logo-too-opencode-rpc";

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
