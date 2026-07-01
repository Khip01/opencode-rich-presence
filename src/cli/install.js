import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, lstatSync, symlinkSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { OPENCODE_DIR, CONFIG_PATH } from "../shared/paths.js";
import { confirm, question } from "./prompt.js";

const PKG_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const EXAMPLE_CONFIG = join(PKG_ROOT, "config", "discord-config.example.json");
const PLUGIN_NAME = "opencode-rich-presence";
const REQUIRED_DEP = "@xhayper/discord-rpc";
const REQUIRED_DEP_VERSION = "1.3.4";
const PLUGIN_ENTRY_RELATIVE = "src/plugin/index.js";

export async function install() {
    console.log("\nopencode-rich-presence installer\n");

    if (!existsSync(OPENCODE_DIR)) {
        console.log(`Creating OpenCode config directory: ${OPENCODE_DIR}`);
        mkdirSync(OPENCODE_DIR, { recursive: true });
    }

    if (existsSync(CONFIG_PATH)) {
        const ok = await confirm(`Config exists at ${CONFIG_PATH}. Overwrite?`, { defaultYes: false });
        if (!ok) {
            console.log("Keeping existing config.");
        } else {
            copyExample();
        }
    } else {
        copyExample();
    }

    await maybeMigrateRemoveFromOpencodeConfig();
    await installLocalPlugin();
    await ensureDependencies();

    printNextSteps();
}

function copyExample() {
    if (!existsSync(EXAMPLE_CONFIG)) {
        console.error(`Example config not found: ${EXAMPLE_CONFIG}`);
        process.exit(1);
    }
    copyFileSync(EXAMPLE_CONFIG, CONFIG_PATH);
    console.log(`Created ${CONFIG_PATH}`);
}

// JSONC-tolerant parser. Strips trailing commas and line/block comments.
// Uses a negative lookbehind on `:` so `://` in URLs is not treated as a comment.
function parseJsonc(raw) {
    const stripped = raw
        .replace(/(?<!:)\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(stripped);
}

// Find the OpenCode config file. Prefer .jsonc (current OpenCode convention).
function findOpencodeConfig() {
    const jsonc = join(OPENCODE_DIR, "opencode.jsonc");
    const json = join(OPENCODE_DIR, "opencode.json");
    if (existsSync(jsonc)) return jsonc;
    if (existsSync(json)) return json;
    return null;
}

// Migration helper for v2.0.5-era installs. Earlier versions of `install` added
// `opencode-rich-presence` to the `plugin` array in `opencode.jsonc` (or `.json`).
// OpenCode reads that array as a list of npm packages to fetch on startup, so the
// entry caused a 404 every time OpenCode launched. v2.0.6+ relies on the symlink
// in `~/.config/opencode/plugins/` alone and never writes the entry. This function
// detects any stale entry left over from earlier installs and offers to remove it.
async function maybeMigrateRemoveFromOpencodeConfig() {
    console.log("");
    const existing = findOpencodeConfig();
    if (!existing) return;

    const raw = readFileSync(existing, "utf-8");
    if (!raw.includes(`"${PLUGIN_NAME}"`)) return;

    let parsed;
    try {
        parsed = parseJsonc(raw);
    } catch (e) {
        console.log(`  Could not parse ${existing} as JSON/JSONC.`);
        console.log(`  Remove "${PLUGIN_NAME}" from the "plugin" array manually to silence`);
        console.log(`  the npm 404 notification on OpenCode startup.`);
        return;
    }

    if (!Array.isArray(parsed.plugin) || !parsed.plugin.includes(PLUGIN_NAME)) return;

    const ok = await confirm(
        `Remove stale "${PLUGIN_NAME}" entry from ${existing}? (causes npm 404 on OpenCode startup)`,
        { defaultYes: true },
    );
    if (!ok) {
        console.log(`  Skipped. Remove "${PLUGIN_NAME}" from the "plugin" array manually.`);
        return;
    }

    parsed.plugin = parsed.plugin.filter((p) => p !== PLUGIN_NAME);
    writeFileSync(existing, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
    console.log(`  Updated ${existing}`);
}

// Place the plugin file in OpenCode's global plugins directory so OpenCode loads it
// directly from disk. This bypasses the npm registry entirely (the package is not
// published there) and works on any host that has the global npm install.
//
// We symlink rather than copy so the local plugin reflects updates after
// `npm update -g opencode-rich-presence` without a separate re-install step.
async function installLocalPlugin() {
    console.log("");
    const pluginsDir = join(OPENCODE_DIR, "plugins");
    const entry = join(PKG_ROOT, PLUGIN_ENTRY_RELATIVE);
    const link = join(pluginsDir, `${PLUGIN_NAME}.js`);

    if (!existsSync(entry)) {
        console.log(`  Plugin entry not found at ${entry}. Skipping local install.`);
        return;
    }

    // Check if already linked correctly.
    if (existsSync(link)) {
        try {
            const target = readlinkTarget(link);
            if (target === entry) {
                console.log(`  Plugin already linked at ${link}`);
                return;
            }
        } catch {}
        // Existing entry is wrong: replace it (after asking).
        const ok = await confirm(`  Replace existing ${link}?`, { defaultYes: true });
        if (!ok) {
            console.log(`  Skipped. Remove ${link} manually to retry.`);
            return;
        }
        unlinkSync(link);
    } else {
        if (!existsSync(pluginsDir)) mkdirSync(pluginsDir, { recursive: true });
    }

    symlinkSync(entry, link);
    console.log(`  Linked ${link}`);
    console.log(`    -> ${entry}`);
}

function readlinkTarget(p) {
    return require("node:fs").readlinkSync(p);
}

// Ensure @xhayper/discord-rpc is available in ~/.config/opencode/node_modules/ so the
// worker subprocess (loaded from a symlinked path) can resolve it. OpenCode already
// manages its own deps in this package.json, so we only add what is missing.
async function ensureDependencies() {
    console.log("");
    const pkgPath = join(OPENCODE_DIR, "package.json");
    let pkg = { dependencies: {} };
    let hadFile = false;
    if (existsSync(pkgPath)) {
        hadFile = true;
        try { pkg = JSON.parse(readFileSync(pkgPath, "utf-8")); } catch {}
    }
    pkg.dependencies = pkg.dependencies || {};

    if (pkg.dependencies[REQUIRED_DEP] === REQUIRED_DEP_VERSION) {
        console.log(`  ${REQUIRED_DEP} already present in ${pkgPath}`);
        return;
    }

    pkg.dependencies[REQUIRED_DEP] = REQUIRED_DEP_VERSION;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
    console.log(`  Updated ${pkgPath} (added ${REQUIRED_DEP})`);

    console.log(`  Running npm install in ${OPENCODE_DIR}...`);
    try {
        execSync("npm install --no-audit --no-fund", { cwd: OPENCODE_DIR, stdio: "inherit" });
        console.log(`  Installed dependencies.`);
    } catch (e) {
        console.log(`  npm install failed: ${e.message}`);
        console.log(`  You can run it manually later: cd ${OPENCODE_DIR} && npm install`);
    }
}

function printNextSteps() {
    console.log("\nNext steps:\n");

    // Only suggest editing the config if it exists without a Discord App ID
    // (the default placeholder is NOT_CONFIGURED, the working default is the
    // developer's verified App ID). A user with a working config already
    // knows their setup.
    const existing = readJsoncSafe(CONFIG_PATH);
    const hasAppId = existing && existing.discordAppId && existing.discordAppId !== "NOT_CONFIGURED";
    if (!hasAppId) {
        console.log("1. (Optional) Edit your config to set your Discord App ID:");
        console.log(`   ${CONFIG_PATH}`);
        console.log("");
    }

    console.log(`${hasAppId ? "1" : "2"}. Restart OpenCode. The plugin loads from a symlink at:`);
    console.log(`   ~/.config/opencode/plugins/opencode-rich-presence.js`);
    console.log(`   pointing to the installed package entry file in your npm prefix.`);
    console.log("");
    console.log("Run `opencode-rpc info` anytime to check status.");
}

// JSONC-tolerant read used for detecting existing config state.
function readJsoncSafe(path) {
    try {
        const raw = readFileSync(path, "utf-8");
        const stripped = raw
            .replace(/(?<!:)\/\/.*$/gm, "")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/,(\s*[}\]])/g, "$1");
        return JSON.parse(stripped);
    } catch { return null; }
}
