#!/bin/bash
# Restart Discord worker subprocess for opencode-dc-too-rich-presence
#
# Usage: ./restart-discord.sh
#
# This script:
#   1. Writes a "restart request" signal file (so the plugin knows this is intentional)
#   2. Kills the discord-worker.mjs subprocess
#   3. Plugin detects signal file, reloads config, and immediately respawns worker
#
# Useful when:
#   - You changed discord-config.json and want to apply without restarting opencode
#   - Discord returned "Server at capacity" and you want to retry sooner
#   - Worker subprocess got stuck

set -e

WORKER_PATTERN="discord-worker\.mjs"
PLUGIN_NAME="opencode-dc-too-rich-presence"
SIGNAL_FILE="$HOME/.config/opencode/.discord-restart-request"

echo "=== Discord Worker Restart ==="
echo ""

# Step 1: Write signal file FIRST so plugin knows this is an intentional restart
# (vs an unexpected worker crash, which uses normal 3-second backoff respawn)
touch "$SIGNAL_FILE"
echo "Restart signal written: $SIGNAL_FILE"

# Step 2: Check if worker is running and kill it
if pgrep -f "$WORKER_PATTERN" > /dev/null; then
    echo ""
    echo "Found running worker(s):"
    pgrep -af "$WORKER_PATTERN" | head -5

    echo ""
    echo "Killing workers gracefully..."
    pkill -TERM -f "$WORKER_PATTERN" 2>/dev/null
    sleep 2

    if pgrep -f "$WORKER_PATTERN" > /dev/null; then
        echo "Still running, force killing..."
        pkill -KILL -f "$WORKER_PATTERN" 2>/dev/null
        sleep 1
    fi

    if pgrep -f "$WORKER_PATTERN" > /dev/null; then
        echo "ERROR: Workers still running"
        exit 1
    fi

    echo "Workers stopped"
else
    echo "No running workers found"
    # Signal file still there — plugin will pick it up on next event
fi

echo ""
echo "=== Current Discord Config ==="
CONFIG_FILE="$HOME/.config/opencode/discord-config.json"
if [ -f "$CONFIG_FILE" ]; then
    echo "Config file: $CONFIG_FILE"
    APP_ID=$(grep -o '"discordAppId"[[:space:]]*:[[:space:]]*"[^"]*"' "$CONFIG_FILE" | sed 's/.*"\([^"]*\)"$/\1/')
    ASSET=$(grep -o '"discordLargeImageKey"[[:space:]]*:[[:space:]]*"[^"]*"' "$CONFIG_FILE" | sed 's/.*"\([^"]*\)"$/\1/')
    echo "  App ID : ${APP_ID:-<not set>}"
    echo "  Asset  : ${ASSET:-<not set>}"
else
    echo "Config file not found: $CONFIG_FILE"
    echo "  Using environment variables or hardcoded fallback"
fi

echo ""
echo "  DISCORD_APP_ID env : ${DISCORD_APP_ID:-<not set>}"
echo "  DISCORD_LARGE_IMAGE_KEY env : ${DISCORD_LARGE_IMAGE_KEY:-<not set>}"

echo ""
echo "=== Next Steps ==="
echo "Plugin detected restart signal."
echo "1. Waiting 2s for old IPC socket to release..."
echo "2. Reloading config..."
echo "3. Spawning new worker..."
echo ""
echo "Monitor with:"
echo "  watch -n 1 'tail -15 ~/.config/opencode/presence-state.txt'"
echo ""
echo "Expected output within 7 seconds:"
echo "  Discord        : connected"
echo "  Discord Error  : (none)"
