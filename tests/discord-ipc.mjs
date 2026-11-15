#!/usr/bin/env node
// Deterministic Discord IPC error-path tests. These use an injected socket
// object so they can force callback and synchronous write failures without
// relying on OS timing or a running Discord Desktop process.

import { DiscordIPC } from "../src/worker/discord-ipc.mjs";

let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        passed++;
        console.log(`  PASS: ${message}`);
    } else {
        failed++;
        console.log(`  FAIL: ${message}`);
    }
}

async function scenario(name, callback) {
    console.log(`\n=== ${name} ===`);
    try {
        await callback();
    } catch (error) {
        failed++;
        console.log(`  ERROR: ${error?.stack || error}`);
    }
}

await scenario("write callback failure marks Discord IPC disconnected", async () => {
    const client = new DiscordIPC({ clientId: "ipc-test" });
    let disconnects = 0;
    let reason = "";
    let destroyed = false;
    let writes = 0;
    client.onDisconnected((value) => {
        disconnects++;
        reason = String(value);
    });
    client.socket = {
        writable: true,
        destroyed: false,
        write(_frame, callback) {
            writes++;
            callback(new Error("injected callback failure"));
        },
        destroy() {
            destroyed = true;
            this.destroyed = true;
            this.writable = false;
        },
    };
    client.connected = true;

    const sent = await client.clearActivity();
    assert(sent === false, "clearActivity returns false after a write callback failure");
    assert(writes === 1, "the failed frame is written once");
    assert(client.connected === false && client.socket === null, "client marks the connection disconnected");
    assert(destroyed, "failed socket is destroyed");
    assert(disconnects === 1 && reason.includes("write error"), "disconnect callback receives the write error");

    client._markDisconnected("late close event");
    assert(disconnects === 1, "a later close event does not notify twice");
});

await scenario("synchronous socket write failure is handled", async () => {
    const client = new DiscordIPC({ clientId: "ipc-test" });
    let disconnects = 0;
    client.onDisconnected(() => { disconnects++; });
    client.socket = {
        writable: true,
        destroyed: false,
        write() {
            throw new Error("injected synchronous failure");
        },
        destroy() {
            this.destroyed = true;
            this.writable = false;
        },
    };
    client.connected = true;

    const sent = await client.clearActivity();
    assert(sent === false, "clearActivity returns false after a synchronous write failure");
    assert(client.connected === false && disconnects === 1, "synchronous failure triggers one disconnect transition");
});

console.log("\n=== Summary ===");
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
if (failed > 0) process.exit(1);
console.log("  DISCORD IPC ERROR HARNESS: PASSED");
