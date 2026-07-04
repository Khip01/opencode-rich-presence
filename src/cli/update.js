import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OWNER = "Khip01";
const REPO = "opencode-rich-presence";
const GIT_SPEC = `${OWNER}/${REPO}`;

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

async function fetchLatestStableTag() {
    const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, {
        headers: { "User-Agent": "opencode-rich-presence-cli" },
    });
    if (!res.ok) {
        throw new Error(`GitHub API returned ${res.status}: ${res.statusText}`);
    }
    const data = await res.json();
    return data.tag_name || null;
}

async function fetchLatestCommit(branch = "main") {
    const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/commits/${branch}`, {
        headers: { "User-Agent": "opencode-rich-presence-cli" },
    });
    if (!res.ok) {
        throw new Error(`GitHub API returned ${res.status}: ${res.statusText}`);
    }
    const data = await res.json();
    return data.sha || null;
}

function runNpmInstall(ref) {
    const spec = `${GIT_SPEC}#${ref}`;
    console.log(`Installing ${spec}...\n`);
    const result = spawnSync("npm", ["install", "-g", spec], { stdio: "inherit" });
    return result.status;
}

async function installStable(ref, current) {
    console.log(`Mode: stable (forcing install of ${ref})`);
    console.log(`Switching to ${ref}...\n`);
    const status = runNpmInstall(ref);
    if (status !== 0) {
        console.error(`\nInstall failed (exit ${status}).`);
        process.exit(status || 1);
    }
    console.log(`\nNow on ${ref}.`);
    console.log("Restart OpenCode to apply changes.\n");
}

async function installDev(current) {
    let sha;
    try {
        sha = await fetchLatestCommit("main");
    } catch (e) {
        console.error(`Failed to fetch latest commit: ${e.message}`);
        process.exit(1);
    }
    if (!sha) {
        console.error("GitHub API returned no SHA");
        process.exit(1);
    }
    const shortSha = sha.substring(0, 7);
    console.log(`Latest commit on main: ${shortSha}`);
    console.log(`Update available: v${current} -> ${shortSha} (dev)\n`);
    const status = runNpmInstall(sha);
    if (status !== 0) {
        console.error(`\nInstall failed (exit ${status}).`);
        process.exit(status || 1);
    }
    console.log(`\nUpdated to dev build at ${shortSha}.`);
    console.log("Restart OpenCode to apply changes.\n");
}

async function upgradeStable(current) {
    let tag;
    try {
        tag = await fetchLatestStableTag();
    } catch (e) {
        console.error(`Failed to fetch release info: ${e.message}`);
        process.exit(1);
    }
    if (!tag) {
        console.error("GitHub API returned no tag");
        process.exit(1);
    }

    const latestVer = parseSemver(tag);
    const currentVer = parseSemver(current);
    if (!latestVer || !currentVer) {
        console.error(`Cannot parse version (current: ${current}, latest: ${tag})`);
        process.exit(1);
    }

    if (compareSemver(latestVer, currentVer) <= 0) {
        console.log(`Already up-to-date (latest: ${tag}).`);
        return;
    }

    console.log(`Update available: v${current} -> ${tag}\n`);
    const status = runNpmInstall(tag);
    if (status !== 0) {
        console.error(`\nInstall failed (exit ${status}).`);
        process.exit(status || 1);
    }
    console.log(`\nUpdated to ${tag}.`);
    console.log("Restart OpenCode to apply changes.\n");
}

export async function update(args = []) {
    const isDev = args.includes("--dev");
    const isStable = args.includes("--stable");

    // Mutually exclusive: --stable installs a tag, --dev installs latest commit.
    // They are contradictory intents; reject with a clear error rather than
    // silently picking one. Follows POSIX Guideline 11 and modern CLI
    // conventions (cargo, kubectl, npm).
    if (isStable && isDev) {
        console.error("Error: --stable and --dev are mutually exclusive.");
        console.error("Use one or the other, not both.");
        process.exit(2);
    }

    const current = getCurrentVersion();
    console.log(`\nCurrent version: v${current}`);

    if (isDev) {
        console.log("Mode: dev (latest commit on main)");
        console.log("Checking for updates...\n");
        await installDev(current);
        return;
    }

    if (isStable) {
        let tag;
        try {
            tag = await fetchLatestStableTag();
        } catch (e) {
            console.error(`Failed to fetch release info: ${e.message}`);
            process.exit(1);
        }
        if (!tag) {
            console.error("GitHub API returned no tag");
            process.exit(1);
        }
        await installStable(tag, current);
        return;
    }

    console.log("Mode: stable (latest release tag)");
    console.log("Checking for updates...\n");
    await upgradeStable(current);
}
