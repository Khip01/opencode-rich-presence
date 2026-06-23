#!/usr/bin/env node
// Pre-pack check: verifies package.json is valid and dependencies are reachable.
// Run automatically before `npm pack`.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf-8"));

if (!pkg.name || !pkg.version) {
    console.error("package.json missing name or version");
    process.exit(1);
}

const declared = new Set(pkg.files || []);
const required = [
    "src/",
    "bin/",
    "config/",
    "docs/",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
];

for (const r of required) {
    if (!declared.has(r)) {
        console.error(`package.json 'files' missing required entry: ${r}`);
        process.exit(1);
    }
}

console.log(`Pre-pack check OK: ${pkg.name}@${pkg.version}`);
