#!/usr/bin/env node
// Cross-platform lifecycle tests for the daemon's client IPC connections.
// A local mock Discord IPC server lets the harness assert real
// SET_ACTIVITY frames without requiring Discord Desktop.

import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const sandbox = mkdtempSync(join(tmpdir(), "orp-life-"));
process.env.OPENCODE_CONFIG_DIR = sandbox;
process.env.XDG_RUNTIME_DIR = sandbox;
process.env.DISCORD_APP_ID = "daemon-lifecycle-test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const DAEMON_PATH = join(REPO_ROOT, "src", "worker", "daemon.mjs");
const { DAEMON_SOCKET, DAEMON_PID_FILE, ACTIVITY_LOG } = await import("../src/shared/paths.js");
const { isDaemonReady, isPidAlive, unlinkSocketPath } = await import("../src/shared/daemon-liveness.js");

const IDLE_CLEAR_DELAY_MS = 3000;
const MOCK_DISCORD_SOCKET = process.platform === "win32"
    ? "\\\\.\\pipe\\discord-ipc-0"
    : join(sandbox, "discord-ipc-0");

let passed = 0;
let failed = 0;
let daemon = null;
let mockDiscord = null;
let lateExitProcess = null;
const mockDiscordSockets = new Set();
const discordCommands = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition, message) {
    if (condition) {
        passed++;
        console.log(`  PASS: ${message}`);
    } else {
        failed++;
        console.log(`  FAIL: ${message}`);
    }
}

function readLog() {
    try { return readFileSync(ACTIVITY_LOG, "utf-8"); } catch { return ""; }
}

function discordFrame(opcode, payload) {
    const body = Buffer.from(JSON.stringify(payload));
    const frame = Buffer.alloc(8 + body.length);
    frame.writeUInt32LE(opcode, 0);
    frame.writeUInt32LE(body.length, 4);
    body.copy(frame, 8);
    return frame;
}

function startMockDiscord() {
    mockDiscord = net.createServer((socket) => {
        mockDiscordSockets.add(socket);
        socket.once("close", () => mockDiscordSockets.delete(socket));
        let buffer = Buffer.alloc(0);
        socket.on("data", (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            while (buffer.length >= 8) {
                const opcode = buffer.readUInt32LE(0);
                const length = buffer.readUInt32LE(4);
                if (buffer.length < 8 + length) return;
                const payload = buffer.subarray(8, 8 + length);
                buffer = buffer.subarray(8 + length);

                if (opcode === 0) {
                    socket.write(discordFrame(1, { cmd: "DISPATCH", evt: "READY", data: {} }));
                } else if (opcode === 1) {
                    try { discordCommands.push(JSON.parse(payload.toString("utf-8"))); } catch {}
                }
            }
        });
    });

    return new Promise((resolve, reject) => {
        mockDiscord.once("error", reject);
        mockDiscord.listen(MOCK_DISCORD_SOCKET, resolve);
    });
}

async function waitFor(predicate, timeoutMs, description) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (predicate()) return true;
        await sleep(50);
    }
    console.log(`  TIMEOUT: ${description}`);
    return false;
}

async function waitForLog(fragment, startIndex, timeoutMs, description) {
    return await waitFor(
        () => readLog().slice(startIndex).includes(fragment),
        timeoutMs,
        description,
    );
}

function activityFrames() {
    return discordCommands.filter((command) =>
        command.cmd === "SET_ACTIVITY" && command.args?.activity,
    );
}

function clearFrames() {
    return discordCommands.filter((command) =>
        command.cmd === "SET_ACTIVITY" && command.args && !command.args.activity,
    );
}

function hasPresence(details) {
    return activityFrames().some((frame) => frame.args.activity.details === details);
}

async function spawnDeadPid() {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const pid = child.pid;
    await new Promise((resolve) => child.once("exit", resolve));
    await waitFor(() => !isPidAlive(pid), 1000, "child PID to become dead");
    return pid;
}

async function connectClient(pid) {
    const deadline = Date.now() + 10000;
    let lastError = null;
    while (Date.now() < deadline) {
        const socket = net.createConnection(DAEMON_SOCKET);
        try {
            await new Promise((resolve, reject) => {
                socket.once("connect", resolve);
                socket.once("error", reject);
            });
            socket.write(JSON.stringify({ type: "hello", pid }) + "\n");
            return socket;
        } catch (error) {
            lastError = error;
            try { socket.destroy(); } catch {}
            await sleep(100);
        }
    }
    throw new Error(`could not connect lifecycle client: ${lastError?.message || lastError}`);
}

function sendState(socket, pid, sessionID, details) {
    socket.write(JSON.stringify({
        type: "state",
        pid,
        session: { sessionID, state: "Working", lastActivity: Date.now() },
        rendered: { details, state: "Working", largeImageKey: "test" },
    }) + "\n");
}

function sendGoodbye(socket, pid) {
    socket.write(JSON.stringify({ type: "goodbye", pid }) + "\n");
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

try {
    await startMockDiscord();
    daemon = spawn(process.execPath, [DAEMON_PATH], {
        stdio: ["ignore", "ignore", "ignore"],
        env: { ...process.env },
    });

    const daemonReady = await waitFor(() => isDaemonReady(), 10000, "daemon to listen");
    assert(daemonReady, "daemon listens on the platform IPC address");
    if (!daemonReady) throw new Error("daemon failed to start");

    const discordReady = await waitFor(
        () => readLog().includes("Discord connected (appId=daemon-lifecycle-test)"),
        10000,
        "mock Discord handshake",
    );
    assert(discordReady, "daemon connects to the mock Discord IPC server");
    if (!discordReady) throw new Error("mock Discord handshake failed");

    await scenario("Abrupt close with an already-dead PID clears real Discord activity", async () => {
        const pid = await spawnDeadPid();
        const logStart = readLog().length;
        const clearStart = clearFrames().length;
        const socket = await connectClient(pid);
        sendState(socket, pid, "abrupt-dead", "abrupt dead PID");

        assert(await waitFor(
            () => hasPresence("abrupt dead PID"),
            3000,
            "initial presence push",
        ), "client presence is pushed before disconnect");

        socket.destroy();
        assert(await waitFor(
            () => clearFrames().length > clearStart,
            IDLE_CLEAR_DELAY_MS + 3000,
            "clear frame after abrupt disconnect",
        ), "daemon sends a real clear SET_ACTIVITY frame after the debounce");
        assert(await waitForLog(
            "last client process exited; clearing Discord presence",
            logStart,
            IDLE_CLEAR_DELAY_MS + 1000,
            "idle clear decision log",
        ), "daemon records the idle-clear decision");
    });

    await scenario("Live PID at first check is rechecked after the process exits", async () => {
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            stdio: "ignore",
        });
        lateExitProcess = child;
        const pid = child.pid;
        const logStart = readLog().length;
        const clearStart = clearFrames().length;
        const socket = await connectClient(pid);
        sendState(socket, pid, "late-exit", "late exiting process");
        assert(await waitFor(
            () => hasPresence("late exiting process"),
            3000,
            "late-exit presence push",
        ), "late-exit client presence is pushed");

        socket.destroy();
        const aliveCheck = await waitForLog(
            `client pid=${pid} disconnected but process is alive; keeping presence`,
            logStart,
            IDLE_CLEAR_DELAY_MS + 2000,
            "first liveness check while child is alive",
        );
        assert(aliveCheck && isPidAlive(pid), "first delayed check observes the client process alive");
        assert(clearFrames().length === clearStart, "no clear is sent while that client process is alive");
        await sleep(IDLE_CLEAR_DELAY_MS - 500);
        assert(isPidAlive(pid), "repeated liveness check still sees the client process alive");
        assert(clearFrames().length === clearStart, "repeated liveness checks do not clear a live process");

        child.kill();
        await new Promise((resolve) => child.once("exit", resolve));
        lateExitProcess = null;
        const clearedAfterExit = await waitFor(
            () => readLog().slice(logStart).includes("last client process exited; clearing Discord presence")
                && clearFrames().length > clearStart,
            7000,
            "clear after the client process exits",
        );
        assert(clearedAfterExit, "daemon eventually clears after the disconnected process exits");
    });

    await scenario("An unregistered socket close does not clear a client's presence", async () => {
        const clearStart = clearFrames().length;
        const socket = net.createConnection(DAEMON_SOCKET);
        await new Promise((resolve, reject) => {
            socket.once("connect", resolve);
            socket.once("error", reject);
        });
        socket.destroy();
        await sleep(IDLE_CLEAR_DELAY_MS + 500);
        assert(clearFrames().length === clearStart, "unregistered connection close does not clear Discord");
    });

    await scenario("Reconnect during debounce cancels the idle clear", async () => {
        const pid = await spawnDeadPid();
        const clearStart = clearFrames().length;
        const first = await connectClient(pid);
        sendState(first, pid, "reconnect-old", "before reconnect");
        const firstPushed = await waitFor(
            () => hasPresence("before reconnect"),
            3000,
            "pre-reconnect push",
        );
        assert(firstPushed, "presence is pushed before reconnect");
        if (!firstPushed) return;
        const closeLogStart = readLog().length;
        first.destroy();
        const firstClosed = await waitForLog(
            `client disconnected: pid=${pid}`,
            closeLogStart,
            2000,
            "first socket close",
        );
        assert(firstClosed, "first client socket closes before reconnect");
        if (!firstClosed) return;
        await sleep(500);

        const reconnected = await connectClient(pid);
        sendState(reconnected, pid, "reconnect-new", "after reconnect");
        const secondPushed = await waitFor(
            () => hasPresence("after reconnect"),
            7000,
            "post-reconnect push",
        );
        assert(secondPushed, "presence resumes after reconnect");
        if (!secondPushed) return;
        await sleep(IDLE_CLEAR_DELAY_MS + 500);
        assert(clearFrames().length === clearStart, "new hello cancels the pending idle clear");

        sendGoodbye(reconnected, pid);
        assert(await waitFor(
            () => clearFrames().length === clearStart + 1,
            2000,
            "normal goodbye clear",
        ), "normal goodbye still clears presence immediately");
        reconnected.destroy();
    });

    await scenario("Multiple clients clear only when the last socket closes", async () => {
        const pidA = await spawnDeadPid();
        const pidB = await spawnDeadPid();
        const clearStart = clearFrames().length;
        const clientA = await connectClient(pidA);
        const clientB = await connectClient(pidB);
        sendState(clientA, pidA, "multi-a", "multi client A");
        const firstPushed = await waitFor(
            () => hasPresence("multi client A"),
            7000,
            "first multi-client presence push",
        );
        assert(firstPushed, "first multi-client presence is pushed");
        if (!firstPushed) return;
        sendState(clientB, pidB, "multi-b", "multi client B");
        const secondPushed = await waitFor(
            () => hasPresence("multi client B"),
            7000,
            "multi-client presence push",
        );
        assert(secondPushed, "second multi-client presence is pushed");
        if (!secondPushed) return;

        clientA.destroy();
        await sleep(IDLE_CLEAR_DELAY_MS + 500);
        assert(clearFrames().length === clearStart, "closing one client does not clear while another remains");

        clientB.destroy();
        assert(await waitFor(
            () => clearFrames().length === clearStart + 1,
            IDLE_CLEAR_DELAY_MS + 3000,
            "clear after final client closes",
        ), "closing the last client clears Discord activity");
    });

    await scenario("The daemon stays alive and accepts a new client after clearing", async () => {
        assert(isDaemonReady(), "daemon remains alive after lifecycle clears");
        const pid = await spawnDeadPid();
        const socket = await connectClient(pid);
        sendState(socket, pid, "after-clear", "client after clear");
        assert(await waitFor(
            () => hasPresence("client after clear"),
            7000,
            "post-clear activity push",
        ), "new client resumes activity on the existing daemon");
        sendGoodbye(socket, pid);
        socket.destroy();
    });
} finally {
    if (lateExitProcess && lateExitProcess.exitCode === null) {
        lateExitProcess.kill("SIGKILL");
        await new Promise((resolve) => lateExitProcess.once("exit", resolve));
    }
    if (daemon && daemon.exitCode === null) {
        daemon.kill("SIGTERM");
        await new Promise((resolve) => daemon.once("exit", resolve));
    }
    for (const socket of mockDiscordSockets) {
        try { socket.destroy(); } catch {}
    }
    if (mockDiscord) await new Promise((resolve) => mockDiscord.close(resolve));
    unlinkSocketPath();
    rmSync(sandbox, { recursive: true, force: true });
}

console.log("\n=== Summary ===");
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
if (failed > 0) process.exit(1);
console.log("  DAEMON LIFECYCLE: PASSED");
