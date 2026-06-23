import { createWriteStream, existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { execSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OWNER = "Khip01";
const REPO = "opencode-rich-presence";

function parseSemver(v) {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || "").trim());
    if (!m) return null;
    return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

function compareSemver(a, b) {
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
}

function getCurrentVersion() {
    try {
        const pkgPath = join(dirname(dirname(fileURLToPath(import.meta.url))), "..", "package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        return pkg.version;
    } catch {
        return "0.0.0";
    }
}

async function fetchLatestRelease() {
    const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, {
        headers: { "User-Agent": "opencode-rich-presence-cli" },
    });
    if (!res.ok) throw new Error(`GitHub API returned ${res.status}: ${res.statusText}`);
    return await res.json();
}

export async function update() {
    const current = getCurrentVersion();
    console.log(`\nCurrent version: v${current}`);
    console.log("Checking for updates...\n");

    let release;
    try {
        release = await fetchLatestRelease();
    } catch (e) {
        console.error(`Failed to fetch release info: ${e.message}`);
        process.exit(1);
    }

    const latestTag = release.tag_name || "";
    const latestVer = parseSemver(latestTag);
    const currentVer = parseSemver(current);

    if (!latestVer || !currentVer) {
        console.error(`Cannot parse version (current: ${current}, latest: ${latestTag})`);
        process.exit(1);
    }

    if (compareSemver(latestVer, currentVer) <= 0) {
        console.log(`Already up-to-date (latest: ${latestTag}).`);
        return;
    }

    console.log(`Update available: v${current} -> ${latestTag}\n`);

    const asset = (release.assets || []).find((a) => a.name.endsWith(".tgz"));
    if (!asset) {
        console.error("No tarball (.tgz) asset found in latest release.");
        process.exit(1);
    }

    const tmpPath = join(tmpdir(), `opencode-rich-presence-${latestTag.replace(/^v/, "")}.tgz`);
    console.log(`Downloading ${asset.name}...`);

    try {
        const dlRes = await fetch(asset.browser_download_url);
        if (!dlRes.ok) throw new Error(`HTTP ${dlRes.status}`);
        await pipeline(dlRes.body, createWriteStream(tmpPath));
    } catch (e) {
        console.error(`Download failed: ${e.message}`);
        process.exit(1);
    }

    console.log(`Installing v${latestVer.join(".")}...\n`);
    const result = spawnSync("npm", ["install", "-g", tmpPath], { stdio: "inherit" });
    try { await unlink(tmpPath); } catch {}

    if (result.status !== 0) {
        console.error(`\nInstall failed (exit ${result.status}).`);
        process.exit(result.status || 1);
    }

    console.log(`\nUpdated to ${latestTag}.`);
    console.log("Restart OpenCode to apply changes.\n");
}
