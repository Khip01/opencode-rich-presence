import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export async function version() {
    try {
        const pkgPath = join(dirname(dirname(fileURLToPath(import.meta.url))), "..", "package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        console.log(`${pkg.name} v${pkg.version}`);
    } catch {
        console.log("opencode-rich-presence (unknown version)");
    }
}
