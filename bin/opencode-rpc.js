#!/usr/bin/env node
// CLI entry point. Dispatches to subcommand handlers.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli/dispatcher.js";

const REPO = "opencode-rich-presence";

// Ensure the `.install-channel` marker exists so `opencode-rpc version` can
// report the channel even when the install was done via `npm install -g
// <tarball>` directly rather than through `opencode-rpc update`. The marker
// is only written by `update.js` for explicit channel switches (dev vs
// stable), so a fresh tarball install has no marker and `version` would
// fall back to just showing the version. Bootstrapping here with a default
// of "stable" reflects the most likely install path (a tagged release
// tarball). `update --dev` will overwrite the marker with channel="dev"
// + the actual commit SHA on its next run.
function ensureInstallMarker() {
    try {
        const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
        const marker = join(pkgDir, ".install-channel");
        if (existsSync(marker)) return;
        const pkgPath = join(pkgDir, "package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        writeFileSync(
            marker,
            JSON.stringify(
                {
                    channel: "stable",
                    ref: `v${pkg.version}`,
                    installedAt: new Date().toISOString(),
                    bootstrapped: true,
                },
                null,
                2,
            ) + "\n",
            "utf-8",
        );
    } catch {
        // Best-effort: do not fail the CLI invocation if marker cannot be written.
    }
}

async function main() {
    try {
        ensureInstallMarker();
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
