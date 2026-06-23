#!/usr/bin/env node
// Cross-platform syntax check for all JS/MJS files.
// Replaces bash `find ... | while read` which fails on Windows PowerShell.

import { execSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = process.cwd();

function walk(dir, out = []) {
    for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry.startsWith(".")) continue;
        const p = join(dir, entry);
        const s = statSync(p);
        if (s.isDirectory()) walk(p, out);
        else if ([".js", ".mjs"].includes(extname(p))) out.push(p);
    }
    return out;
}

const targets = [
    join(ROOT, "bin", "opencode-rpc.js"),
    ...walk(join(ROOT, "src")),
];

let errors = 0;
for (const f of targets) {
    try {
        execSync(`node --check "${f}"`, { stdio: "pipe" });
        console.log(`  ok: ${f.replace(ROOT + "/", "")}`);
    } catch (e) {
        console.error(`  FAIL: ${f.replace(ROOT + "/", "")}`);
        console.error(e.stderr?.toString() || e.message);
        errors++;
    }
}

if (errors > 0) {
    console.error(`\n${errors} file(s) failed syntax check.`);
    process.exit(1);
}

console.log(`\n${targets.length} file(s) passed syntax check.`);
