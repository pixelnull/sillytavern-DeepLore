# Quick start

Get DeepLore injecting lore in five minutes. This page covers the shortest path: connect a vault, write one entry, verify the injection trace.

## Prerequisites

1. **Obsidian** with the [Local REST API plugin](https://github.com/coddingtonbear/obsidian-local-rest-api) installed and enabled
2. **SillyTavern** with DeepLore installed (see [[Installation]])

## Step 1: connect your vault

![Setup wizard welcome screen explaining what DeepLore does, how the two-stage pipeline works, and a Next button to begin configuration](images/dle-setup-wizard.png)

> [!TIP]
> Run `/dle-setup` to launch the guided wizard shown above. It walks vault connection, tags, matching, AI search, the Librarian, vault structure, and lorebook import in nine pages. See [[Setup Wizard]].

To configure manually instead:

1. Open SillyTavern → Extensions → DeepLore
2. Under **Vault Connections**, your default vault is preconfigured
3. Enter the **Port** (default `27123` for HTTP) and **API Key** from the Local REST API plugin settings
4. Click **Test All**. You should see a green checkmark

> [!NOTE]
> The API key lives in Obsidian Settings → Community Plugins → Local REST API → "API Key".

## Step 2: create a test entry

In Obsidian, create a new note with this content:

```markdown
---
tags:
  - lorebook
keys:
  - magic
  - spellcasting
summary: "The magic system of this world. Select when magic, spells, or supernatural abilities come up."
priority: 50
---

# Magic system

Magic in this world is powered by willpower and channeled through spoken incantations.
Novice practitioners can only manage simple cantrips, while masters can reshape reality itself.
```

The load-bearing pieces:

- `tags: [lorebook]` marks this note as a vault entry for DLE to index
- `keys: [magic, spellcasting]` are the keywords that trigger this entry
- `summary` is what AI search reads when deciding whether to select this entry

## Step 3: enable and index

1. Check **Enable DeepLore** in settings
2. Click **Refresh Index** (or run `/dle-refresh`)
3. The header badge should show "1 entries"

## Step 4: verify it works

1. Start or continue a chat
2. Send a message mentioning "magic" or "spellcasting"
3. Run `/dle-inspect`. Your entry should appear in the pipeline trace
4. Click the **book icon** on the AI message to open the Context Cartographer and see which entries were injected

![DLE status output showing vault connection details, 234 indexed entries with tag breakdown, unlimited budget, AI Search enabled, and session statistics](images/dle-status.png)

## What's next

- Read [[First Steps]] to build out a usable vault
- Check [[Writing Vault Entries]] for the full frontmatter reference
- Run `/dle-health` to audit your entries
- Run `/help slash` to list every DLE slash command (SillyTavern auto-discovers them)
