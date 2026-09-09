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
  "currency": "$",
  "replacements": [
    { "vars": ["model", "modelName", "modelCode", "modelNameLower"], "from": "* Free", "to": "" },
    { "vars": ["mode"], "from": "plan", "to": "Planning" },
    { "vars": ["mode"], "from": "build", "to": "Building" }
  ]
}
```

| Field | Description |
|-------|-------------|
| `discordAppId` | Discord Application ID (required for custom branding; otherwise uses fallback) |
| `discordLargeImageKey` | Rich Presence large image asset key |
| `discordLargeImageText` | Hover text on the large image |
| `currency` | Currency symbol for cost formatting (default `$`) |
| `replacements` | Wildcard text replacements on template variables (see Replacements) |
| `presence` | Template overrides (see below) |

## Available Variables

| Variable | Example | Description |
|---|---|---|
| `{model}` | `oc/muse-spark-1.2-contributor-free` | Model full code (raw, with provider prefix) |
| `{modelCode}` | `muse-spark-1.2-contributor-free` | Model code only (provider prefix stripped, after last `/`) |
| `{modelName}` | `Muse Spark 1.2 Contributor Free` | Human-readable Title Case (Code with `-`/`_`/`:` replaced by space, `.` preserved) |
| `{modelNameLower}` | `muse spark 1.2 contributor free` | Human-readable lowercase (same as `modelName`, lowercased) |
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

### Model Name Variants

`{model}` is the raw string from OpenCode (e.g. `oc/muse-spark-1.2-contributor-free`).
The three derived vars let you mix styles in one template:

- `{model}` — full raw (default, backward compat).
- `{modelCode}` — strip provider prefix, keep only after the last `/`. `oc/muse-...` -> `muse-...`, `kc/stepfun/step-3.7-flash:free` -> `step-3.7-flash:free`. No `/` means identity.
- `{modelName}` — from `modelCode`, replace `-`/`_`/`:` with space (`.` is kept so `1.2` stays `1.2`), then Title Case each word. `muse-spark-1.2-contributor-free` -> `Muse Spark 1.2 Contributor Free`.
- `{modelNameLower}` — same as `modelName` but lowercased.

Example mixing variants in one `details`:

```json
{ "details": "{modelName} ({mode}) | {modelCode}" }
```

Fallback syntax works: `{modelCode|OpenCode}`, `{modelName|Unknown}`, etc.

### Boolean State Variables

These resolve to `"true"` or `"false"` and are useful for conditionals:

- `{idle}`, `{working}`, `{thinking}`, `{typing}`, `{asking}`, `{waiting}`, `{active}`

## Replacements

Top-level `replacements` rewrites template variable values before rendering. Each rule targets one or more vars, uses a literal wildcard pattern, and is case-sensitive.

```json
{
  "replacements": [
    { "vars": ["model", "modelName", "modelCode", "modelNameLower"], "from": "* Free", "to": "" },
    { "vars": ["mode"], "from": "plan", "to": "Planning" },
    { "vars": ["mode"], "from": "build", "to": "Building" }
  ]
}
```

Effect: `Muse Spark 1.2 Contributor Free` -> `Muse Spark 1.2 Contributor`; `mode` `plan` -> `Planning` across all templates (`details`, `state`, `byState`, `idle`).

### Wildcard in `from`

`*` is allowed only at the start and/or end (not in the middle). `*` at both ends means `contains` and replaces all occurrences.

| `from` | Meaning | Example on `Muse Spark Free` (`to: ""`) |
|---|---|---|
| `Free` | Exact — whole var must equal `Free` | No match |
| `*Free` | Suffix — ends with `Free` | `Muse Spark Free` -> `Muse Spark ` |
| `Free*` | Prefix — starts with `Free` | No match |
| `*Free*` | Contains — replace all `Free` substrings | `Muse Spark Free Free` -> `Muse Spark  ` |
| `* Free` | Suffix with space — ends with ` Free` | `Muse Spark Free` -> `Muse Spark` |
| `plan` | Exact `plan` | Only matches var `mode` with value `plan` |

Rules on `plan-plan` with `*plan* -> x` become `x-x` (contains replaces globally); with `plan -> x` (exact) there is no match.

### Rules

- `vars` must be known template vars (e.g. `model`, `modelName`, `modelCode`, `provider`, `mode`, `state`, `cost`, `context`, `elapsed`). Unknown names are skipped.
- `from`/`to` are strings. `from` empty, `from: "*"`, or `from` with `*` in the middle is skipped. `to` may be `""` to delete.
- Case-sensitive: `Free`, `free`, and `FREE` are different; write separate rules for each casing you want.
- Rules run in order and chain: the output of rule 1 is the input of rule 2. Identical duplicate rules (same `vars`+`from`+`to`) are deduped to the first occurrence; different casing is not a duplicate.
- Applied before any template rendering, so conditionals like `{{#if mode == "Planning"}}` see the replaced value.

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

Customize per state. The `"Waiting for command"` entry is shown when
a session EXISTS and is waiting for your next input (i.e. right after
the AI finishes generating). It is a real session with real
accumulated cost and tokens, so `{costCompact}`, `{contextCompact}`,
and `{prompts}` are populated there. This is the state your config
displays as "Completed!".

```json
{
  "presence": {
    "byState": {
      "Waiting for command": {
        "details": "{model} ({mode}) {{#if cost == \"free\"}} • $0 spent{{else}}{costCompact} spent{{/if}}",
        "state": "Completed! • {contextCompact}/{contextLimitCompact} token • {prompts} prompts"
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

Used only when there is NO session at all (queue empty, nothing
displayed). It is NOT shown for a session that just finished; a
finished session is `"Waiting for command"` and uses the `byState`
entry above (so its cost persists, it does not reset to $0):

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
  "replacements": [
    { "vars": ["modelName"], "from": "* Free", "to": "" },
    { "vars": ["mode"], "from": "plan", "to": "Planning" }
  ],
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
