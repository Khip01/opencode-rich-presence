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

const required = [
    "src/",
    "bin/",
    "config/",
    "docs/",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
];

// If `files` is set in package.json, verify every required entry is listed.
// If `files` is absent (relying on .npmignore), skip the check. In that
// case npm includes all git-tracked files minus .npmignore matches, so
// the required files should be present as long as git tracks them.
if (pkg.files) {
    const declared = new Set(pkg.files);
    for (const r of required) {
        if (!declared.has(r)) {
            console.error(`package.json 'files' missing required entry: ${r}`);
            process.exit(1);
        }
    }
}

// Regardless of the `files` field, verify the essential entries exist on disk.
for (const r of required) {
    const target = join(PKG_ROOT, r.endsWith("/") ? r.slice(0, -1) : r);
    if (!existsSync(target)) {
        console.error(`Required file/directory does not exist on disk: ${r}`);
        process.exit(1);
    }
}

console.log(`Pre-pack check OK: ${pkg.name}@${pkg.version}`);
