import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// OpenCode standardizes ~/.config/opencode/ across all platforms (Linux, macOS, Windows).
// See: https://opencode.ai/docs/config#global
//
// We honor OPENCODE_CONFIG_DIR env var if set (per OpenCode convention).
export const OPENCODE_DIR = process.env.OPENCODE_CONFIG_DIR
    ? process.env.OPENCODE_CONFIG_DIR
    : join(homedir(), ".config", "opencode");

export const CONFIG_PATH = join(OPENCODE_DIR, "discord-config.json");
export const OUTPUT_FILE = join(OPENCODE_DIR, "presence-state.txt");
export const RESTART_SIGNAL = join(OPENCODE_DIR, ".discord-restart-request");
export const LOCK_FILE = join(OPENCODE_DIR, ".opencode-rich-presence.lock");

// Debug log uses OS temp directory (cross-platform: /tmp on Linux, /var/folders/... on macOS, %TEMP% on Windows).
export const DEBUG_LOG = join(tmpdir(), "opencode-rich-presence-debug.log");

// Worker location relative to package source.
export const WORKER_SOURCE = new URL("../../worker/discord-worker.mjs", import.meta.url).pathname;
