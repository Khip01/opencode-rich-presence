import { install } from "./install.js";
import { uninstall } from "./uninstall.js";
import { restart } from "./restart.js";
import { update } from "./update.js";
import { info } from "./info.js";
import { help } from "./help.js";
import { version } from "./version.js";

const COMMANDS = {
    install,
    uninstall,
    restart,
    update,
    info,
    help,
    version,
    "--help": help,
    "-h": help,
    "--version": version,
    "-v": version,
};

export async function run(argv) {
    const cmd = argv[0];
    const args = argv.slice(1);

    if (!cmd) {
        await help();
        return;
    }

    const handler = COMMANDS[cmd];
    if (!handler) {
        console.error(`Unknown command: ${cmd}`);
        console.error(`Run 'opencode-rpc help' for usage.`);
        process.exit(2);
    }

    await handler(args);
}
