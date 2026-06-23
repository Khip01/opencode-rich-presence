import { execSync } from "node:child_process";

export async function restartDiscord() {
    try {
        execSync(`osascript -e 'tell application "Discord" to quit'`, { stdio: "ignore" });
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
    try { execSync(`pkill -x Discord 2>/dev/null || true`); } catch {}
    try {
        execSync(`open -a Discord`, { stdio: "ignore" });
    } catch (e) {
        console.warn(`Could not relaunch Discord: ${e.message}`);
    }
}
