# Discord Presence Customization Guide

You can customize **all text** displayed in Discord Rich Presence through the file `~/.config/opencode/discord-config.json`.

##  File Location

```
~/.config/opencode/discord-config.json
```

Example file is at: `config/discord-config.example.json` (in this project).

##  What Can Be Customized

### Discord RPC Text Fields

| Field | Discord Location | Max Chars | Default |
|---|---|---|---|
| `details` | Top line (left of logo) | 128 | `{model} · {mode} · {prompts} prompts` |
| `state` | Bottom line (below details) | 128 | `{state} · {contextPercent}% ctx` |
| `largeImageText` | Tooltip on hover of large image | 128 | `OpenCode` |
| `smallImageText` | Tooltip on hover of small image | 128 | `{provider}` |

### State Detection (byState)

You can have **different templates for each state**:

| State | When It Occurs |
|---|---|
| `Waiting for command` | Agent idle, waiting for user prompt |
| `Working` | Agent starting work / tool running |
| `Thinking` | AI reasoning (chain of thought) |
| `Typing` | AI generating response |
| `Asking` | AI requesting user permission |

### Idle Mode

`idle` is the **default** template when no session is active (queue empty).

### Home Mode (Fresh Launch)

`home` is the template shown when OpenCode is freshly launched (no session opened yet) or when no model has been loaded. Useful for showing a minimal "Ready" presence instead of "?" placeholders.

Default:
```json
"home": {
    "details": "OpenCode",
    "state": "Ready",
    "largeImageText": "OpenCode",
    "smallImageText": "Waiting..."
}
```

The plugin auto-detects "fresh" state by checking if `model` is `"unknown"`. If so, you get friendly fallbacks:
- `{model}` -> `OpenCode` instead of `?`
- `{mode}` -> `ready` instead of `?`
- `{provider}` -> `Local` instead of `?`
- `{cost}` -> `free` instead of `$0.0000`

You can also check `{{#if fresh}}...{{/if}}` in your templates.

##  Template Syntax

### 1. Variable Substitution  -  `{variable}`

Replace `{variable_name}` with actual values:

```
"{model} · {mode} · {prompts} prompts"
-> "minimax-m3 · build · 6 prompts"
```

### Available Variables

| Variable | Example Value | Description |
|---|---|---|
| `{id}` | `abc123def456` | Session ID (last 12 chars) |
| `{sessionId}` | `ses_11b5e6f9bffe3...` | Full Session ID |
| `{provider}` | `Khip01 - 9Router Local` | Provider name |
| `{model}` | `minimax-m3`, `kimchi/kimi-k2.6` | Model in use |
| `{mode}` | `build`, `plan` | Agent mode |
| `{state}` | `Working`, `Thinking` | Current state |
| `{elapsed}` | `1h 23m`, `45s` | Session duration |
| `{context}` | `45,321` | Tokens used (input + cache), raw format |
| `{contextCompact}` | `45.3K` | Tokens used, compact format |
| `{contextPercent}` | `23.7`, `4.2` | Context percentage (numeric) |
| `{contextFull}` | `451,521` | All tokens (including output), raw |
| `{contextFullCompact}` | `451.5K` | All tokens, compact |
| `{contextLimit}` | `262,144` | Model context limit, raw |
| `{contextLimitCompact}` | `262.1K` | Model limit, compact |
| `{cost}` | `free`, `$0.0042` | Session cost (uses configured currency) |
| `{costCompact}` | `$1.5K` | Cost in compact format (K/M) |
| `{prompts}` | `6`, `12` | User prompt count, raw |
| `{promptsCompact}` | `1.5K` | Prompt count, compact |
| `{active}` | `true`, `false` | Is session active |
| `{idle}` | `true`, `false` | Is state idle |
| `{thinking}` | `true`, `false` | Is state Thinking |
| `{typing}` | `true`, `false` | Is state Typing |
| `{working}` | `true`, `false` | Is state Working |
| `{asking}` | `true`, `false` | Is state Asking |
| `{waiting}` | `true`, `false` | Is state Waiting for command |

### Compact Number Format

For large numbers, use the `Compact` variants to keep Discord displays readable.

**Threshold logic:**
- `< 1,000` -> raw number (e.g., `500`)
- `1,000` to `999,999` -> format in K (e.g., `1.5K`, `500K`)
  - Integer values: no decimal (`500K`)
  - Non-integer: 1 decimal (`45.3K`)
- `1,000,000+` -> format in M (e.g., `1.5M`, `500M`)
- `1,000,000,000+` -> format in B (e.g., `1.2B`)

**Examples:**

| Raw | Compact |
|---|---|
| `500` | `500` |
| `1,000` | `1K` |
| `1,500` | `1.5K` |
| `500,000` | `500K` |
| `999,999` | `1M` (rounds up!) |
| `1,000,000` | `1M` |
| `5,000,000` | `5M` |
| `1,500,000` | `1.5M` |

### Currency Customization

The `cost` and `costCompact` variables use a currency symbol configurable in `discord-config.json`:

```json
{
    "currency": "$"
}
```

Default is `$`. Change to `€`, `£`, `¥`, `Rp`, etc.

**Cost format rules:**
- `0` -> `$0 ∞` (free marker)
- `< 0.01` -> `<$0.01` (very small)
- `< 1` -> `$0.50` (two decimals)
- `< 1,000` -> `$999.00`
- `>= 1,000` -> compact: `$1K`, `$1.5K`, `$500K`
- `>= 1,000,000` -> `$1M`, `$5M`

### Fallback Value  -  `{variable|fallback}`

If variable is empty, use fallback:
```
"Created: {elapsed|just now}"
-> "Created: 1h 23m" (if elapsed exists)
-> "Created: just now" (if elapsed empty)
```

### 2. Conditional  -  `{{#if var == "value"}}...{{/if}}`

Show different text based on condition:

```json
"state": "{{#if mode == \"build\"}}Now building with {model}{{else}}Planning mode{{/if}}"
```

#### Supported Operators

| Operator | Example | Meaning |
|---|---|---|
| `==` | `{{#if mode == "build"}}` | Equals |
| `!=` | `{{#if mode != "build"}}` | Not equals |
| `>` | `{{#if contextPercent > 50}}` | Greater than |
| `<` | `{{#if contextPercent < 10}}` | Less than |
| `>=` | `{{#if contextPercent >= 80}}` | Greater or equal |
| `<=` | `{{#if contextPercent <= 20}}` | Less or equal |

#### If-Else

```json
"details": "{{#if contextPercent > 80}} Context nearly full!{{else}}In session · {contextPercent}%{{/if}}"
```

#### Boolean Conditionals

```json
"details": "{{#if active}}Session active{{else}}Idle{{/if}}"
```

This checks if `{active}` value is `"true"`, `"1"`, or `"yes"`.

##  Customization Examples

### Example 1: Minimalist
```json
"presence": {
    "details": "{model}",
    "state": "{contextPercent}% ctx",
    "largeImageText": "OpenCode",
    "byState": {
        "Waiting for command": {
            "details": "{model} · idle",
            "state": "{elapsed} since last prompt"
        },
        "Thinking": {
            "details": " {model} is thinking",
            "state": "Thinking... {contextPercent}% used"
        }
    },
    "idle": {
        "details": "OpenCode",
        "state": "Idle"
    }
}
```

### Example 2: Show Warning at High Context
```json
"presence": {
    "state": "{{#if contextPercent > 80}} {context} / {contextLimit} (HIGH){{else}}{context} / {contextLimit}{{/if}}"
}
```

### Example 3: Per-State Emoji
```json
"presence": {
    "byState": {
        "Working":    { "details": " Working on {model}", "state": "{contextPercent}%" },
        "Thinking":   { "details": " {model} thinking",  "state": "{contextPercent}%" },
        "Typing":     { "details": " {model} typing",   "state": "{contextPercent}%" },
        "Asking":     { "details": " {model} needs input", "state": "Permission requested" },
        "Waiting for command": { "details": " {model} idle", "state": "Waiting..." }
    }
}
```

### Example 4: Only Show When Relevant
```json
"presence": {
    "state": "{{#if cost != \"free\"}}{cost}{{else}}{contextPercent}% ctx{{/if}}"
}
```

### Example 5: Combine Mode + Context
```json
"presence": {
    "byState": {
        "Thinking": {
            "details": "{{#if mode == \"build\"}} Building with {model}{{{else}} Planning with {model}{{/if}}",
            "state": "Thinking · {{#if contextPercent > 70}} heavy context{else}}{contextPercent}}% ctx{{/if}}"
        }
    }
}
```

 **Limitation: Nested `{{#if}}` blocks are not supported.** The example above would NOT work correctly because the regex-based engine cannot match nested IF/ELSE/ENDIF triplets.

**Workaround:** Use flat conditions or pre-compute values. For example, instead of nested IFs on context, use chained conditions:
```json
"state": "{{#if contextPercent > 80}} heavy{{else}}{{#if contextPercent > 50}}🟡 medium{{else}}🟢 light{{/if}}{{/if}}"
```
This example still has nested IFs and won't work. Use direct variables instead:
```json
"state": "{{contextPercent}}% ctx"
```

For complex logic, prefer multiple simpler templates over one complex template.

###  Display Stickiness (Busy Protection)

When multiple OpenCode instances are running, the Discord display follows this policy:

- If **current displayed session is busy** (Working / Thinking / Typing / Asking) -> **keep displaying it** even if another instance becomes active
- If **current is idle** and another instance becomes busy -> switch to the more recently active one
- If both idle -> keep current (no switch)
- If no current -> pick most recently active

This prevents "flapping" where the display jumps around every time another terminal types a prompt. The user only sees a switch when their current OpenCode is idle and another takes over the active role.

This logic is automatic  -  no config needed. If you want to override (e.g., always show the freshest activity regardless of busy state), you'd need to modify `updateDisplay()` in the plugin source.

### Common Syntax Errors to Avoid

| Wrong | Right | Why |
|---|---|---|
| `{{if ...}}` | `{{#if ...}}` | Need `#` prefix |
| `{{?var?}}` | `{var}` or `{var\|fallback}` | `?` is fallback char, not marker |
| `{{/ if}}` (space) | `{{/if}}` | No space before `/if` |
| `{{=if...}}` | `{{#if...}}` | Must be `#if` |
| `{var}}` (extra `}`) | `{var}` | Double `}` is typo; engine keeps extra `}` literal -> output shows stray `}` |

**Note about `{var}}`:** If you see stray `}` characters in your Discord output, you likely have `{var}}` in your template (typo). Just remove the extra `}`. Example:
- Wrong: `{contextPercent}}% ctx` -> renders as `24.7}% ctx`
- Right: `{contextPercent}% ctx` -> renders as `24.7% ctx`

##  Complete Config Structure

```json
{
    "discordAppId": "YOUR_APP_ID",
    "discordLargeImageKey": "your-asset-key",

    "presence": {
        "details": "Default details line",
        "state": "Default state line",
        "largeImageText": "Default large image tooltip",
        "smallImageText": "Default small image tooltip",

        "byState": {
            "Waiting for command": {
                "details": "...",
                "state": "...",
                "largeImageText": "...",
                "smallImageText": "..."
            },
            "Working": { ... },
            "Thinking": { ... },
            "Typing": { ... },
            "Asking": { ... }
        },

        "idle": {
            "details": "...",
            "state": "...",
            "largeImageText": "...",
            "smallImageText": "..."
        }
    }
}
```

##  How to Apply

After editing the config file, restart Discord worker:

```bash
~/.config/opencode/restart-discord.sh
```

Or restart OpenCode:

```bash
Ctrl+C
opencode
```

Template will re-render on next event (send prompt, AI finishes, etc.).
