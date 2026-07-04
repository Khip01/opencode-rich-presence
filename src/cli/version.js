import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function loadInstallMarker() {
    // The marker file is written by `opencode-rpc update` (and friends)
    // next to the installed package. It records which channel the user is
    // on (`stable` tag or `dev` commit) so `version` can show that
    // without having to talk to GitHub. Falls back to "unknown" if missing
    // (e.g. pre-v2.0.9 installs that did not write a marker).
    try {
        // version.js lives at <pkg>/src/cli/version.js. The marker lives at
        // <pkg>/.install-channel, so go up two directories.
        const marker = join(
            dirname(dirname(fileURLToPath(import.meta.url))),
            "..",
            ".install-channel",
        );
        if (!existsSync(marker)) return null;
        const raw = readFileSync(marker, "utf-8");
        const data = JSON.parse(raw);
        if (typeof data !== "object" || data === null) return null;
        return data;
    } catch {
        return null;
    }
}

export async function version() {
    try {
        const pkgPath = join(
            dirname(dirname(fileURLToPath(import.meta.url))),
            "..",
            "package.json",
        );
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        const marker = loadInstallMarker();

        let suffix = "";
        if (marker?.channel === "dev" && typeof marker.ref === "string") {
            const shortSha = marker.ref.substring(0, 7);
            suffix = ` (dev: ${shortSha})`;
        } else if (marker?.channel === "stable") {
            suffix = " (stable)";
        }
        console.log(`${pkg.name} v${pkg.version}${suffix}`);
    } catch {
        console.log("opencode-rich-presence (unknown version)");
    }
}
