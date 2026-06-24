import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { isatty } from "node:tty";
import { readFileSync } from "node:fs";

// Single shared line reader (TTY) or buffer (piped). Lazily initialized on first use.
// Using a single long-lived readline interface avoids the issue where creating and
// closing multiple interfaces in one process breaks interaction with piped stdin.

let reader = null;

function makeReader() {
    const tty = isatty(0) && isatty(1);
    if (tty) {
        return createInterface({ input: stdin, output: stdout, terminal: true });
    }
    // Piped stdin: read all lines upfront, then consume on each call.
    let lines;
    try {
        lines = readFileSync(0, "utf-8").split("\n").map((l) => l.trim());
    } catch {
        lines = [];
    }
    let idx = 0;
    return {
        async question(promptText) {
            if (promptText && tty === false) {
                process.stdout.write(promptText);
            }
            if (idx >= lines.length) return "";
            return lines[idx++];
        },
        close() {},
    };
}

function getReader() {
    if (!reader) reader = makeReader();
    return reader;
}

// Zero-dependency confirmation prompt.
export async function confirm(question, { defaultYes = false } = {}) {
    const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
    const rl = getReader();
    const answer = (await rl.question(question + suffix)).trim();
    if (!answer) return defaultYes;
    return /^y(es)?$/i.test(answer);
}

// Multi-option prompt. Returns the key (single character) the user selected.
// choices: { b: "Backup and remove", k: "Keep file", d: "Delete permanently" }
// defaultKey: returned when user presses Enter without typing.
export async function choose(question, choices, defaultKey = null) {
    const keys = Object.keys(choices);
    const rl = getReader();
    console.log(question);
    for (const [k, label] of Object.entries(choices)) {
        const def = k === defaultKey ? " (default)" : "";
        console.log(`  ${k}) ${label}${def}`);
    }
    const suffix = defaultKey ? ` [${defaultKey}] ` : " ";
    while (true) {
        const answer = (await rl.question("Choice" + suffix + ":")).trim().toLowerCase();
        if (!answer && defaultKey) return defaultKey;
        if (keys.includes(answer)) return answer;
        console.log(`Please enter one of: ${keys.join(", ")}`);
    }
}

// Read a single line of input.
export async function question(prompt) {
    const rl = getReader();
    return (await rl.question(prompt)).trim();
}
