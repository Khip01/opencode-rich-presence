#!/usr/bin/env node
// Unit tests for the bounded clearActivity retry policy.
// The sleep function is injected so failure and recovery paths are fast and
// deterministic instead of waiting for the production backoff.

import { retryClearActivity } from "../src/worker/clear-presence.mjs";

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

await scenario("a failed clear is retried until the frame is written", async () => {
    let calls = 0;
    const sleeps = [];
    const attempts = [];
    const result = await retryClearActivity({
        clearActivity: async () => {
            calls++;
            return calls === 3;
        },
        sleep: async (ms) => { sleeps.push(ms); },
        onAttempt: (attempt) => { attempts.push(attempt); },
    });

    assert(result.sent === true && result.attempt === 3, "third attempt reports a successful clear");
    assert(calls === 3, "clearActivity is called three times");
    assert(sleeps.join(",") === "1000,2000", "production backoff delays are used between attempts");
    assert(attempts[0].sent === false && attempts[1].sent === false && attempts[2].sent === true,
        "attempt results record two failures followed by success");
});

await scenario("three failed clears stop without an infinite retry loop", async () => {
    let calls = 0;
    const sleeps = [];
    const result = await retryClearActivity({
        clearActivity: async () => {
            calls++;
            return false;
        },
        sleep: async (ms) => { sleeps.push(ms); },
    });

    assert(result.sent === false && result.attempt === 3, "final result reports the bounded failure");
    assert(calls === 3, "clearActivity stops after the configured three attempts");
    assert(sleeps.length === 2, "backoff runs only between attempts");
});

await scenario("a disconnected socket stops retrying immediately", async () => {
    let calls = 0;
    let connected = true;
    const sleeps = [];
    const result = await retryClearActivity({
        clearActivity: async () => {
            calls++;
            connected = false;
            return false;
        },
        canRetry: () => connected,
        sleep: async (ms) => { sleeps.push(ms); },
    });

    assert(result.sent === false && result.attempt === 1, "disconnect stops after the first failed write");
    assert(calls === 1 && sleeps.length === 0, "no backoff is scheduled for a disconnected socket");
});

await scenario("thrown clear errors are reported and retried", async () => {
    let calls = 0;
    const attempts = [];
    const result = await retryClearActivity({
        clearActivity: async () => {
            calls++;
            if (calls === 1) throw new Error("injected clear error");
            return true;
        },
        sleep: async () => {},
        onAttempt: (attempt) => { attempts.push(attempt); },
    });

    assert(result.sent === true && result.attempt === 2, "a thrown error can recover on the next attempt");
    assert(attempts[0].error?.message === "injected clear error", "the thrown error is preserved for reporting");
    assert(attempts[1].error === null && calls === 2, "the recovery attempt succeeds without another error");
});

console.log("\n=== Summary ===");
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
if (failed > 0) process.exit(1);
console.log("  CLEAR PRESENCE RETRY HARNESS: PASSED");
