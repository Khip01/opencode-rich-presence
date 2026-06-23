import { platform } from "node:process";
import * as linux from "./linux.js";
import * as macos from "./macos.js";
import * as windows from "./windows.js";

const handlers = {
    linux: linux,
    darwin: macos,
    win32: windows,
};

export async function restartDiscord() {
    const handler = handlers[platform];
    if (!handler) {
        throw new Error(`Unsupported platform: ${platform}`);
    }
    await handler.restartDiscord();
}

export function getPlatformName() {
    return { linux: "linux", darwin: "macos", win32: "windows" }[platform] || platform;
}
