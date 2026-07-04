export const STATE = {
    WORKING: "Working",
    THINKING: "Thinking",
    TYPING: "Typing",
    ASKING: "Asking",
    WAITING: "Waiting for command",
};

export const HEARTBEAT_INTERVAL = 2000;
export const HEARTBEAT_TIMEOUT = 15000;
// Standby instances poll at this interval to check whether the leader has
// released the lock (either due to a handoff request or because the leader
// exited). Also used for the lock-stale takeover path. v2.0.8-rc2 reduced
// this from 2000 to 1000 so the active standby acquires the lock faster.
export const HANDOFF_CHECK_INTERVAL = 1000;
// For a short window after the standby requested handoff (or marked active),
// it polls at this faster interval so it acquires the lock almost as soon as
// the leader releases. Reduces handoff latency from ~5s to ~1-2s.
export const ACTIVE_HANDSHAKE_INTERVAL = 250;
// How long the standby keeps using the fast-poll interval after its last
// activity before falling back to the slow HANDOFF_CHECK_INTERVAL.
export const FAST_POLL_WINDOW_MS = 8000;
// Right after becoming leader, the instance ignores handoff signals for this
// long. Without it, all instances see the same SDK events and ping-pong
// leadership back and forth. v2.0.8-rc2 dropped this from 8s to 3s because
// the longer cooldown made the new leader's worker take too long to connect,
// and the only events that now request handoff are user-initiated
// (chat.message, permission events), so the cooldown window is mostly there
// to debounce rapid chat bursts from the same user.
export const LEADER_COOLDOWN_MS = 3000;
export const REFRESH_INTERVAL = 5000;
export const FILE_WRITE_DEBOUNCE_MS = 250;
export const DISCORD_DEBOUNCE_MS = 300;
export const DISCORD_CONNECT_TIMEOUT_MS = 8000;
export const DISCORD_MAX_RETRIES = 100;
export const RESTORE_TIMEOUT_MS = 5000;
export const MAX_DISCORD_FIELD = 128;

// v2.1.2: self-healing worker. If the leader's worker has been failing to
// connect for this long, the plugin kills it and spawns a fresh one. Without
// this, a worker stuck in its retry loop (e.g. Discord IPC socket stale after
// the previous leader exited or the system rebooted) holds the leader slot
// but never pushes presence, and the user has to run `opencode-rpc restart`
// manually. The threshold is conservative — long enough that a normal slow
// first connect (cold start, large Discord install) is not interrupted, short
// enough that the user is not left staring at an empty display for minutes.
export const STALE_WORKER_THRESHOLD_MS = 15000;
// v2.1.2: how often the leader checks for a stale worker. Runs inside the
// existing heartbeat interval so we do not add another timer.
export const STALE_CHECK_INTERVAL_MS = 3000;

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
