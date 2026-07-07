import { spawnSync, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OWNER = "Khip01";
const REPO = "opencode-rich-presence";
const REPO_URL = `https://github.com/${OWNER}/${REPO}.git`;

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

// Resolve where `npm install -g` would place this package. We prefer
// `npm root -g` (authoritative, works for nvm/asdf/volta/custom prefixes)
// and fall back to environment-variable guesses when npm is unavailable
// on PATH (minimal containers, etc.).
function resolveGlobalInstallPath() {
    try {
        const result = spawnSync("npm", ["root", "-g"], { encoding: "utf-8" });
        if (result.status === 0) {
            const root = result.stdout.trim();
            if (root) return join(root, REPO);
        }
    } catch {}

    if (process.env.npm_config_prefix) {
        return join(process.env.npm_config_prefix, "lib", "node_modules", REPO);
    }
    if (process.env.NVM_BIN) {
        return join(process.env.NVM_BIN, "..", "..", "lib", "node_modules", REPO);
    }
    return join(dirname(process.execPath), "..", "lib", "node_modules", REPO);
}

// Remove the previously-installed package directory if present, including
// broken symlinks left over by npm v11's git-dep handling. npm install
// renames the existing target as a backup before installing the new one;
// if the existing target is a broken symlink pointing at a deleted npm
// cache temp dir, the rename fails with ENOTDIR. Removing the broken
// symlink up-front avoids this.
//
// `rmSync(target, { recursive: true, force: true })` is safe for all
// target types: no-op when missing (force), unlinks symlinks without
// following them, recursively removes directories.
function cleanExistingInstall() {
    const target = resolveGlobalInstallPath();
    if (!target) return null;
    try {
        rmSync(target, { recursive: true, force: true });
        return target;
    } catch {
        // Permission denied or similar; let `npm install` try and surface
        // a real error to the user.
        return null;
    }
}

// npm v11 installs git deps as symlinks pointing to ~/.npm/_cacache/tmp/<id>,
// which npm cleans up after install. The next install on the same global path
// then fails with ENOTDIR when it tries to rename the existing symlink.
// Workaround: clone the repo, pack a tarball, and install the tarball. The
// tarball path is a real file, not a git dep, so npm treats it as a normal
// install and produces a real directory under lib/node_modules/.
function runNpmInstall(ref) {
    console.log(`Fetching source from ${REPO_URL} (ref: ${ref})...`);
    const cleanedPath = cleanExistingInstall();
    if (cleanedPath) {
        console.log(`Removed previous install at ${cleanedPath}`);
    }

    const tmpDir = mkdtempSync(join(tmpdir(), "orp-install-"));
    try {
        execSync(`git clone ${REPO_URL} .`, { cwd: tmpDir, stdio: "inherit" });
        // Fetch the specific ref (works for both tags and SHAs) and check it
        // out. FETCH_HEAD points at whatever was just fetched, so we don't
        // need to disambiguate tag-vs-branch-vs-SHA.
        execSync(`git fetch --depth=1 origin ${ref}`, { cwd: tmpDir, stdio: "inherit" });
        execSync(`git checkout FETCH_HEAD`, { cwd: tmpDir, stdio: "inherit" });

        // npm pack outputs to cwd; name the tarball after package.json's
        // "version" field, not after our ref. Discover the actual filename
        // rather than constructing it ourselves.
        execSync("npm pack", { cwd: tmpDir, stdio: "inherit" });
        const tarballs = readdirSync(tmpDir).filter((f) => f.endsWith(".tgz"));
        if (tarballs.length === 0) {
            throw new Error(`npm pack produced no tarball in ${tmpDir}`);
        }
        const tarball = join(tmpDir, tarballs[0]);

        console.log(`Installing ${tarballs[0]}...`);
        const result = spawnSync("npm", ["install", "-g", tarball], { stdio: "inherit" });
        return result.status;
    } finally {
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
}

// Write a small marker file inside the installed package so
// `opencode-rpc version` can report which channel the user is on
// (stable tag vs dev commit). We resolve the global modules dir via
// `npm root -g` rather than `import.meta.url` because by the time this
// runs, the package directory has just been replaced by `npm install`
// and our module URL still points to the pre-install path.
function writeInstallMarker(channel, ref) {
    const result = spawnSync("npm", ["root", "-g"], { encoding: "utf-8" });
    if (result.status !== 0) {
        // Best-effort: don't fail the install if `npm root -g` errors.
        return;
    }
    const globalRoot = result.stdout.trim();
    const markerDir = join(globalRoot, REPO);
    const markerFile = join(markerDir, ".install-channel");
    try {
        writeFileSync(
            markerFile,
            JSON.stringify(
                {
                    channel,
                    ref,
                    installedAt: new Date().toISOString(),
                },
                null,
                2,
            ) + "\n",
            "utf-8",
        );
    } catch {
        // Best-effort: don't fail the install if we can't write the marker.
    }
}

async function installStable(ref, current) {
    console.log(`Mode: stable (forcing install of ${ref})`);
    console.log(`Switching to ${ref}...\n`);
    const status = runNpmInstall(ref);
    if (status !== 0) {
        console.error(`\nInstall failed (exit ${status}).`);
        process.exit(status || 1);
    }
    writeInstallMarker("stable", ref);
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
    writeInstallMarker("dev", sha);
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
    writeInstallMarker("stable", tag);

    console.log(`\nUpdated to ${tag}.`);
    console.log("Restart OpenCode to apply changes.\n");
}

export async function update(args = []) {
    const isDev = args.includes("--dev");
    const isStable = args.includes("--stable");
    // --ref <ref> installs a specific git ref (branch, tag, or SHA).
    // This is the recommended way to install pre-release branches
    // like `redesign/v3-daemon` because `npm install -g <url>#<branch>`
    // hits a npm v11 bug that installs the package without bin symlinks.
    // update.js already does a clean clone+pack+tarball install that
    // sidesteps that bug.
    const refIdx = args.indexOf("--ref");
    const refArg = refIdx !== -1 ? args[refIdx + 1] : null;
    if (refIdx !== -1 && !refArg) {
        console.error("Error: --ref requires a value (branch name, tag, or commit SHA).");
        console.error("Example: opencode-rpc update --ref redesign/v3-daemon");
        console.error("         opencode-rpc update --ref v3.0.4-phase2");
        console.error("         opencode-rpc update --ref 6664bfb");
        process.exit(2);
    }

    // Mutually exclusive: --stable installs a tag, --dev installs latest commit,
    // --ref installs a specific ref. Reject conflicting flags explicitly.
    const flagCount = (isStable ? 1 : 0) + (isDev ? 1 : 0) + (refArg ? 1 : 0);
    if (flagCount > 1) {
        console.error("Error: --stable, --dev, and --ref are mutually exclusive.");
        console.error("Use one or the other, not multiple.");
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

    if (refArg) {
        // Determine channel label for the marker file. Heuristic:
        // refs starting with "v" or matching a semver pattern are
        // treated as stable; anything else is treated as dev. Users
        // who need more precision can rename the channel via the
        // marker file directly.
        const channel = /^v?\d+\.\d+\.\d+/.test(refArg) ? "stable" : "dev";
        console.log(`Mode: ref (install ${refArg})`);
        console.log(`Treating as channel=${channel} for version reporting.\n`);
        const status = runNpmInstall(refArg);
        if (status !== 0) {
            console.error(`\nInstall failed (exit ${status}).`);
            process.exit(status || 1);
        }
        writeInstallMarker(channel, refArg);
        console.log(`\nNow on ${refArg} (channel: ${channel}).`);
        console.log("Restart OpenCode to apply changes.\n");
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
