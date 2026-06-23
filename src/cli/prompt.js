import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

// Zero-dependency confirmation prompt.
// Returns true if user confirmed, false otherwise.
export async function confirm(question, { defaultYes = false } = {}) {
    const rl = createInterface({ input: stdin, output: stdout });
    const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
    try {
        const answer = (await rl.question(question + suffix)).trim();
        if (!answer) return defaultYes;
        return /^y(es)?$/i.test(answer);
    } finally {
        rl.close();
    }
}

// Read a single line of input.
export async function question(prompt) {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
        return (await rl.question(prompt)).trim();
    } finally {
        rl.close();
    }
}
