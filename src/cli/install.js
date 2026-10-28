import { existsSync, readFileSync, readlinkSync, writeFileSync, copyFileSync, mkdirSync, lstatSync, symlinkSync, unlinkSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OPENCODE_DIR, CONFIG_PATH } from "../shared/paths.js";
import { confirm } from "./prompt.js";

const PKG_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const EXAMPLE_CONFIG = join(PKG_ROOT, "config", "discord-config.example.json");
const PLUGIN_NAME = "opencode-rich-presence";
// V1 (function export) and V2 (Plugin.define) entries. OpenCode v2 does
// not run V1 implementations and vice versa, so install links exactly one
// of them under the same link name (see detectPluginEntry).
const PLUGIN_ENTRY_V1 = "src/plugin/index.js";
const PLUGIN_ENTRY_V2 = "src/plugin/index.v2.js";
// TUI plugin part (client heartbeat for presence auto-clear). Only the V2
// plugin format has parts; V1 loads a single file and never sees this one.
const PLUGIN_TUI_ENTRY = "src/plugin/index.tui.js";

export async function install() {
    console.log("\nopencode-rich-presence installer\n");
    console.log("Phase 1: local state collector + activity log (no Discord push yet).");

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
// OpenCode v2 changed the plugin API (Plugin.define with id + setup);
// V1 function entries fail to load there and V2 entries fail on V1.
// Probe `opencode --version` and link the matching entry. When no
// OpenCode binary is found (e.g. Desktop-only installs without the CLI
// on PATH), ask instead of guessing: linking the wrong entry loads
// nothing and only logs a warning on every startup.
function detectPluginEntry() {
    const v1 = join(PKG_ROOT, PLUGIN_ENTRY_V1);
    const v2 = join(PKG_ROOT, PLUGIN_ENTRY_V2);
    let major = null;
    try {
        const out = execFileSync("opencode", ["--version"], { encoding: "utf-8", timeout: 10000 });
        const m = out.match(/(\d+)\.\d+\.\d+/);
        if (m) major = parseInt(m[1], 10);
    } catch {}
    if (major !== null) {
        console.log(`  Detected OpenCode v${major} (opencode --version).`);
        return major >= 2 ? v2 : v1;
    }
    return null;
}

async function installLocalPlugin() {
    console.log("");
    const pluginsDir = join(OPENCODE_DIR, "plugins");
    let entry = detectPluginEntry();
    if (!entry) {
        // Version unknown: stay conservative and link the V1 entry.
        // Linking the V2 entry on a v1-only machine loads nothing.
        const useV2 = await confirm("  OpenCode version not detected. Install V2 plugin entry? (No = V1)", { defaultYes: false });
        entry = useV2
            ? join(PKG_ROOT, PLUGIN_ENTRY_V2)
            : join(PKG_ROOT, PLUGIN_ENTRY_V1);
    }
    const link = join(pluginsDir, `${PLUGIN_NAME}.js`);

    if (!existsSync(entry)) {
        console.log(`  Plugin entry not found at ${entry}. Skipping local install.`);
        return;
    }

    if (entry.endsWith("index.v2.js")) {
        await installV2PluginDir(pluginsDir, entry, link);
        return;
    }

    // V1: single-file symlink (the V1 plugin format has no parts).
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
    console.log(`  Linked ${link} (V1 entry)`);
    console.log(`    -> ${entry}`);
}

// V2 installs a plugin directory instead of a single file. OpenCode
// discovers plugin directories under ~/.config/opencode/plugins/ and
// resolves each part by its root file name: `index.js` is the server
// part (or `server.js`), `tui.js` the TUI part (the client heartbeat;
// see docs/ARCHITECTURE.md).
//
// The parts are tiny re-export shim files, not symlinks. Since v2.2.0
// OpenCode silently drops a plugin directory whose resolved entrypoint
// lies outside the directory after symlink resolution (a containment
// check against symlink escapes): a symlinked entrypoint loads nothing
// and logs nothing. A real file inside the directory passes the check
// and re-exports the implementation from the npm install, so
// `npm update -g` is still picked up without re-linking. No
// package.json here on purpose: a manifest with a `name` makes OpenCode
// resolve the parts as package specifiers through node_modules instead
// of as files in this directory.
async function installV2PluginDir(pluginsDir, entry, legacyLink) {
    const pluginDir = join(pluginsDir, PLUGIN_NAME);
    const indexShim = join(pluginDir, "index.js");
    const tuiEntry = join(PKG_ROOT, PLUGIN_TUI_ENTRY);
    const tuiShim = join(pluginDir, "tui.js");

    if (!existsSync(tuiEntry)) {
        console.log(`  TUI part not found at ${tuiEntry}. Skipping local install.`);
        return;
    }

    // Legacy single-file symlink from V2 installs before the directory
    // form. Remove it first: keeping both would load the server part twice.
    if (existsSync(legacyLink)) {
        let isSymlink = false;
        try { isSymlink = lstatSync(legacyLink).isSymbolicLink(); } catch {}
        if (isSymlink) {
            unlinkSync(legacyLink);
            console.log(`  Migrated legacy symlink ${legacyLink} to the directory form`);
        } else {
            console.log(`  Skipped ${legacyLink}: not a symlink (remove manually if unwanted)`);
        }
    }

    // Check if already installed correctly (shim content matches the
    // current npm install path).
    if (shimMatches(indexShim, entry) && shimMatches(tuiShim, tuiEntry)) {
        console.log(`  Plugin already installed at ${pluginDir}`);
        return;
    }

    if (existsSync(pluginDir)) {
        // Earlier forms from this installer (shim files, part symlinks,
        // the short-lived manifest form) are upgraded silently. Anything
        // else is foreign and is only replaced after confirmation.
        if (!isOurPluginDir(pluginDir)) {
            const ok = await confirm(`  Replace existing ${pluginDir}?`, { defaultYes: true });
            if (!ok) {
                console.log(`  Skipped. Remove ${pluginDir} manually to retry.`);
                return;
            }
        }
        rmSync(pluginDir, { recursive: true, force: true });
    } else {
        if (!existsSync(pluginsDir)) mkdirSync(pluginsDir, { recursive: true });
    }

    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(indexShim, shimSource(entry), "utf-8");
    writeFileSync(tuiShim, shimSource(tuiEntry), "utf-8");
    console.log(`  Installed ${pluginDir} (V2 server + TUI parts)`);
    console.log(`    server part: ${entry}`);
    console.log(`    TUI part   : ${tuiEntry}`);
}

// Shim content for one V2 plugin part: a real file inside the plugin
// directory that re-exports the part from the npm install through a
// stable file:// URL (see installV2PluginDir for why not a symlink).
function shimSource(targetPath) {
    const url = pathToFileURL(targetPath).href;
    return `// Generated by \`opencode-rpc install\`; do not edit.\n`
        + `// Re-exports the plugin part from the npm install. Re-run\n`
        + `// \`opencode-rpc install\` after moving the npm install to a new prefix.\n`
        + `export * from "${url}";\n`
        + `export { default } from "${url}";\n`;
}

// A shim file exactly matches the expected content for targetPath and is
// a regular file (a symlink would fail OpenCode's containment check).
function shimMatches(file, targetPath) {
    try {
        if (lstatSync(file).isSymbolicLink()) return false;
        return readFileSync(file, "utf-8") === shimSource(targetPath);
    } catch {
        return false;
    }
}

// True when the plugin directory was created by this installer in any
// generation (shim files, part symlinks, or the manifest form). Foreign
// directories are never replaced without confirmation.
function isOurPluginDir(pluginDir) {
    const indexFile = join(pluginDir, "index.js");
    try {
        if (lstatSync(indexFile).isSymbolicLink()) {
            return readlinkSync(indexFile).includes(PLUGIN_NAME);
        }
    } catch {}
    try {
        if (readFileSync(indexFile, "utf-8").includes(PLUGIN_NAME)) return true;
    } catch {}
    try {
        const manifest = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf-8"));
        if (manifest?.name === PLUGIN_NAME) return true;
    } catch {}
    return false;
}

function readlinkTarget(p) {
    return readlinkSync(p);
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

    console.log(`${hasAppId ? "1" : "2"}. Restart OpenCode. The plugin loads from the plugin directory under:`);
    console.log(`   ~/.config/opencode/plugins/`);
    console.log(`   (re-export shims pointing at the installed package entry files in your npm prefix).`);
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
