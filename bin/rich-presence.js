#!/usr/bin/env node
// CLI entry point. Dispatches to subcommand handlers.
import { run } from "../src/cli/dispatcher.js";

try {
    await run(process.argv.slice(2));
} catch (err) {
    console.error(`\n[error] ${err?.message || err}\n`);
    if (process.env.RICH_PRESENCE_DEBUG) console.error(err);
    process.exit(1);
}
