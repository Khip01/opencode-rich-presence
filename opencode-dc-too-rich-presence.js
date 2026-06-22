import { writeFile, readFile, mkdir, unlink } from "node:fs/promises";
import { existsSync, accessSync, unlinkSync, constants, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { spawn } from "node:child_process";

// ─── Constants ─────────────────────────────────────────────────────────────

const CONFIG_PATH = join(homedir(), ".config", "opencode", "discord-config.json");
const OUTPUT_FILE = join(homedir(), ".config", "opencode", "presence-state.txt");
const RESTART_SIGNAL = join(homedir(), ".config", "opencode", ".discord-restart-request");
const LOCK_FILE = join(homedir(), ".config", "opencode", ".opencode-dc-too-rich-presence.lock");
const HEARTBEAT_INTERVAL = 5000;
const HEARTBEAT_TIMEOUT = 15000;
const REFRESH_INTERVAL = 5000;
const FILE_WRITE_DEBOUNCE_MS = 250;
const DISCORD_DEBOUNCE_MS = 300;
const DISCORD_CONNECT_TIMEOUT_MS = 8000;
const DISCORD_MAX_RETRIES = 100;
const RESTORE_TIMEOUT_MS = 5000;
const MAX_DISCORD_FIELD = 128;

const STATE = {
    WORKING: "Working",
    THINKING: "Thinking",
    TYPING: "Typing",
    ASKING: "Asking",
    WAITING: "Waiting for command",
};

const FALLBACK_MODEL_LIMITS = {
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

const DEFAULT_PRESENCE_TEMPLATES = {
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
            state: "{{#if mode == \"build\"}}Build access{else}Plan access{/if}}",
        },
    },
    idle: {
        details: "OpenCode · idle",
        state: "No active session",
        largeImageText: "OpenCode",
        smallImageText: "Idle",
    },
};

const DEBUG = process.env.OPENCODE_DC_TOO_RICH_DEBUG === "true";
const DEBUG_LOG = "/tmp/plugin-debug.log";

function log(...args) {
    const line = "[opencode-dc-too-rich-presence] " + args.join(" ");
    if (DEBUG) console.log(line);
    try { appendFileSync(DEBUG_LOG, line + "\n"); } catch {}
}

// ─── Config & Template Resolution ─────────────────────────────────────────

function resolveConfig() {
    const id = process.env.DISCORD_APP_ID;
    const asset = process.env.DISCORD_LARGE_IMAGE_KEY;
    const assetText = process.env.DISCORD_LARGE_IMAGE_TEXT || "OpenCode";
    return {
        appId: id || null,
        largeImageKey: asset || null,
        largeImageText: assetText || "OpenCode",
        templates: null,
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

async function loadConfig() {
    const envCfg = resolveConfig();
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

    // appId: env var > config file > developer's fallback.
    // The developer's App ID (1512803991300476989) is verified and allows out-of-box use.
    const FALLBACK_APP_ID = "1512803991300476989";
    const finalAppId = id || (fileCfg.discordAppId) || FALLBACK_APP_ID;
    const finalKey = key || (fileCfg.discordLargeImageKey) || "opencode-logo-too-rich-presence";

    if (finalAppId === "NOT_CONFIGURED") {
        log(`Config: appId=${finalAppId} key=${finalKey} currency=${currency}`);
    }

    return {
        appId: finalAppId,
        largeImageKey: finalKey,
        largeImageText: text,
        currency,
        templates,
    };
}

// ─── Number Formatting Helpers ────────────────────────────────────────────

function compactNumber(value) {
    const num = parseFloat(value);
    if (isNaN(num)) return String(value);
    if (Math.abs(num) < 1000) return Math.round(num).toLocaleString();

    // Calculate in K, check if after rounding it would be >= 1000K (= 1M)
    let k = Math.round((num / 1000) * 10) / 10;
    if (k >= 1000) {
        // Switch to M format
        let m = Math.round((num / 1_000_000) * 10) / 10;
        if (m >= 1000) {
            // Switch to B
            let b = Math.round((num / 1_000_000_000) * 10) / 10;
            return Number.isInteger(b) ? `${b}B` : `${b.toFixed(1)}B`;
        }
        return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
    }
    return Number.isInteger(k) ? `${k}K` : `${k.toFixed(1)}K`;
}

function formatCompactCurrency(value, currency = "$") {
    const num = parseFloat(value);
    if (isNaN(num) || num === 0) return `${currency}0 ∞`;
    if (num < 0.01) return `<${currency}0.01`;
    if (num < 1000) return `${currency}${num.toFixed(2)}`;

    let k = Math.round((num / 1000) * 10) / 10;
    if (k >= 1000) {
        let m = Math.round((num / 1_000_000) * 10) / 10;
        return Number.isInteger(m) ? `${currency}${m}M` : `${currency}${m.toFixed(1)}M`;
    }
    return Number.isInteger(k) ? `${currency}${k}K` : `${currency}${k.toFixed(1)}K`;
}

// ─── Template Engine ──────────────────────────────────────────────────────

function getTemplateVars(session, displayed) {
    const s = session || {};
    const currency = config.currency || "$";
    const d = {
        id: s.sessionID ? s.sessionID.substring(s.sessionID.length - 12) : "?",
        sessionId: s.sessionID || "?",
        provider: s.provider || "?",
        model: s.model || "?",
        mode: s.mode || "?",
        state: s.state || STATE.WAITING,
        elapsed: s.startedAt ? formatDuration(Date.now() - s.startedAt) : "?",
        contextPercent: s.modelLimit ? ((s.contextTokens / s.modelLimit) * 100).toFixed(1) : "0.0",
        context: s.contextTokens ? s.contextTokens.toLocaleString() : "0",
        contextFull: s.totalTokens ? s.totalTokens.toLocaleString() : "0",
        contextCompact: compactNumber(s.contextTokens || 0),
        contextFullCompact: compactNumber(s.totalTokens || 0),
        contextLimit: s.modelLimit ? s.modelLimit.toLocaleString() : "?",
        contextLimitCompact: compactNumber(s.modelLimit || 0),
        cost: typeof s.cost === "number" ? (s.cost === 0 ? "free" : `${currency}${s.cost.toFixed(4)}`) : `${currency}0`,
        costCompact: formatCompactCurrency(s.cost, currency),
        prompts: s.promptCount ?? 0,
        promptsCompact: compactNumber(s.promptCount ?? 0),
        idle: s.state === STATE.WAITING ? "true" : "false",
        thinking: s.state === STATE.THINKING ? "true" : "false",
        typing: s.state === STATE.TYPING ? "true" : "false",
        waiting: s.state === STATE.WAITING ? "true" : "false",
        working: s.state === STATE.WORKING ? "true" : "false",
        asking: s.state === STATE.ASKING ? "true" : "false",
        active: s.state !== STATE.WAITING ? "true" : "false",
    };
    const p = displayed || {};
    p.id = p.sessionID ? p.sessionID.substring(p.sessionID.length - 12) : "?";
    return { ...d, ...p };
}

function renderTemplate(template, vars) {
    if (!template) return "";
    let r = String(template);

    // 1. Conditional with comparison: {{#if var op "value" or value}}tb{{else}}fb{{/if}}
    //    Quote is optional. Value can be quoted string OR bare number/word.
    const condRegex = /\{\{#if\s+(\w+)\s*(==|!=|>=|<=|>|<)\s*(?:"([^"]*)"|(\S+?))\s*\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g;
    r = r.replace(condRegex, (_, vn, op, qv, bv, tb, fb) => {
        const v = String(vars[vn] ?? "");
        const val = qv !== undefined ? qv : bv;
        let met = false;
        const n = parseFloat(v);
        const n2 = parseFloat(val);
        if (op === "==") met = v === val;
        else if (op === "!=") met = v !== val;
        else if (op === ">") met = !isNaN(n) && !isNaN(n2) && n > n2;
        else if (op === ">=") met = !isNaN(n) && !isNaN(n2) && n >= n2;
        else if (op === "<") met = !isNaN(n) && !isNaN(n2) && n < n2;
        else if (op === "<=") met = !isNaN(n) && !isNaN(n2) && n <= n2;
        return met ? (tb || "") : (fb || "");
    });

    // 2. Boolean conditional: {{#if var}}tb{{else}}fb{{/if}}
    const boolCondRegex = /\{\{#if\s+(\w+)\s*\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g;
    r = r.replace(boolCondRegex, (_, vn, tb, fb) => {
        const v = String(vars[vn] ?? "");
        const met = v === "true" || v === "1" || v === "yes";
        return met ? (tb || "") : (fb || "");
    });

    // 3. Variable substitution: {var} or {var|fallback}
    //    Negative lookbehind (?<!\{) prevents matching inside {{ (which is a conditional marker)
    //    \}?\} optional: matches {var}, {var}} (typo), or even {var (missing })
    const varRegex = /(?<!\{)\{(\w+)(?:\|([^}]*))?\}?\}?/g;
    r = r.replace(varRegex, (_, vn, fb) => {
        if (vars[vn] !== undefined && vars[vn] !== null) return String(vars[vn]);
        return fb !== undefined ? fb : "?";
    });

    return r;
}

function chooseTemplates(templates, state) {
    if (!templates) return DEFAULT_PRESENCE_TEMPLATES;
    const st = templates.byState && state ? templates.byState[state] : null;
    if (st) {
        return {
            details: st.details ?? templates.details,
            state: st.state ?? templates.state,
            largeImageText: st.largeImageText ?? templates.largeImageText ?? "OpenCode",
            smallImageText: st.smallImageText ?? templates.smallImageText ?? "",
        };
    }
    return templates;
}

function selectIdleTemplates(templates) {
    if (templates?.idle && typeof templates.idle === "object") return templates.idle;
    return { details: "OpenCode · idle", state: "No active session", largeImageText: "OpenCode", smallImageText: "Idle" };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function truncate(s, max) {
    if (!s) return s;
    return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function formatDuration(ms) {
    const sec = Math.floor(ms / 1000);
    const min = Math.floor(sec / 60);
    const hr = Math.floor(min / 60);
    if (hr > 0) return `${hr}h ${min % 60}m`;
    if (min > 0) return `${min}m ${sec % 60}s`;
    return `${sec}s`;
}

function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms).unref?.()),
    ]);
}

function findNodeExecutable() {
    const ep = process.execPath || "";
    const bn = ep.split("/").pop() || "";
    if (["node", "node.exe", "bun", "bun.exe"].includes(bn)) return ep;
    const home = homedir();
    const ver = process.versions?.node || "";
    for (const p of [ver ? `${home}/.nvm/versions/node/v${ver}/bin/node` : null, "/usr/bin/node", "/usr/local/bin/node", "/opt/homebrew/bin/node"].filter(Boolean)) {
        try { accessSync(p, constants.X_OK); return p; } catch {}
    }
    return "node";
}

const NODE_EXECUTABLE = findNodeExecutable();

// ─── Instance Coordinator ───────────────────────────────────────────────
// Discord IPC only allows ONE active connection per Application ID.
// When multiple OpenCode instances run, only one should push to Discord.
// We use a file-based lock with heartbeat to elect a "leader" instance.

let isLeader = false;
let heartbeatTimer = null;
let myPid = process.pid;

async function tryAcquireLock() {
    const now = Date.now();
    const payload = JSON.stringify({ pid: myPid, started: now });
    
    try {
        // Try exclusive create
        await writeFile(LOCK_FILE, payload, { flag: "wx" });
        isLeader = true;
        log(`✓ Acquired leader lock (pid ${myPid})`);
        return true;
    } catch (e) {
        if (e.code !== "EEXIST") {
            log(`Lock acquire error: ${e.message}`);
            return false;
        }
    }
    
    // Lock exists - check if owner is alive
    try {
        const content = await readFile(LOCK_FILE, "utf-8");
        const lock = JSON.parse(content);
        const age = Date.now() - (lock.started || 0);
        
        // If lock is fresh, owner is alive - we are not leader
        if (age < HEARTBEAT_TIMEOUT && lock.pid !== myPid) {
            log(`Another instance is leader (pid ${lock.pid}, ${Math.round(age/1000)}s old)`);
            return false;
        }
        
        // Lock is stale or it's our own stale lock - try to steal
        log(`Lock is stale (${Math.round(age/1000)}s old, owner pid ${lock.pid}), stealing...`);
        await unlink(LOCK_FILE).catch(() => {});
        return await tryAcquireLock();
    } catch (e) {
        // File unreadable, try again
        log(`Lock read error: ${e.message}, retrying...`);
        return false;
    }
}

async function heartbeatLoop() {
    if (!isLeader) return;
    try {
        await writeFile(LOCK_FILE, JSON.stringify({ pid: myPid, started: Date.now() }), "utf-8");
    } catch (e) {
        log(`Heartbeat failed: ${e.message}`);
    }
}

function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(heartbeatLoop, HEARTBEAT_INTERVAL);
    heartbeatTimer.unref?.();
}

async function releaseLock() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    if (!isLeader) return;
    try { await unlink(LOCK_FILE); log("Released leader lock"); } catch {}
    isLeader = false;
}

// ─── Global State ─────────────────────────────────────────────────────────

const sessions = new Map();
const queue = [];
let displayedSessionID = null;
const providerModels = new Map();
let writeTimer = null;
let config = { appId: "1512803991300476989", largeImageKey: "opencode-logo-too-rich-presence", largeImageText: "OpenCode", templates: DEFAULT_PRESENCE_TEMPLATES };

// ─── Discord RPC Service (Subprocess Worker) ─────────────────────────────

const discord = { workerProcess: null, connected: false, disposed: false, respawning: false, pendingActivity: null, lastError: null, lastAttemptAt: null, retryCount: 0, pushTimer: null, stdoutBuf: "", _respCallbacks: new Map(), _nonce: 1 };

function spawnWorker() {
    if (discord.workerProcess) return;
    if (discord.respawning) return;  // Intentional restart in progress (waiting for IPC release)
    const wp = join(homedir(), ".config", "opencode", "discord-worker.mjs");
    log(`Spawn worker: ${wp} (${NODE_EXECUTABLE})`);

    try {
        const workerEnv = { ...process.env };
        if (config.appId && config.appId !== "NOT_CONFIGURED") {
            workerEnv.DISCORD_APP_ID = config.appId;
        } else {
            delete workerEnv.DISCORD_APP_ID;
        }
        discord.workerProcess = spawn(NODE_EXECUTABLE, [wp], {
            stdio: ["pipe", "pipe", "pipe"],
            env: workerEnv,
            detached: false,
        });
        discord.workerProcess.stdout.setEncoding("utf-8");
        discord.workerProcess.stdout.on("data", (c) => { discord.stdoutBuf += c; let i, l; while ((i = discord.stdoutBuf.indexOf("\n")) !== -1) { l = discord.stdoutBuf.slice(0, i).trim(); discord.stdoutBuf = discord.stdoutBuf.slice(i + 1); if (!l) continue; try { const m = JSON.parse(l); handleWorkerMsg(m); } catch {} } });
        discord.workerProcess.stderr.setEncoding("utf-8");
        discord.workerProcess.stderr.on("data", (c) => log("[worker stderr]", c.trim()));
        discord.workerProcess.on("exit", (code, sig) => {
            log(`Worker exited: code=${code} sig=${sig}`);
            discord.workerProcess = null;
            discord.connected = false;
            discord.lastError = `Worker exited (code=${code})`;
            if (discord.disposed) return;

            // Check if restart was intentional (via restart-discord.sh)
            let isIntentionalRestart = false;
            try {
                if (existsSync(RESTART_SIGNAL)) {
                    isIntentionalRestart = true;
                    unlinkSync(RESTART_SIGNAL);
                    log("Restart signal detected - will wait 2s for IPC socket to release");
                }
            } catch {}

            // Reload config on intentional restart to pick up any changes.
            // Wait 2s for old worker's Discord IPC socket to FULLY RELEASE before
            // spawning a new one. Without this delay, the new worker's connect()
            // races with the stale IPC socket and fails (brief blink, then disconnect).
            if (isIntentionalRestart) {
                discord.retryCount = 0;
                discord.lastError = null;
                discord.respawning = true;
                setTimeout(() => {
                    discord.respawning = false;
                    loadConfig().then((c) => {
                        config = c;
                        log(`Reloaded config: appId=${c.appId}`);
                        spawnWorker();
                    }).catch((err) => {
                        log(`Config reload failed: ${err?.message || err}`);
                        if (!discord.disposed && !discord.workerProcess) spawnWorker();
                    });
                }, 2000).unref?.();
            } else {
                // Normal crash - use exponential backoff
                setTimeout(() => { if (!discord.disposed && !discord.workerProcess) spawnWorker(); }, 3000).unref?.();
            }
        });
        discord.workerProcess.on("error", (e) => { discord.lastError = e.message; log(`Worker error: ${e.message}`); });
    } catch (e) { discord.lastError = e.message; log(`Spawn failed: ${e.message}`); }
}

function handleWorkerMsg(msg) {
    if (msg.type === "connected") { discord.connected = true; discord.retryCount = 0; discord.lastError = null; log("Discord connected via worker"); if (discord.pendingActivity) sendCmd({ cmd: "setActivity", activity: discord.pendingActivity }); }
    else if (msg.type === "disconnected") { discord.connected = false; }
    else if (msg.type === "error") { discord.lastError = msg.error; }
    else if (msg.type === "attempt") { discord.lastAttemptAt = Date.now(); discord.retryCount = msg.retryCount ?? 0; }
}

function sendCmd(cmd) {
    if (!discord.workerProcess?.stdin?.writable) return false;
    try { discord.workerProcess.stdin.write(JSON.stringify(cmd) + "\n"); return true; } catch { return false; }
}

function discordConnect() {
    if (discord.disposed) return;
    discord.lastAttemptAt = Date.now();
    if (!discord.workerProcess) spawnWorker();
    sendCmd({ cmd: "connect" });
}

function discordPush(state) {
    if (discord.disposed) return;
    if (!isLeader) return; // Only leader pushes to Discord
    const isIdle = !state || state.state === STATE.WAITING;
    const tmpls = isIdle ? selectIdleTemplates(config.templates) : chooseTemplates(config.templates, state?.state);
    const vars = getTemplateVars(state);
    discord.pendingActivity = {
        details: truncate(renderTemplate(tmpls.details, vars), MAX_DISCORD_FIELD),
        state: truncate(renderTemplate(tmpls.state, vars), MAX_DISCORD_FIELD),
        largeImageKey: config.largeImageKey,
        largeImageText: truncate(renderTemplate(tmpls.largeImageText ?? "OpenCode", vars), MAX_DISCORD_FIELD),
        smallImageKey: undefined,
        smallImageText: tmpls.smallImageText ? truncate(renderTemplate(tmpls.smallImageText, vars), MAX_DISCORD_FIELD) : undefined,
    };
    if (!discord.connected) { discordConnect(); return; }
    if (discord.pushTimer) return;
    discord.pushTimer = setTimeout(() => {
        discord.pushTimer = null;
        if (discord.connected && discord.pendingActivity) sendCmd({ cmd: "setActivity", activity: discord.pendingActivity });
    }, DISCORD_DEBOUNCE_MS);
    discord.pushTimer.unref?.();
}

async function discordDestroy() {
    discord.disposed = true;
    if (discord.pushTimer) { clearTimeout(discord.pushTimer); discord.pushTimer = null; }
    if (discord.workerProcess) {
        sendCmd({ cmd: "shutdown" });
        await new Promise(r => setTimeout(r, 200));
        try { discord.workerProcess.kill("SIGTERM"); } catch {}
        await new Promise(r => setTimeout(r, 500));
        try { discord.workerProcess.kill("SIGKILL"); } catch {}
        discord.workerProcess = null;
    }
}

// ─── Session State ────────────────────────────────────────────────────────

class SessionState {
    constructor(sid) {
        this.sessionID = sid;
        this.agent = "unknown";
        this.model = "unknown";
        this.provider = "unknown";
        this.mode = "unknown";
        this.state = STATE.WAITING;
        this.startedAt = Date.now();
        this.lastActivity = Date.now();
        this.promptCount = 0;
        this.modelLimit = null;
        this._cost = 0;
        this._tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
        this._messageMap = new Map();
        this._latestMessageID = null;
        this._latestMessageTime = 0;
        this._latestContextTokens = 0;
    }

    get cost() { return this._cost; }
    get totalTokens() {
        const t = this._tokens;
        return t.input + t.output + t.reasoning + t.cache.read + t.cache.write;
    }
    get contextTokens() { return this._latestContextTokens; }
    get contextPercent() {
        return this.modelLimit && this.modelLimit > 0 ? (this.contextTokens / this.modelLimit) * 100 : 0;
    }

    isActive() { return this.state !== STATE.WAITING; }

    addOrUpdateMessage(mid, cost, tokens, modelID, providerID, completedAt, createdAt) {
        if (!mid) return;
        const ex = this._messageMap.get(mid);
        if (ex) {
            this._cost -= ex.cost;
            this._tokens.input -= ex.tok.input;
            this._tokens.output -= ex.tok.output;
            this._tokens.reasoning -= ex.tok.reasoning;
            this._tokens.cache.read -= ex.tok.cache.read;
            this._tokens.cache.write -= ex.tok.cache.write;
        }
        const nc = cost || 0;
        const nt = tokens || {};
        this._messageMap.set(mid, { cost: nc, tok: { input: nt.input || 0, output: nt.output || 0, reasoning: nt.reasoning || 0, cache: { read: nt.cache?.read || 0, write: nt.cache?.write || 0 } } });
        this._cost += nc;
        this._tokens.input += nt.input || 0;
        this._tokens.output += nt.output || 0;
        this._tokens.reasoning += nt.reasoning || 0;
        this._tokens.cache.read += nt.cache?.read || 0;
        this._tokens.cache.write += nt.cache?.write || 0;

        const sortT = completedAt || createdAt || 0;
        const ctxT = (nt.input || 0) + (nt.cache?.read || 0);
        const isCur = this._latestMessageID === mid;
        const isNew = sortT >= this._latestMessageTime;

        if (isCur) {
            this._latestMessageTime = sortT;
            this._latestContextTokens = ctxT;
        } else if (isNew && (ctxT > 0 || !this._latestMessageID)) {
            this._latestMessageTime = sortT;
            this._latestMessageID = mid;
            if (ctxT > 0) this._latestContextTokens = ctxT;
        }
        if (modelID) this.model = modelID;
        if (providerID) this.provider = providerID;
    }
}

// ─── File Output ──────────────────────────────────────────────────────────

function scheduleWrite() {
    const d = displayedSessionID ? sessions.get(displayedSessionID) : null;
    discordPush(d);
    // Only leader writes to the output file (so file = Discord state)
    // Standby instances skip writing to avoid file/Discord mismatch
    if (!isLeader) return;
    if (writeTimer) return;
    writeTimer = setTimeout(async () => {
        writeTimer = null;
        try { await writeFile(OUTPUT_FILE, formatOutput(), "utf-8"); log("File written"); } catch (e) { log("Write failed:", e?.message || e); }
    }, FILE_WRITE_DEBOUNCE_MS);
    writeTimer.unref?.();
}

function formatOutput() {
    const now = new Date();
    const d = displayedSessionID ? sessions.get(displayedSessionID) : null;
    const lines = [];
    lines.push("═".repeat(60));
    lines.push(` OpenCode Presence State — ${now.toISOString().replace("T", " ").substring(0, 19)} UTC`);
    lines.push("═".repeat(60));
    lines.push("");

    if (d) {
        const t = d.contextTokens.toLocaleString();
        const l = d.modelLimit ? d.modelLimit.toLocaleString() : "unknown";
        const ct = d.cost === 0 ? "$0.0000 ∞" : `$${d.cost.toFixed(4)}`;
        lines.push("DISPLAYED SESSION");
        lines.push(`  ID        : ${d.sessionID}`);
        lines.push(`  Provider  : ${d.provider}`);
        lines.push(`  Model     : ${d.model}`);
        lines.push(`  Mode      : ${d.mode}`);
        lines.push(`  State     : ${d.state}`);
        lines.push(`  Started   : ${new Date(d.startedAt).toISOString().substring(0, 19)} (${formatDuration(Date.now() - d.startedAt)})`);
        lines.push(`  Context   : ${t} / ${l} tokens (${d.contextPercent.toFixed(1)}%)`);
        lines.push(`  Cost      : ${ct}`);
        lines.push(`  Prompts   : ${d.promptCount}`);
    } else {
        lines.push("NO ACTIVE SESSION");
        lines.push("  (waiting for first prompt...)");
    }

    lines.push("");
    lines.push(`QUEUE (${queue.length} session${queue.length === 1 ? "" : "s"})`);
    if (queue.length === 0) {
        lines.push("  (empty)");
    } else {
        queue.forEach((s) => {
            const ss = sessions.get(s);
            if (!ss) return;
            const m = s === displayedSessionID ? "→" : " ";
            lines.push(`  ${m} [${ss.state.padEnd(20)}] ${ss.sessionID}  (${formatDuration(Date.now() - ss.startedAt)})`);
        });
    }

    lines.push("");
    lines.push("═".repeat(60));
    lines.push(` Application ID : ${config.appId}`);
    lines.push(` Asset Key      : ${config.largeImageKey}`);
    lines.push(` Asset Text     : ${config.largeImageText}`);
    lines.push(` Phase          : 2 (State Collector + Discord RPC)`);
    lines.push(` Discord        : ${discord.connected ? "connected" : "disconnected"}`);
    lines.push(` Discord Error  : ${discord.lastError || "(none)"}`);
    lines.push(` Discord Retries: ${discord.retryCount}/${DISCORD_MAX_RETRIES}`);
    lines.push(` Last Attempt   : ${discord.lastAttemptAt ? formatDuration(Date.now() - discord.lastAttemptAt) + " ago" : "never"}`);
    lines.push(` Models Loaded  : ${providerModels.size}`);
    lines.push(` Output File    : ${OUTPUT_FILE}`);
    lines.push("═".repeat(60));
    return lines.join("\n");
}

// ─── Display / Queue Logic ────────────────────────────────────────────────

function updateDisplay() {
    for (const s of queue) { const ss = sessions.get(s); if (ss?.isActive()) { displayedSessionID = s; return; } }
    let lt = 0, li = null;
    for (const s of queue) { const ss = sessions.get(s); if (ss && ss.lastActivity > lt) { lt = ss.lastActivity; li = s; } }
    displayedSessionID = li;
}

function getModelLimit(mid) {
    if (!mid) return null;
    if (providerModels.has(mid)) return providerModels.get(mid);
    const st = mid.includes("/") ? mid.split("/").slice(1).join("/") : mid;
    if (providerModels.has(st)) return providerModels.get(st);
    return null;
}

function ensureSession(sid) {
    if (!sid) return null;
    let s = sessions.get(sid);
    if (!s) { s = new SessionState(sid); sessions.set(sid, s); if (!queue.includes(sid)) queue.push(sid); }
    return s;
}

// ─── SDK Calls ────────────────────────────────────────────────────────────

async function restoreSessionMessages(client, sid, wd) {
    const s = ensureSession(sid);
    try {
        const o = { path: { id: sid } };
        if (wd) o.query = { directory: wd };
        const r = await withTimeout(client.session.messages(o), RESTORE_TIMEOUT_MS, `messages(${sid})`);
        let msgs = Array.isArray(r?.data) ? r.data : (Array.isArray(r) ? r : null);
        if (!Array.isArray(msgs)) return;
        let lm = null, ac = 0;
        for (const m of msgs) {
            const i = m?.info ?? m;
            if (!i || i.role !== "assistant") continue;
            const wn = !s._messageMap.has(i.id);
            s.addOrUpdateMessage(i.id, i.cost, i.tokens, i.modelID, i.providerID, i.time?.completed, i.time?.created);
            if (wn) { s.promptCount++; ac++; }
            if (i.modelID) s.model = i.modelID;
            if (i.providerID) s.provider = i.providerID;
            if (i.mode) lm = i.mode;
        }
        if (lm) s.mode = lm;
        s.modelLimit = getModelLimit(s.model) ?? s.modelLimit;
        log(`Restored ${sid}: ${ac} msgs, $${s.cost.toFixed(4)}, model=${s.model}`);
    } catch (e) { log(`restoreMsg(${sid}): ${e?.message || e}`); }
}

// Lightweight check: just get latest message of each session to update lastActivity.
// Used by leader to detect when OTHER terminals' sessions become active.
async function checkAllSessionsActivity(client, wd) {
    try {
        const listOpts = wd ? { query: { directory: wd } } : undefined;
        const resp = await withTimeout(client.session.list(listOpts), RESTORE_TIMEOUT_MS, "session.list");
        const list = resp?.data ?? resp;
        if (!Array.isArray(list)) return;

        const checks = list.filter(s => s?.id).map(async (si) => {
            const id = si.id;
            const state = sessions.get(id);
            if (!state) return; // skip unknown sessions
            // Only fetch latest 1 message (lightweight)
            const opts = { path: { id } };
            if (wd) opts.query = { directory: wd, limit: 1 };
            try {
                const r = await withTimeout(client.session.messages(opts), RESTORE_TIMEOUT_MS, `latest(${id})`);
                const msgs = Array.isArray(r?.data) ? r.data : (Array.isArray(r) ? r : null);
                if (!Array.isArray(msgs) || msgs.length === 0) return;
                const latest = msgs[msgs.length - 1];
                const info = latest?.info ?? latest;
                if (!info) return;
                // Update lastActivity to the latest message timestamp
                const ts = info.time?.completed || info.time?.created || 0;
                if (ts > state.lastActivity) {
                    state.lastActivity = ts;
                }
                // If it's a user message, session is active
                if (info.role === "user") {
                    state.state = STATE.WORKING;
                } else if (info.role === "assistant" && !info.time?.completed) {
                    state.state = STATE.TYPING;
                } else if (info.role === "assistant" && info.time?.completed) {
                    // Latest completed = waiting state
                    state.state = STATE.WAITING;
                }
            } catch {}
        });

        await Promise.allSettled(checks);

        // Re-evaluate which session to display based on fresh activity data
        const previousDisplayed = displayedSessionID;
        updateDisplay();
        if (displayedSessionID !== previousDisplayed) {
            log(`Switched display: ${previousDisplayed?.slice(-8) || "(none)"} → ${displayedSessionID?.slice(-8) || "(none)"}`);
            scheduleWrite();
        }
    } catch (e) {
        log(`checkAllSessionsActivity: ${e?.message || e}`);
    }
}

async function loadProviderModels(client, wd) {
    try {
        const o = wd ? { query: { directory: wd } } : undefined;
        const r = await withTimeout(client.provider.list(o), RESTORE_TIMEOUT_MS, "provider.list");
        const d = r?.data ?? r;
        const pl = d?.all ?? (Array.isArray(d) ? d : null);
        if (!Array.isArray(pl)) return;
        for (const p of pl) {
            if (!p?.models) continue;
            for (const [mid, m] of Object.entries(p.models)) {
                if (m?.limit?.context) {
                    providerModels.set(mid, m.limit.context);
                    if (p.id) providerModels.set(`${p.id}/${mid}`, m.limit.context);
                    const st = mid.includes("/") ? mid.split("/").slice(1).join("/") : mid;
                    if (st !== mid) providerModels.set(st, m.limit.context);
                }
            }
        }
        log(`Loaded ${providerModels.size} model limits`);
    } catch (e) { log(`loadModels: ${e?.message || e}`); }
}

async function restoreFromServer(client, wd) {
    try {
        await loadProviderModels(client, wd);
        const o = wd ? { query: { directory: wd } } : undefined;
        const r = await withTimeout(client.session.list(o), RESTORE_TIMEOUT_MS, "session.list");
        const sl = r?.data ?? r;
        if (!Array.isArray(sl)) return log("No sessions to restore");
        const tasks = sl.filter(x => x?.id).map(async (si) => {
            const s = ensureSession(si.id);
            if (si.time?.created) s.startedAt = si.time.created;
            s.lastActivity = si.time?.updated || s.startedAt;
            try { await restoreSessionMessages(client, si.id, wd); } catch (e) { log(`Restore task ${si.id}: ${e?.message || e}`); }
        });
        await Promise.allSettled(tasks);
        updateDisplay();
        scheduleWrite();
        log(`Restored ${sessions.size} sessions`);
    } catch (e) { log(`restoreAll: ${e?.message || e}`); }
}

function loadFallbackLimits() {
    let c = 0;
    for (const [id, l] of Object.entries(FALLBACK_MODEL_LIMITS)) { providerModels.set(id, l); c++; }
    log(`Loaded ${c} fallback limits`);
}

async function loadConfigLimits(p) {
    if (!p) return;
    try {
        const raw = await readFile(p, "utf-8");
        const j = JSON.parse(raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""));
        const prs = j?.provider;
        if (!prs || typeof prs !== "object") return;
        let c = 0;
        for (const [pid, pd] of Object.entries(prs)) {
            if (!pd?.models) continue;
            for (const [mid, m] of Object.entries(pd.models)) {
                const l = m?.limit?.context;
                if (typeof l === "number" && l > 0) {
                    providerModels.set(mid, l);
                    providerModels.set(`${pid}/${mid}`, l);
                    const st = mid.includes("/") ? mid.split("/").slice(1).join("/") : mid;
                    if (st !== mid) providerModels.set(st, l);
                    c++;
                }
            }
        }
        log(`Loaded ${c} model limits from ${basename(p)}`);
    } catch (e) { log(`loadConfigLimits(${p}): ${e?.message || e}`); }
}

// ─── Main Plugin ──────────────────────────────────────────────────────────

export const OpencodeDcTooRichPresence = async ({ client, directory }) => {
    if (!client) { log("No client"); return {}; }

    log("=== Plugin loaded ===");
    log(`Output: ${OUTPUT_FILE}`);
    log(`Workdir: ${directory || "(none)"}`);

    config = await loadConfig();
    log(`Config: appId=${config.appId} key=${config.largeImageKey}`);

    // Try to acquire leader lock (only one instance pushes to Discord at a time)
    await tryAcquireLock();

    loadFallbackLimits();

    const cfgPaths = [
        join(directory || "", "opencode.json"),
        join(directory || "", "opencode.jsonc"),
        join(homedir(), ".config", "opencode", "opencode.json"),
        join(homedir(), ".config", "opencode", "opencode.jsonc"),
    ];
    for (const p of cfgPaths) { if (p) loadConfigLimits(p).catch(() => {}); }

    try { await mkdir(join(homedir(), ".config", "opencode"), { recursive: true }); } catch {}

    restoreFromServer(client, directory).catch(e => log(`Background restore error: ${e?.message || e}`));

    // Only spawn Discord worker if we're the leader instance
    if (isLeader) {
        startHeartbeat();
        discordConnect();
    } else {
        log("Not leader - skipping Discord connect (another instance is handling it)");
        discord.lastError = "Standby (another instance is active)";
    }

    // Always write the output file so user can see current state
    scheduleWrite();

    // Periodic activity check for the LEADER instance.
    // Each plugin instance only receives events for its own OpenCode process's sessions,
    // so the leader needs to poll OTHER instances' sessions to know when they're active.
    const activityTimer = setInterval(() => {
        if (isLeader) {
            checkAllSessionsActivity(client, directory).catch((e) =>
                log(`Activity check failed: ${e?.message || e}`)
            );
        }
    }, REFRESH_INTERVAL);
    activityTimer.unref?.();
    log("Activity timer started");

    // Backward compat: refresh displayed session messages
    const refreshTimer = setInterval(() => {
        const d = displayedSessionID ? sessions.get(displayedSessionID) : null;
        if (d && d.state !== STATE.WAITING) restoreSessionMessages(client, d.sessionID, directory).catch(() => {});
    }, REFRESH_INTERVAL);
    refreshTimer.unref?.();

    return {
        dispose: async () => {
            log("Disposing...");
            clearInterval(refreshTimer);
            await releaseLock();
            await discordDestroy();
        },

        "chat.message": async (input) => {
            try {
                const sid = input.sessionID;
                if (!sid) return;
                const s = ensureSession(sid);
                s.agent = input.agent || s.agent;
                s.model = input.model?.modelID || s.model;
                s.mode = input.agent || s.mode;
                s.modelLimit = getModelLimit(s.model) ?? s.modelLimit;
                s.lastActivity = Date.now();
                s.promptCount++;
                s.state = STATE.WORKING;
                updateDisplay();
                scheduleWrite();
                restoreSessionMessages(client, sid, directory).catch(() => {});
            } catch (e) { log("chat.message error:", e?.message || e); }
        },

        event: async ({ event }) => {
            try {
                const et = event?.type;
                if (!et) return;

                if (et === "session.created" || et === "session.updated") {
                    const i = event.properties?.info;
                    if (!i?.id) return;
                    const s = ensureSession(i.id);
                    if (i.time?.created) s.startedAt = i.time.created;
                    s.lastActivity = Date.now();
                    updateDisplay();
                    scheduleWrite();
                    restoreSessionMessages(client, i.id, directory).catch(() => {});
                    return;
                }

                if (et === "session.deleted") {
                    const i = event.properties?.info;
                    const id = i?.id;
                    if (!id) return;
                    sessions.delete(id);
                    const idx = queue.indexOf(id);
                    if (idx !== -1) queue.splice(idx, 1);
                    if (displayedSessionID === id) updateDisplay();
                    scheduleWrite();
                    return;
                }

                if (et === "session.status" || et === "session.idle") {
                    const sid = event.properties?.sessionID;
                    if (!sid) return;
                    const s = sessions.get(sid);
                    if (!s) return;
                    const st = event.properties?.status?.type ?? (et === "session.idle" ? "idle" : null);
                    s.lastActivity = Date.now();
                    if ((st === "idle" || et === "session.idle") && s.state !== STATE.ASKING) s.state = STATE.WAITING;
                    else if (st === "busy" && ![STATE.TYPING, STATE.THINKING, STATE.ASKING].includes(s.state)) s.state = STATE.WORKING;
                    updateDisplay();
                    scheduleWrite();
                    return;
                }

                if (et === "message.updated") {
                    const i = event.properties?.info;
                    if (!i || i.role !== "assistant") return;
                    const sid = i.sessionID;
                    if (!sid) return;
                    const s = ensureSession(sid);
                    s.addOrUpdateMessage(i.id, i.cost, i.tokens, i.modelID, i.providerID, i.time?.completed, i.time?.created);
                    if (i.mode) s.mode = i.mode;
                    s.modelLimit = getModelLimit(s.model) ?? s.modelLimit;
                    s.lastActivity = Date.now();
                    updateDisplay();
                    scheduleWrite();
                    return;
                }

                if (et === "message.part.updated") {
                    const p = event.properties?.part;
                    if (!p) return;
                    const sid = p.sessionID;
                    if (!sid) return;
                    const s = sessions.get(sid);
                    if (!s) return;
                    s.lastActivity = Date.now();
                    if (p.type === "reasoning") s.state = STATE.THINKING;
                    else if (p.type === "text" && s.state !== STATE.ASKING) s.state = STATE.TYPING;
                    else if (p.type === "tool") s.state = STATE.WORKING;
                    else if (p.type === "step-finish" && p.tokens) {
                        const ctxT = (p.tokens.input || 0) + (p.tokens.cache?.read || 0);
                        if (ctxT > 0) s._latestContextTokens = ctxT;
                    }
                    updateDisplay();
                    scheduleWrite();
                    return;
                }

                if (et === "permission.asked") {
                    const sid = event.properties?.sessionID;
                    if (!sid) return;
                    const s = sessions.get(sid);
                    if (!s) return;
                    s.state = STATE.ASKING;
                    s.lastActivity = Date.now();
                    updateDisplay();
                    scheduleWrite();
                    return;
                }

                if (et === "permission.replied") {
                    const sid = event.properties?.sessionID;
                    if (!sid) return;
                    const s = sessions.get(sid);
                    if (!s) return;
                    s.state = STATE.WORKING;
                    s.lastActivity = Date.now();
                    updateDisplay();
                    scheduleWrite();
                    return;
                }
            } catch (e) { log("event error:", e?.message || e); }
        },
    };
};

export default OpencodeDcTooRichPresence;
