# Troubleshooting

##  How to Diagnose Issues

First step: view the output file:
```bash
cat ~/.config/opencode/presence-state.txt
```

Look at the `Discord Error` and `Discord        :` fields for quick info.

For deeper debugging, enable logging:
```bash
export OPENCODE_DC_TOO_RICH_DEBUG=true
opencode
```

Log `[opencode-dc-too-rich-presence]` will appear in OpenCode console.

---

##  Discord Status: `disconnected`

### Discord Error: `Worker exited (code=0)`

**Cause:** Worker subprocess spawn failed or exited prematurely.

**Fix:**
1. Make sure Node.js is installed: `node --version`
 2. Check if `discord-worker.mjs` exists:
   ```bash
   ls -la ~/.config/opencode/discord-worker.mjs
   ```
   If missing, run `./install` again from the project directory.
3. Restart OpenCode

### Discord Error: `discord connect timed out after 8000ms`

**Cause:** Worker can't connect to Discord within 8 seconds.

**Fix:**
1. **Make sure Discord Desktop is running** (check taskbar/system tray)
2. **Restart Discord** (quit & reopen)
3. Check Discord logs:
   - Linux: `~/.config/discord/logs/`
4. Check IPC socket exists:
   ```bash
   ls -la /run/user/$(id -u)/discord-ipc-0
   ```

### Discord Error: `Server at capacity` (or code 1006)

**Cause:** Discord rate-limit for your Application ID.

**Fix:**
1. **Wait 15-30 minutes** then try again
2. Or **register a new App ID** at Discord Dev Portal
3. Update config file with the new App ID

---

##  Multi-Instance Issues (Multiple OpenCode Running)

### Discord Status: `disconnected` + `Error: Standby (another instance is active)`

**This is NORMAL behavior.** When you have multiple OpenCode instances running:
- **One** becomes "leader" and pushes to Discord -> `Discord: connected`
- **Others** become "standby** -> `Discord: disconnected, Error: Standby (another instance is active)`

This prevents Discord IPC conflicts (only 1 connection allowed per App ID).

###  Auto-Switch Between Terminals (NEW!)

The leader instance has **global visibility**  -  it polls all sessions across all terminals every 5 seconds. So when you run a prompt in one terminal, Discord automatically switches to show that terminal within ~5 seconds.

How it works:
1. Each OpenCode process has its own plugin instance
2. Each instance only receives events for ITS OWN sessions
3. The leader compensates by polling `session.list()` every 5 seconds
4. For each session, fetches latest message to determine activity
5. Most recently active session becomes the displayed one

**If Discord doesn't switch when you change terminals:**
- Wait 5-10 seconds (next poll cycle)
- Check state file shows the new active session
- If still stuck, leader may have died (check lock file)

### Checking Which Instance is Leader

```bash
ls -la ~/.config/opencode/.opencode-dc-too-rich-presence.lock
cat ~/.config/opencode/.opencode-dc-too-rich-presence.lock
# {"pid":12345,"started":1234567890}  <- leader's PID
```

**Leader election logic:**
- First OpenCode to start becomes leader (acquires lock)
- Leader sends heartbeat every 5 seconds (updates lock timestamp)
- If leader dies (no heartbeat for 15s), another instance steals lock

### Discord Status: `disconnected` with high retry count, but I only have ONE OpenCode

**Cause:** Your **App ID is being rejected by Discord**.

**Quick test:**
```bash
node -e "
import('node:net').then(({default: net}) => {
  const s = net.createConnection('/run/user/1000/discord-ipc-0');
  s.on('connect', () => {
    const payload = Buffer.from(JSON.stringify({v:1, client_id:'YOUR_APP_ID'}));
    const buf = Buffer.alloc(8 + payload.length);
    buf.writeUInt32LE(0, 0);
    buf.writeUInt32LE(payload.length, 4);
    payload.copy(buf, 8);
    s.write(buf);
  });
  s.on('data', d => { console.log('Response:', d.toString().substring(0, 200)); s.destroy(); });
  s.on('error', e => console.log('Error:', e.message));
  setTimeout(() => process.exit(0), 5000);
});
"
```

Replace `YOUR_APP_ID` with your actual App ID.

- **If you see `READY`**: App ID is valid, problem is something else
- **If you see `capacity`**: Wait 15-30 minutes, then retry
- **If timeout (no response)**: App ID is invalid/deprecated, create a new one

---

##  Restart Script Issues

### `./restart-discord.sh` doesn't work / Discord stays disconnected

**Cause:** The script uses a signal file mechanism. The plugin reads the file when worker exits to know it's an intentional restart (vs crash).

**Fix:**
1. Make sure the plugin has been restarted at least once since install (to load the signal file handler)
2. The restart script:
   ```bash
   touch ~/.config/opencode/.discord-restart-request
   pkill -TERM -f "discord-worker\.mjs"
   ```
3. Wait 3-5 seconds for plugin to detect exit, reload config, and respawn worker
4. Check state file: should show `Discord: connected` after ~3 seconds

**If still not working after 30 seconds:**
```bash
# Check if worker process is running
ps aux | grep discord-worker | grep -v grep

# Check opencode log
tail -50 ~/.local/share/opencode/log/opencode.log | grep discord

# Try manual restart of OpenCode itself
pkill -f "opencode -s"
# Then start OpenCode again
```

### `restart-discord.sh` says "Workers stopped" but Discord stays disconnected

**Possible causes:**
1. **Plugin still has old code**  -  need to restart OpenCode to load latest plugin code
2. **App ID rejected**  -  see "Multi-Instance Issues" section above
3. **Config error**  -  run `./install` again to ensure config file is valid

**Note about restart timing:**
The plugin now has a **built-in 2-second delay** during intentional restarts. This allows the old worker's Discord IPC socket to fully release before spawning a new one. Expected total time: ~3-5 seconds after running the script.

**If the display briefly flashes (connect -> disconnect) instead of staying connected:**
The old worker's IPC socket wasn't fully released. Use the explicit cleanup approach:
```bash
pkill -KILL -f "discord-worker.mjs" 2>/dev/null
sleep 3
~/.config/opencode/restart-discord.sh
```
But this should not be needed in normal operation  -  the built-in 2s delay handles it.

**To force full reload:**
```bash
pkill -f "discord-worker.mjs"
pkill -f "opencode -s"
# Wait 5 seconds for clean shutdown
sleep 5
# Start fresh
opencode
```

---

##  Output File Not Updating

### Plugin Loaded But File Static

**Cause:** Plugin loaded but events not firing.

**Fix:**
1. Trigger events in OpenCode:
   - Send a prompt
   - Or run a tool
2. Check debug log: `OPENCODE_DC_TOO_RICH_DEBUG=true opencode`
3. Make sure no errors in OpenCode console

### Plugin Doesn't Load At All

**Fix:**
1. Check plugin file exists:
   ```bash
   ls -la ~/.config/opencode/plugins/opencode-dc-too-rich-presence.js
   ```
2. Check syntax: `node --check ~/.config/opencode/plugins/opencode-dc-too-rich-presence.js`
3. Check OpenCode log: `tail -50 ~/.local/share/opencode/log/opencode.log`

---

##  Context Token Doesn't Match OpenCode UI

**Symptom:** Context % in output file differs from OpenCode TUI.

**Cause:** OpenCode UI updates real-time per token. Plugin updates per event.

**Fix:**
- Plugin typically matches within **±2%** after message completes
- For real-time precision, would need direct integration with OpenCode internal state (not feasible via plugin API)

---

##  Discord Logo Doesn't Appear

**Symptom:** Discord activity appears but without image.

**Fix:**
1. Verify asset uploaded in Discord Dev Portal:
   - https://discord.com/developers/applications/YOUR_APP_ID/rich-presence/assets
2. Verify `Asset Key` in config file matches the name in Dev Portal
3. Asset key is **case-sensitive**

---

##  `Could not connect to Discord client`

**Cause:** `process.execPath` in plugin context is `opencode.exe`, not `node`.

**Fix:**
- Plugin auto-detects node binary
- Make sure Node.js is installed and accessible
- Verify `node --version` works in terminal

---

##  "no space left on device" in /tmp

**Cause:** `/tmp` (usually tmpfs) is full.

**Fix:**
```bash
# Check usage
df -h /tmp

# Find large files
du -sh /tmp/* 2>/dev/null | sort -rh | head -10

# Be careful what you delete - don't remove system files
```

---

##  Plugin Crash / OpenCode Stuck

**Symptom:** OpenCode hangs or becomes "not responding".

**Fix:**
1. Disable plugin temporarily:
   - Edit `~/.config/opencode/opencode.jsonc`
   - Remove line `"plugin": ["opencode-dc-too-rich-presence"]`
2. Restart OpenCode -> should be normal
3. Check plugin log for errors: `tail ~/.local/share/opencode/log/opencode.log`
4. Report bug with the log

---

##  Full Reset

If everything is broken, the easiest path is to use the install/uninstall scripts:

```bash
# Uninstall completely
./uninstall

# Reinstall fresh
./install

# Edit your config
nano ~/.config/opencode/discord-config.json

# Start OpenCode
opencode
```

If you prefer manual reset:

```bash
# 1. Kill OpenCode
pkill -9 -f "opencode -s"

# 2. Remove plugin from opencode.jsonc
sed -i '/opencode-dc-too-rich-presence/d' ~/.config/opencode/opencode.jsonc

# 3. Remove installed files
rm -rf ~/.config/opencode/plugins/opencode-dc-too-rich-presence.js
rm -f ~/.config/opencode/discord-worker.mjs
rm -f ~/.config/opencode/discord-config.json
rm -f ~/.config/opencode/restart-discord.sh

# 4. Reinstall (from project directory)
./install

# 5. Edit config
nano ~/.config/opencode/discord-config.json

# 6. Start
opencode
```
