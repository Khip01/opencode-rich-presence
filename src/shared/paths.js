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
// Phase 1 redesign: comprehensive chronological activity log. Append-only so the
// user can `tail -f` it while running OpenCode and see exactly what the plugin
// did and what it WOULD have pushed to Discord (Phase 2 adds the actual push).
// Each entry: [ISO timestamp] [tag] message. Tags let you grep for one kind
// of event: state transitions, template renders, SDK events, etc.
export const ACTIVITY_LOG = join(OPENCODE_DIR, "presence-activity.log");

// Debug log uses OS temp directory (cross-platform: /tmp on Linux, /var/folders/... on macOS, %TEMP% on Windows).
export const DEBUG_LOG = join(tmpdir(), "opencode-rich-presence-debug.log");
