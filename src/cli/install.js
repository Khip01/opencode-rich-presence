import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { OPENCODE_DIR, CONFIG_PATH } from "../shared/paths.js";
import { confirm, question } from "./prompt.js";

const PKG_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const EXAMPLE_CONFIG = join(PKG_ROOT, "config", "discord-config.example.json");

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

function printNextSteps() {
    const homeCfg = join(homedir(), ".config", "opencode", "opencode.json");
    const homeCfgJsonc = join(homedir(), ".config", "opencode", "opencode.jsonc");

    console.log("\nNext steps:\n");
    console.log("1. (Optional) Edit your config to set Discord App ID and templates:");
    console.log(`   ${CONFIG_PATH}`);
    console.log("");
    console.log("2. Register the plugin with OpenCode by adding it to:");
    if (existsSync(homeCfgJsonc)) {
        console.log(`   ${homeCfgJsonc}  (file exists)`);
    } else if (existsSync(homeCfg)) {
        console.log(`   ${homeCfg}  (file exists)`);
    } else {
        console.log(`   ${homeCfg}  (will be created)`);
    }
    console.log("");
    console.log('   Add this line to the file:');
    console.log('');
    console.log('   {');
    console.log('     "plugin": ["opencode-rich-presence"]');
    console.log('   }');
    console.log("");
    console.log("3. Start OpenCode. The plugin auto-installs via Bun and Discord presence activates.");
    console.log("");
    console.log("Run `rich-presence info` anytime to check status.");
}
