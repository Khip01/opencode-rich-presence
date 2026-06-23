# Customization

`discord-config.json` controls everything Discord displays. Edit it to customize your Rich Presence.

## File Location

`~/.config/opencode/discord-config.json`

(OpenCode normalizes this path on Windows too: `%USERPROFILE%\.config\opencode\`)

## Minimal Config

```json
{
  "discordAppId": "YOUR_APP_ID",
  "discordLargeImageKey": "your-asset-key",
  "discordLargeImageText": "OpenCode",
  "currency": "$"
}
```

| Field | Description |
|-------|-------------|
| `discordAppId` | Discord Application ID (required for custom branding; otherwise uses fallback) |
| `discordLargeImageKey` | Rich Presence large image asset key |
| `discordLargeImageText` | Hover text on the large image |
| `currency` | Currency symbol for cost formatting (default `$`) |
| `presence` | Template overrides (see below) |

## Available Variables

| Variable | Example | Description |
|---|---|---|
| `{model}` | `minimax-m3` | Model in use |
| `{mode}` | `build`, `plan` | Agent mode |
| `{state}` | `Working`, `Thinking` | Current state |
| `{provider}` | `Khip01` | Provider name |
| `{sessionId}` | `ses_abc123def` | Full session ID |
| `{id}` | `abc123def` | Last 12 chars of session ID |
| `{elapsed}` | `1h 23m` | Session duration |
| `{context}` | `45,321` | Tokens used (raw) |
| `{contextCompact}` | `45.3K` | Tokens used (compact K/M/B) |
| `{contextFull}` | `87,432` | Total tokens (input+output+cache) |
| `{contextFullCompact}` | `87.4K` | Total tokens (compact) |
| `{contextLimit}` | `262,144` | Model context limit |
| `{contextLimitCompact}` | `262.1K` | Context limit (compact) |
| `{contextPercent}` | `23.7` | Context percentage (1 decimal) |
| `{cost}` | `$0.0042` | Session cost (raw) |
| `{costCompact}` | `$1.5K` | Cost (compact) |
| `{prompts}` | `12` | User prompt count |
| `{promptsCompact}` | `1.5K` | Prompt count (compact) |

### Boolean State Variables

These resolve to `"true"` or `"false"` and are useful for conditionals:

- `{idle}`, `{working}`, `{thinking}`, `{typing}`, `{asking}`, `{waiting}`, `{active}`

## Template Syntax

### Variables

```json
{ "details": "{model} ({mode})" }
```

Result: `minimax-m3 (build)`

### Fallbacks

```json
{ "state": "{elapsed|just started}" }
```

If `elapsed` is undefined, shows `just started` instead of `?`.

### Boolean Conditionals

```json
{
  "state": "{{#if thinking}}Thinking hard{{else}}Idle{{/if}}"
}
```

### Comparison Conditionals

```json
{
  "state": "{{#if contextPercent > 80}}⚠️ {contextPercent}% full{{else}}{contextPercent}% ctx{{/if}}"
}
```

Supported operators: `==`, `!=`, `>=`, `<=`, `>`, `<`.

Quoted strings for value:
```json
{
  "state": "{{#if mode == \"build\"}}Build mode{{else}}Plan mode{{/if}}"
}
```

### Per-State Templates

Customize per state:

```json
{
  "presence": {
    "byState": {
      "Waiting for command": {
        "details": "{model} · idle · {elapsed}",
        "state": "{prompts} prompts · {context} tok"
      },
      "Working": {
        "details": "{model} · Working",
        "state": "{contextPercent}% ctx"
      },
      "Thinking": {
        "details": "{model} · Thinking",
        "state": "{{#if contextPercent > 50}}heavy{{else}}light{{/if}}"
      }
    }
  }
}
```

### Idle Template

Used when no session is active:

```json
{
  "presence": {
    "idle": {
      "details": "OpenCode · idle",
      "state": "No active session",
      "largeImageText": "OpenCode",
      "smallImageText": "Idle"
    }
  }
}
```

## Full Example

```json
{
  "discordAppId": "1512803991300476989",
  "discordLargeImageKey": "opencode-logo-too-rich-presence",
  "discordLargeImageText": "OpenCode",
  "currency": "$",
  "presence": {
    "details": "{model} ({mode})",
    "state": "{state} · {contextCompact}",
    "largeImageText": "OpenCode",
    "smallImageText": "{provider}",
    "byState": {
      "Typing": {
        "details": "{model} · Typing",
        "state": "{{#if contextPercent > 80}}⚠️ {contextPercent}% full{{else}}{contextPercent}% ctx{{/if}}"
      },
      "Asking": {
        "details": "{model} · Permission needed",
        "state": "{{#if mode == \"build\"}}Build access{else}}Plan access{{/if}}"
      },
      "Thinking": {
        "details": "{model} · Thinking · {elapsed}",
        "state": "{{#if contextPercent > 50}}Thinking heavy{else}}Thinking{{/if}}"
      }
    },
    "idle": {
      "details": "OpenCode · idle",
      "state": "{prompts} prompts today",
      "largeImageText": "OpenCode",
      "smallImageText": "Idle"
    }
  }
}
```

## Environment Variable Overrides

For temporary overrides (e.g., per-shell), use env vars:

```bash
DISCORD_APP_ID="different_id" opencode
DISCORD_LARGE_IMAGE_KEY="different_key" opencode
DISCORD_LARGE_IMAGE_TEXT="Custom hover" opencode
OPENCODE_RICH_PRESENCE_DEBUG=true opencode   # verbose logging
```

## Field Limits

Discord Rich Presence has hard limits:

- `details`: 128 chars max (truncated automatically with `…`)
- `state`: 128 chars max
- `largeImageText`: 128 chars max
- `smallImageText`: 128 chars max

Templates longer than 128 chars are auto-truncated. Use `{var|fallback}` to keep templates compact.
