import { execSync, spawn } from "node:child_process";

export async function restartDiscord() {
    try { execSync(`taskkill /IM Discord.exe /T /F`, { stdio: "ignore" }); } catch {}
    await new Promise((r) => setTimeout(r, 1000));

    try {
        spawn("cmd", ["/c", "start", "", "Discord"], { detached: true, stdio: "ignore" }).unref();
    } catch (e) {
        console.warn(`Could not relaunch Discord: ${e.message}`);
    }
}
