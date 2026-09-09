import { STATE } from "../shared/constants.js";

export function formatModelCode(raw) {
    if (!raw || raw === "?") return "?";
    const s = String(raw);
    const idx = s.lastIndexOf("/");
    return idx === -1 ? s : s.slice(idx + 1);
}

export function formatModelName(code) {
    if (!code || code === "?") return "?";
    const s = String(code);
    // Replace - _ : with space. Keep . (version dots) and alphanumerics intact.
    const spaced = s.replace(/[-_:]+/g, " ");
    const tokens = spaced.split(/\s+/).filter(Boolean);
    return tokens.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(" ");
}

export function getTemplateVars(session, replacements) {
    const s = session || {};
    const rawModel = s.model || "?";
    const modelCode = formatModelCode(rawModel);
    const modelName = formatModelName(modelCode);
    const modelNameLower = modelName === "?" ? "?" : modelName.toLowerCase();
    const d = {
        id: s.sessionID ? s.sessionID.substring(s.sessionID.length - 12) : "?",
        sessionId: s.sessionID || "?",
        provider: s.provider || "?",
        model: rawModel,
        modelCode,
        modelName,
        modelNameLower,
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
        cost: typeof s.cost === "number" ? (s.cost === 0 ? "free" : `${s.currency || "$"}${s.cost.toFixed(4)}`) : `${s.currency || "$"}0`,
        costCompact: formatCompactCurrency(s.cost || 0, s.currency || "$"),
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
    if (Array.isArray(replacements) && replacements.length) {
        applyReplacements(d, replacements);
    }
    return d;
}

// Wildcard replacement engine.
// `from` may contain a leading and/or trailing `*` as wildcard.
// Interior `*` is not supported and the rule is skipped.
// Literal, case-sensitive. Empty `from` or `from` that is only wildcards is skipped.
export function applyReplacements(vars, rules) {
    if (!Array.isArray(rules) || !rules.length) return;
    const seen = new Set();
    for (const rule of rules) {
        if (!rule || typeof rule !== "object") continue;
        const from = rule.from;
        const to = rule.to;
        if (typeof from !== "string" || typeof to !== "string") continue;
        const varsArr = Array.isArray(rule.vars) ? rule.vars : [];
        if (!varsArr.length) continue;

        // Validate wildcard placement: * only at start and/or end, not interior.
        const inner = from.replace(/^\*+/, "").replace(/\*+$/, "");
        const hasInnerStar = inner.includes("*");
        if (hasInnerStar) continue;
        // from that is only wildcards (or empty) is invalid.
        if (inner.length === 0) continue;
        // from empty string is invalid.
        if (from.length === 0) continue;
        // Multiple leading/trailing * collapses to one (tolerate ** as *).
        const startsWithStar = from.startsWith("*");
        const endsWithStar = from.endsWith("*");
        const core = inner;

        for (const vn of varsArr) {
            if (typeof vn !== "string" || !vn) continue;
            // Skip unknown vars (allowlist enforced by config-resolver, but also guard here).
            if (!(vn in vars)) continue;
            const dedupKey = `${vn}\0${from}\0${to}`;
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);

            const cur = String(vars[vn] ?? "");
            let next = cur;
            if (!startsWithStar && !endsWithStar) {
                // exact
                if (cur === core) next = to;
            } else if (startsWithStar && endsWithStar) {
                // contains: replace all occurrences (global)
                if (cur.includes(core)) next = cur.split(core).join(to);
            } else if (startsWithStar) {
                // suffix: *core -> ends with core
                if (cur.endsWith(core)) next = cur.slice(0, cur.length - core.length) + to;
            } else {
                // prefix: core* -> starts with core
                if (cur.startsWith(core)) next = to + cur.slice(core.length);
            }
            if (next !== cur) vars[vn] = next;
        }
    }
}

export function renderTemplate(template, vars) {
    if (!template) return "";
    let r = String(template);

    // 1. Conditional with comparison: {{#if var op "value" or value}}tb{{else}}fb{{/if}}
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
    const varRegex = /(?<!\{)\{(\w+)(?:\|([^}]*))?\}?\}?/g;
    r = r.replace(varRegex, (_, vn, fb) => {
        if (vars[vn] !== undefined && vars[vn] !== null) return String(vars[vn]);
        return fb !== undefined ? fb : "?";
    });

    return r;
}

export function chooseTemplates(templates, state) {
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

export function selectIdleTemplates(templates) {
    if (templates?.idle && typeof templates.idle === "object") return templates.idle;
    return { details: "OpenCode · idle", state: "No active session", largeImageText: "OpenCode", smallImageText: "Idle" };
}

export function compactNumber(value) {
    const num = parseFloat(value);
    if (isNaN(num)) return String(value);
    if (Math.abs(num) < 1000) return Math.round(num).toLocaleString();

    let k = Math.round((num / 1000) * 10) / 10;
    if (k >= 1000) {
        let m = Math.round((num / 1_000_000) * 10) / 10;
        if (m >= 1000) {
            let b = Math.round((num / 1_000_000_000) * 10) / 10;
            return Number.isInteger(b) ? `${b}B` : `${b.toFixed(1)}B`;
        }
        return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
    }
    return Number.isInteger(k) ? `${k}K` : `${k.toFixed(1)}K`;
}

export function formatCompactCurrency(value, currency = "$") {
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

export function formatDuration(ms) {
    const sec = Math.floor(ms / 1000);
    const min = Math.floor(sec / 60);
    const hr = Math.floor(min / 60);
    if (hr > 0) return `${hr}h ${min % 60}m`;
    if (min > 0) return `${min}m ${sec % 60}s`;
    return `${sec}s`;
}

export function truncate(s, max) {
    if (!s) return s;
    return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms).unref?.()),
    ]);
}
