// Minimal JSONC reader for OpenCode configuration files.
//
// opencode.jsonc is JSON with comments and trailing commas. Two things
// broke the previous inline parser:
//
// 1. `^\s*//` only strips comments that start a line, so inline
//    comments such as `"context": 393216, // note` survived and
//    `JSON.parse` threw. The whole config fallback was then skipped
//    silently, which is why custom providers had no context limit.
// 2. Stripping `//` without string awareness would also corrupt
//    values like `"baseURL": "https://..."`.
//
// This scanner walks the text once, removes comments only outside
// string literals, then drops commas that directly precede `}` or `]`.

function isWhitespace(ch) {
    return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

export function stripJsonComments(input) {
    if (typeof input !== "string" || !input) return "";
    let out = "";
    let i = 0;
    let inString = false;
    let escaped = false;

    while (i < input.length) {
        const ch = input[i];
        const next = input[i + 1];

        if (inString) {
            out += ch;
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === '"') inString = false;
            i += 1;
            continue;
        }

        if (ch === '"') {
            inString = true;
            out += ch;
            i += 1;
            continue;
        }

        if (ch === "/" && next === "/") {
            while (i < input.length && input[i] !== "\n") i += 1;
            continue;
        }

        if (ch === "/" && next === "*") {
            i += 2;
            while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i += 1;
            i += 2;
            continue;
        }

        out += ch;
        i += 1;
    }

    return out;
}

export function stripTrailingCommas(input) {
    if (typeof input !== "string" || !input) return "";
    let out = "";
    let i = 0;
    let inString = false;
    let escaped = false;

    while (i < input.length) {
        const ch = input[i];

        if (inString) {
            out += ch;
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === '"') inString = false;
            i += 1;
            continue;
        }

        if (ch === '"') {
            inString = true;
            out += ch;
            i += 1;
            continue;
        }

        if (ch === ",") {
            let j = i + 1;
            while (j < input.length && isWhitespace(input[j])) j += 1;
            if (input[j] === "}" || input[j] === "]") {
                i += 1;
                continue;
            }
        }

        out += ch;
        i += 1;
    }

    return out;
}

// Parse JSONC text. Returns null for empty input so callers can treat
// a missing/blank config as "nothing configured" instead of throwing.
export function parseJsonc(input) {
    if (typeof input !== "string") return null;
    const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
    if (!text.trim()) return null;
    return JSON.parse(stripTrailingCommas(stripJsonComments(text)));
}
