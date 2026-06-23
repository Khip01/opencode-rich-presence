import { existsSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import { homedir } from "node:os";

const CANDIDATES = [
    "/usr/bin/discord",
    "/usr/local/bin/discord",
    "/opt/discord/discord",
    "/snap/bin/discord",
    "/var/lib/flatpak/exports/bin/com.discordapp.Discord",
];

function findBinary() {
    const home = homedir();
    const withHome = CANDIDATES.map((c) =>
        c.startsWith("~/") ? c.replace("~", home) : c
    );
    const flatpakUser = `${home}/.local/share/flatpak/exports/bin/com.discordapp.Discord`;
    const all = [...withHome, flatpakUser];
    return all.find((p) => existsSync(p));
}

function listPids() {
    try {
        const out = execSync("ps -eo pid,comm", { encoding: "utf-8" });
        return out
            .split("\n")
            .slice(1)
            .filter((l) => /[Dd]iscord/.test(l))
            .map((l) => parseInt(l.trim().split(/\s+/)[0], 10))
            .filter((n) => Number.isFinite(n) && n > 0);
    } catch {
        return [];
    }
}

export async function restartDiscord() {
    const pids = listPids();
    if (pids.length) {
        try { execSync(`kill -TERM ${pids.join(" ")}`); } catch {}
        await new Promise((r) => setTimeout(r, 2000));
        try { execSync(`kill -KILL ${pids.join(" ")} 2>/dev/null || true`); } catch {}
    }

    const bin = findBinary();
    if (!bin) {
        console.warn("Discord binary not found in common locations. Start Discord manually.");
        return;
    }

    const child = spawn(bin, [], { detached: true, stdio: "ignore" });
    child.unref();
}
