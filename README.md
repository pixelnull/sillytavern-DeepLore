# DeepLore - Obsidian Vault Lorebook for SillyTavern

Surface the right lore from your vault at the right moment. DeepLore connects your Obsidian vault to SillyTavern, automatically injecting relevant world-building notes into AI prompts when keywords appear in conversation.

## Features

- **Keyword-triggered injection** -- Tag Obsidian notes with keywords via YAML frontmatter. When keywords appear in chat, the note content is injected into the AI prompt automatically.
- **Always-send and never-insert tags** -- Force critical lore to always be present or mark draft notes to be skipped.
- **Recursive scanning** -- Matched entries are scanned for keywords that might trigger additional entries, building chains of related lore.
- **Token budget controls** -- Set limits on how many entries or tokens get injected per generation.
- **Configurable injection position** -- Inject before/after the system prompt, or in-chat at a specific depth as any role.
- **Vault review command** -- Send your entire lorebook to the AI for consistency review with `/deeplore-review`.
- **Per-entry overrides** -- Set custom scan depth, priority, and recursion behavior per note via frontmatter.
- **World Info interop** -- Optionally let SillyTavern's built-in World Info scan injected lore for cross-system triggering.

## Prerequisites

- [SillyTavern](https://github.com/SillyTavern/SillyTavern) (1.12.0+)
- [Obsidian](https://obsidian.md/) with the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) community plugin installed and enabled
- Server plugins enabled in SillyTavern (`enableServerPlugins: true` in `config.yaml`)

## Installation

### Step 1: Install the client extension

Use SillyTavern's built-in extension installer (recommended):

1. Open SillyTavern
2. Go to **Extensions** panel > **Install Extension**
3. Paste this URL: `https://github.com/pixelnull/sillytavern-DeepLore`
4. Click **Install**

Or install manually with git:

```bash
cd SillyTavern/data/default-user/extensions
git clone https://github.com/pixelnull/sillytavern-DeepLore.git
```

### Step 2: Install the server plugin

DeepLore needs a server plugin to talk to Obsidian.

**Option A: Use the installer script (recommended)**

Run the installer from the extension directory:

- **Windows:** Double-click `install-server.bat` or run it from the command line
- **Linux/Mac:** Run `./install-server.sh`

If the extension isn't installed inside SillyTavern's directory, pass the SillyTavern root path as an argument:

```bash
./install-server.sh /path/to/SillyTavern
```

**Option B: Manual copy**

1. Find the `server` folder at `SillyTavern/public/scripts/extensions/third-party/sillytavern-DeepLore/server`
2. Copy it into `SillyTavern/plugins/`
3. Rename it to `deeplore`

The result should be: `SillyTavern/plugins/deeplore/index.js`

### Step 3: Enable server plugins

In your SillyTavern `config.yaml`, set:

```yaml
enableServerPlugins: true
```

### Step 4: Restart SillyTavern

Restart the SillyTavern server so it picks up the new plugin, then refresh the browser.

## Setup

1. In Obsidian, install and enable the **Local REST API** community plugin
2. Note the **API port** (default: 27123) and copy the **API key** from Obsidian Settings > Local REST API
3. In SillyTavern, go to **Extensions** > **DeepLore**
4. Enter the port and API key, then click **Test Connection**
5. Check **Enable DeepLore**
6. Click **Refresh Index** to pull your vault entries

## Writing Lorebook Notes

Tag any Obsidian note with `#lorebook` (configurable) and add a `keys` field in the YAML frontmatter:

```markdown
---
tags:
  - lorebook
keys:
  - Eris
  - goddess of discord
priority: 10
---

# Eris

Eris is the goddess of discord and strife. She carries a golden apple
inscribed "To the Fairest" which she uses to sow chaos among mortals
and gods alike.
```

### Frontmatter Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `tags` | array | (required) | Must include your lorebook tag (default: `lorebook`) |
| `keys` | array | `[]` | Keywords that trigger this entry when found in chat |
| `priority` | number | `100` | Sort order (lower = injected first) |
| `constant` | boolean | `false` | Always inject regardless of keywords |
| `enabled` | boolean | `true` | Set to `false` to skip this note |
| `scanDepth` | number | (global) | Override the global scan depth for this entry |
| `excludeRecursion` | boolean | `false` | Don't scan this entry's content during recursive matching |

### Special Tags

- **`#lorebook`** -- Marks a note as a lorebook entry (configurable in settings)
- **`#lorebook-always`** -- Forces the note to always be injected, like `constant: true`
- **`#lorebook-never`** -- Prevents the note from ever being injected, even if keywords match

## Slash Commands

| Command | Description |
|---------|-------------|
| `/deeplore-refresh` | Force rebuild the vault index cache |
| `/deeplore-status` | Show connection info, entry counts, and cache status |
| `/deeplore-review [question]` | Send all entries to the AI for review. Optionally provide a custom question. |

## Settings Reference

### Connection
- **Obsidian API Port** -- Port for the Local REST API plugin (default: 27123)
- **API Key** -- Bearer token from Obsidian's Local REST API settings

### Vault Settings
- **Lorebook Tag** -- Tag that identifies lorebook notes (default: `lorebook`)
- **Always-Send Tag** -- Tag for entries that always inject (default: `lorebook-always`)
- **Never-Insert Tag** -- Tag for entries that never inject (default: `lorebook-never`)
- **Scan Depth** -- How many recent messages to scan for keywords (default: 4)
- **Max Entries / Unlimited** -- Cap on injected entries per generation
- **Token Budget / Unlimited** -- Cap on total injected tokens per generation

### Matching
- **Case Sensitive** -- Whether keyword matching respects case
- **Match Whole Words** -- Use word boundaries so "war" won't match "warning"
- **Recursive Scanning** -- Scan matched entry content for more keyword triggers
- **Max Recursion Steps** -- Limit on recursive scan passes (default: 3)

### Injection
- **Injection Template** -- Format string with `{{title}}` and `{{content}}` macros
- **Injection Position** -- Where in the prompt to insert lore (before/after system prompt, or in-chat at depth)
- **Allow World Info Scan** -- Let ST's World Info system scan injected lore

### Index & Debug
- **Cache TTL** -- How long (seconds) to cache the vault index before re-fetching (default: 300)
- **Review Response Tokens** -- Token limit for `/deeplore-review` responses (0 = auto)
- **Debug Mode** -- Log match details to browser console (F12)

## How It Works

1. On each AI generation, the extension scans the last N chat messages for keywords
2. Notes whose `keys` match are collected, sorted by priority, and trimmed to budget
3. Matched content is formatted with the injection template and inserted into the prompt
4. If recursive scanning is on, matched entries are scanned for keywords that trigger more entries
5. The vault index is cached and refreshed automatically based on the Cache TTL

## License

MIT
