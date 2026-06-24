#!/usr/bin/env node
// CLI entry point. Dispatches to subcommand handlers.
import { run } from "../src/cli/dispatcher.js";

async function main() {
    try {
        await run(process.argv.slice(2));
        // Force exit so any open readline interface (from interactive prompts)
        // does not keep the Node process alive after the command finishes.
        process.exit(0);
    } catch (err) {
        console.error(`\n[error] ${err?.message || err}\n`);
        if (process.env.OPENCODE_RPC_DEBUG) console.error(err);
        process.exit(1);
    }
}

main();
