# Setup Guide  -  OpenCode Discord Presence (CLI)

##  Prerequisites

- **Discord Desktop App** must be installed and running
  - Web Discord / mobile **NOT supported** (requires IPC socket)
- **Node.js 18+** or **Bun** installed (for worker subprocess and dependency install)
- **OpenCode CLI** latest version

##  Quick Install (Recommended)

```bash
# 1. Clone or download this repo to any directory
# 2. Run the installer
./install

# 3. Edit your config (set Discord Application ID)
nano ~/.config/opencode/discord-config.json

# 4. Restart OpenCode to load the plugin
```

That's it! The installer handles:
- Copying plugin files to `~/.config/opencode/`
- Installing npm dependencies
- Adding the plugin to `~/.config/opencode/opencode.jsonc`

##  Manual Setup

If you prefer to install manually (or the script doesn't work for your setup):

### Step 1: Register Discord Application

1. Open https://discord.com/developers/applications
2. Click **"New Application"** -> give it a name (e.g., "OpenCode Presence")
3. In the left sidebar, click **"Rich Presence"**
4. Upload images in **"Art Assets"**:
   - Recommended: 512x512 PNG/JPG
   - Note the **asset name** (filename without extension)

5. Copy **Application ID** (in "General Information")

### Step 2: Configure Plugin

Choose **one** of the following 3 methods (priority order: A > B > C):

#### Method A: Config File (Recommended )

Create `~/.config/opencode/discord-config.json`:

```bash
mkdir -p ~/.config/opencode
cp config/discord-config.example.json ~/.config/opencode/discord-config.json
nano ~/.config/opencode/discord-config.json
```

Edit content:
```json
{
    "discordAppId": "YOUR_APP_ID_HERE",
    "discordLargeImageKey": "your_asset_name"
}
```

Replace `YOUR_APP_ID_HERE` with the Application ID from Step 1, and `your_asset_name` with the uploaded asset name.

#### Method B: Environment Variable (per shell session)

Add to `~/.bashrc` or `~/.zshrc`:
```bash
export DISCORD_APP_ID="YOUR_APP_ID_HERE"
export DISCORD_LARGE_IMAGE_KEY="your_asset_name"
```

Reload shell: `source ~/.bashrc`

#### Method C: Inline (one-shot)

```bash
DISCORD_APP_ID="YOUR_APP_ID_HERE" opencode
```

### Step 3: Install Plugin Files Manually

If not using `./install`, copy these files manually:

```bash
mkdir -p ~/.config/opencode/plugins

# Copy main plugin
cp opencode-dc-too-rich-presence.js ~/.config/opencode/plugins/

# Copy worker
cp discord-worker.mjs ~/.config/opencode/
chmod +x ~/.config/opencode/discord-worker.mjs

# Copy config (edit after)
cp config/discord-config.example.json ~/.config/opencode/discord-config.json

# Install npm deps
cd ~/.config/opencode && npm install @xhayper/discord-rpc
# or: bun install @xhayper/discord-rpc

# Register plugin in opencode.jsonc
# Add "plugin": ["opencode-dc-too-rich-presence"] to ~/.config/opencode/opencode.jsonc
```

### Step 4: Verify

1. **Start OpenCode:**
   ```bash
   opencode
   ```

2. **Monitor output file** (in another terminal):
   ```bash
   watch -n 1 'tail -15 ~/.config/opencode/presence-state.txt'
   ```

3. **Expected output** (within ~3 seconds):
   ```
    Application ID : YOUR_APP_ID_HERE
    Phase          : 2 (State Collector + Discord RPC)
    Discord        : connected          <- 
    Discord Error  : (none)
   ```

4. **Check your Discord profile** -> activity "OpenCode" should appear with full info.

##  Restart Discord Worker (without restarting OpenCode)

After changing config (App ID, templates, etc.):

```bash
./restart-discord.sh
# or:
~/.config/opencode/restart-discord.sh
```

**How it works:**
1. Script writes a signal file (`~/.config/opencode/.discord-restart-request`) **before** killing the worker
2. Script kills the worker subprocess gracefully (TERM, then KILL if needed)
3. Plugin's exit handler detects the signal file -> knows this is an intentional restart
4. Plugin **reloads config** (picks up any changes you made)
5. Plugin **waits 2 seconds** for old Discord IPC socket to fully release
6. Plugin **spawns new worker** with fresh config (~3 seconds total)

The 2-second delay prevents a brief flicker (disconnect -> reconnect). Without it, the new worker's connection might race with the old worker's socket cleanup. The signal file mechanism is still faster than the 3-second backoff used for unexpected crashes.

### When to Use

-  Changed `discordAppId` in config  -  pick up new App ID without restart
-  Changed templates / customizations  -  apply immediately
-  Discord returned "Server at capacity"  -  retry sooner than backoff
-  Switched currency or display format

### When NOT to Use

If you only need to restart **OpenCode itself** (e.g., changed plugin code), just restart OpenCode normally  -  don't use this script.

##  Running Multiple OpenCode Instances

Discord IPC allows **only ONE active connection per Application ID**. But this plugin handles multiple OpenCode instances automatically:

- **First started** instance becomes the **leader** (pushes to Discord)
- Other instances become **standby** (don't push, just monitor)
- **Auto-switch**: When you run a prompt in any terminal, Discord display automatically follows within ~5 seconds
- **Auto-failover**: If leader dies, a standby instance takes over within 15 seconds

No special setup needed  -  just run `opencode` in multiple terminals.

**To check which is leader:**
```bash
cat ~/.config/opencode/.opencode-dc-too-rich-presence.lock
# Shows {"pid":12345,"started":...}
```

**Example workflow:**
1. Terminal 1: `opencode` (in some project)
2. Terminal 2: `opencode` (in another project)
3. Terminal 3: `opencode` (in another project)
4. Send prompts in any terminal -> Discord switches within 5 seconds
5. File `~/.config/opencode/presence-state.txt` reflects whatever Discord shows

###  Display Stickiness (Busy Protection)

Discord display follows a **busy-protect policy**:
- If current displayed session is **busy** (Working / Thinking / Typing / Asking) -> **keep displaying it**
- If current is **idle** and another becomes busy -> switch to the busy one
- If both idle -> keep current

This prevents "flapping" where the display jumps between terminals. The switch only happens when your current OpenCode is idle and another takes over.

###  Home Mode (Fresh Launch)

When you launch OpenCode without any session yet (or no model loaded), Discord shows a friendly `home` template instead of `?` placeholders:

Default:
- details: `OpenCode`
- state: `Ready`
- largeImageText: `OpenCode`
- smallImageText: `Waiting...`

Customize in `discord-config.json` -> `presence.home`.

##  Uninstall

```bash
./uninstall
```

Removes all installed files and the plugin entry from `opencode.jsonc`.

##  Troubleshooting

See [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md) for common issues.

##  Customization

See [`docs/CUSTOMIZATION.md`](./docs/CUSTOMIZATION.md) for how to customize the Discord presence display (templates, variables, conditional logic, compact number formats, etc.).

##  Where Files Are Installed

| File | Location |
|---|---|
| Main plugin | `~/.config/opencode/plugins/opencode-dc-too-rich-presence.js` |
| Worker (subprocess) | `~/.config/opencode/discord-worker.mjs` |
| Config | `~/.config/opencode/discord-config.json` |
| Restart helper | `~/.config/opencode/restart-discord.sh` |
| npm dependencies | `~/.config/opencode/node_modules/` |
| Output file | `~/.config/opencode/presence-state.txt` |

##  Output File Format

`~/.config/opencode/presence-state.txt` (updated in real-time):

```

 OpenCode Presence State  -  2026-06-21 10:00:00 UTC


DISPLAYED SESSION
  ID        : ses_xxx
  Provider  : Khip01 - 9Router Local
  Model     : minimax-m3
  Mode      : build
  State     : Working
  Started   : 2026-06-21T09:00:00 (1h 0m 0s)
  Context   : 12.3K / 262.1K tokens (4.7%)
  Cost      : $0.0000 ∞
  Prompts   : 6

QUEUE (1 session)
  -> [Working             ] ses_xxx  (1h 0m 0s)


 Application ID : YOUR_APP_ID
 Asset Key      : opencode-logo-too-rich-presence
 Asset Text     : OpenCode
 Phase          : 2 (State Collector + Discord RPC)
 Discord        : connected
 Discord Error  : (none)
 Discord Retries: 0/100
 Last Attempt   : 1s ago
 Models Loaded  : 14
 Output File    : ~/.config/opencode/presence-state.txt

```

### Field Meanings

- **Context**: tokens used / total model capacity (compact format `12.3K / 262.1K`)
- **Cost**: ∞ = free model
- **Prompts**: number of user messages sent in this session
- **Queue**: all sessions, oldest (FIFO) displayed first
- **Models Loaded**: how many model limits loaded from config + provider.list()

Note: Use `{contextCompact}` and `{promptsCompact}` in your templates for large numbers (see CUSTOMIZATION.md).
