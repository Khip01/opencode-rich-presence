import { spawnSync, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_OWNER = "Khip01";
const DEFAULT_REPO = "opencode-rich-presence";

// Build the GitHub URL for an OWNER/REPO pair. Used by both the
// clone and the API calls; the only thing that changes between
// default install and a fork install is the OWNER (or full OWNER/REPO)
// passed in via --repo.
function repoUrlFor(ownerRepo) {
    return `https://github.com/${ownerRepo}.git`;
}
function defaultOwnerRepo() {
    return `${DEFAULT_OWNER}/${DEFAULT_REPO}`;
}

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

async function fetchLatestStableTag(ownerRepo) {
    const res = await fetch(`https://api.github.com/repos/${ownerRepo}/releases/latest`, {
        headers: { "User-Agent": "opencode-rich-presence-cli" },
    });
    if (!res.ok) {
        throw new Error(`GitHub API returned ${res.status}: ${res.statusText}`);
    }
    const data = await res.json();
    return data.tag_name || null;
}

async function fetchLatestCommit(branch, ownerRepo) {
    const res = await fetch(`https://api.github.com/repos/${ownerRepo}/commits/${branch}`, {
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
            if (root) return join(root, DEFAULT_REPO);
        }
    } catch {}

    if (process.env.npm_config_prefix) {
        return join(process.env.npm_config_prefix, "lib", "node_modules", DEFAULT_REPO);
    }
    if (process.env.NVM_BIN) {
        return join(process.env.NVM_BIN, "..", "..", "lib", "node_modules", DEFAULT_REPO);
    }
    return join(dirname(process.execPath), "..", "lib", "node_modules", DEFAULT_REPO);
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
//
// Cleanup ordering: do NOT remove the existing install at the start.
// If `git fetch <bad-ref>` fails (typo, network, etc.), the user
// would be left without an installed CLI. Build the tarball first,
// THEN remove the old install (which is needed right before
// `npm install -g <tarball>` to avoid ENOTDIR from any leftover
// npm-v11 broken symlink). If anything between tarball build and
// the npm install fails, the old install stays untouched.
//
// Ref checkout strategy: do a full `git clone` (no `--depth=1`)
// then `git checkout <ref>` directly. This handles branch names,
// tag names, AND commit SHAs uniformly. The previous
// `git fetch --depth=1 origin <ref>` pattern failed for SHAs
// because git treats SHAs as refs in fetch but only if they exist
// in the shallow history, which `--depth=1` does not provide.
function runNpmInstall(ref, repoUrl) {
    console.log(`Fetching source from ${repoUrl} (ref: ${ref})...`);

    const tmpDir = mkdtempSync(join(tmpdir(), "orp-install-"));
    try {
        // Full clone (no --depth). This is a few hundred KB more than
        // a shallow clone but makes every ref type (branch, tag,
        // full or short SHA) work without special handling.
        execSync(`git clone ${repoUrl} .`, { cwd: tmpDir, stdio: "inherit" });
        // Checkout the requested ref. Works for branch names (e.g.
        // `feature/some-branch`), tag names (e.g. `v3.1.6`),
        // and commit SHAs (e.g. `471ce94` or the full 40-char hash).
        // advice.detachedHead=false suppresses the long warning when
        // checking out a tag or SHA, since this is a throwaway clone
        // and the user already knows what they asked for.
        execSync(`git -c advice.detachedHead=false checkout ${ref}`, { cwd: tmpDir, stdio: "inherit" });

        // npm pack outputs to cwd; name the tarball after package.json's
        // "version" field, not after our ref. Discover the actual filename
        // rather than constructing it ourselves.
        execSync("npm pack", { cwd: tmpDir, stdio: "inherit" });
        const tarballs = readdirSync(tmpDir).filter((f) => f.endsWith(".tgz"));
        if (tarballs.length === 0) {
            throw new Error(`npm pack produced no tarball in ${tmpDir}`);
        }
        const tarball = join(tmpDir, tarballs[0]);

        // Only now that we have a tarball, remove the existing install.
        // This avoids the user-facing disaster where a typo in `--ref`
        // (or a network failure mid-fetch) deletes the working CLI.
        const cleanedPath = cleanExistingInstall();
        if (cleanedPath) {
            console.log(`Removed previous install at ${cleanedPath}`);
        }

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
    const markerDir = join(globalRoot, DEFAULT_REPO);
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

async function installStable(ref, current, repoUrl) {
    console.log(`Mode: stable (forcing install of ${ref})`);
    console.log(`Switching to ${ref}...\n`);
    const status = runNpmInstall(ref, repoUrl);
    if (status !== 0) {
        console.error(`\nInstall failed (exit ${status}).`);
        process.exit(status || 1);
    }
    writeInstallMarker("stable", ref);
    console.log(`\nNow on ${ref}.`);
    console.log("Restart OpenCode to apply changes.\n");
}

// Install latest commit on a branch. branch defaults to "main".
// Pass any branch name (e.g. "feature/some-branch") to track a
// pre-release branch instead.
async function installDev(current, branch, ownerRepo, repoUrl) {
    let sha;
    try {
        sha = await fetchLatestCommit(branch, ownerRepo);
    } catch (e) {
        console.error(`Failed to fetch latest commit: ${e.message}`);
        process.exit(1);
    }
    if (!sha) {
        console.error("GitHub API returned no SHA");
        process.exit(1);
    }
    const shortSha = sha.substring(0, 7);
    console.log(`Latest commit on ${branch}: ${shortSha}`);
    console.log(`Update available: v${current} -> ${shortSha} (dev on ${branch})\n`);
    const status = runNpmInstall(sha, repoUrl);
    if (status !== 0) {
        console.error(`\nInstall failed (exit ${status}).`);
        process.exit(status || 1);
    }
    writeInstallMarker("dev", sha);
    console.log(`\nUpdated to dev build at ${shortSha}.`);
    console.log("Restart OpenCode to apply changes.\n");
}

async function upgradeStable(current, ownerRepo, repoUrl) {
    let tag;
    try {
        tag = await fetchLatestStableTag(ownerRepo);
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
    const status = runNpmInstall(tag, repoUrl);
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
    // because `npm install -g <url>#<branch>` hits a npm v11 bug
    // that installs the package without bin symlinks. update.js
    // already does a clean clone+pack+tarball install that sidesteps
    // that bug.
    const refIdx = args.indexOf("--ref");
    const refArg = refIdx !== -1 ? args[refIdx + 1] : null;
    if (refIdx !== -1 && !refArg) {
        console.error("Error: --ref requires a value (branch name, tag, or commit SHA).");
        console.error("Example: opencode-rpc update --ref <branch-name>");
        console.error("         opencode-rpc update --ref v3.1.6");
        console.error("         opencode-rpc update --ref 6664bfb");
        process.exit(2);
    }
    // Reject refs with whitespace, control chars, or anything that
    // cannot appear in a git ref. Catches obvious user errors
    // (forgot a quote, pasted multi-word text) before we do any work.
    if (refArg && /[\s\\<>:"|?*\x00-\x1f]/.test(refArg)) {
        console.error(`Error: --ref value contains invalid characters: ${JSON.stringify(refArg)}`);
        console.error("Expected a single token: branch, tag, or commit SHA.");
        process.exit(2);
    }

    // --dev [BRANCH]: install latest commit on BRANCH. BRANCH is
    // optional; if omitted, default to "main". Lets users track a
    // pre-release branch (e.g. `--dev my-feature-branch`) without
    // having to look up the latest commit SHA themselves.
    let devBranch = null;
    if (isDev) {
        const afterDev = args[args.indexOf("--dev") + 1];
        if (afterDev && !afterDev.startsWith("--")) {
            devBranch = afterDev;
            // Same character class restriction as --ref, for symmetry.
            if (/[\s\\<>:"|?*\x00-\x1f]/.test(devBranch)) {
                console.error(`Error: --dev branch value contains invalid characters: ${JSON.stringify(devBranch)}`);
                process.exit(2);
            }
        }
    }

    // --repo OWNER/REPO: install from a fork instead of the upstream
    // Khip01/opencode-rich-presence. Use this to test your own
    // changes before opening a PR, or to track a personal fork.
    const repoIdx = args.indexOf("--repo");
    const repoArg = repoIdx !== -1 ? args[repoIdx + 1] : null;
    if (repoIdx !== -1 && !repoArg) {
        console.error("Error: --repo requires a value in OWNER/REPO format.");
        console.error("Example: opencode-rpc update --repo myname/opencode-rich-presence --ref my-branch");
        process.exit(2);
    }
    if (repoArg && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repoArg)) {
        console.error(`Error: --repo value must be OWNER/REPO (got: ${JSON.stringify(repoArg)})`);
        console.error("Allowed: letters, digits, dot, underscore, hyphen.");
        process.exit(2);
    }
    const ownerRepo = repoArg || defaultOwnerRepo();
    const repoUrl = repoUrlFor(ownerRepo);

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
    if (repoArg) console.log(`Source repo:    ${ownerRepo}`);

    if (isDev) {
        const branch = devBranch || "main";
        console.log(`Mode: dev (latest commit on ${branch})`);
        console.log("Checking for updates...\n");
        await installDev(current, branch, ownerRepo, repoUrl);
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
        const status = runNpmInstall(refArg, repoUrl);
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
            tag = await fetchLatestStableTag(ownerRepo);
        } catch (e) {
            console.error(`Failed to fetch release info: ${e.message}`);
            process.exit(1);
        }
        if (!tag) {
            console.error("GitHub API returned no tag");
            process.exit(1);
        }
        await installStable(tag, current, repoUrl);
        return;
    }

    console.log("Mode: stable (latest release tag)");
    console.log("Checking for updates...\n");
    await upgradeStable(current, ownerRepo, repoUrl);
}
