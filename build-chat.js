#!/usr/bin/env node
// Build demo chat HTML from content array and inject into index.html
const fs = require('fs');
const path = require('path');

// ─── Claude SVG icon paths (shared) ───
const SVG_PATHS = `<g transform="translate(0.000000,125.000000) scale(0.100000,-0.100000)" stroke="none">
<path d="M445 1128 c-27 -68 -56 -141 -65 -163 -10 -22 -70 -173 -134 -335 -65 -162 -121 -304 -126 -315 -15 -31 -120 -304 -120 -310 0 -3 62 -5 138 -5 l138 0 23 58 c12 31 33 84 47 117 13 33 24 66 24 73 0 9 59 12 263 12 l263 0 16 -37 c9 -21 29 -69 43 -108 15 -38 31 -80 36 -92 8 -22 13 -23 149 -23 77 0 140 2 140 5 0 4 -83 210 -105 260 -7 17 -16 41 -20 55 -4 14 -15 43 -25 65 -10 22 -52 128 -94 235 -43 107 -84 211 -92 230 -22 51 -28 66 -69 170 -36 94 -47 119 -78 193 l-17 37 -144 0 -143 0 -48 -122z m220 -273 c10 -27 22 -54 25 -60 4 -5 15 -35 25 -65 10 -30 21 -59 25 -65 4 -5 15 -35 25 -65 10 -30 21 -59 26 -65 5 -5 9 -15 9 -22 0 -10 -36 -13 -164 -13 l-164 0 49 128 c28 70 64 164 81 210 17 46 34 80 38 75 4 -4 15 -30 25 -58z"></path>
<path d="M1046 1163 c20 -49 44 -110 54 -138 20 -54 65 -168 80 -200 9 -21 34 -83 165 -415 43 -107 83 -208 91 -225 7 -16 26 -64 42 -105 l29 -75 142 -3 c133 -2 141 -1 132 15 -6 10 -63 151 -126 313 -64 162 -136 342 -160 400 -23 58 -80 198 -126 313 l-82 207 -138 0 -138 0 35 -87z"></path>
</g>`;

function claudeSvg(cls) {
  return `<svg version="1.0" xmlns="http://www.w3.org/2000/svg" width="179.000000pt" height="125.000000pt" viewBox="0 0 179.000000 125.000000" preserveAspectRatio="xMidYMid meet" data-inject-url="http://localhost:8002/img/claude.svg" class="icon-svg ${cls}">
<title>claude - claude-opus-4-6</title>${SVG_PATHS}
</svg>`;
}

// ─── Shared button HTML ───
const EXTRA_BUTTONS_USER = `<div title="Translate message" class="mes_button mes_translate fa-solid fa-language interactable" data-i18n="[title]Translate message" tabindex="0" role="button"></div>
                                <div title="Generate Image" class="mes_button sd_message_gen fa-solid fa-paintbrush interactable" data-i18n="[title]Generate Image" tabindex="0" role="button"></div>
                                <div title="Narrate" class="mes_button mes_narrate fa-solid fa-bullhorn interactable" data-i18n="[title]Narrate" tabindex="0" role="button"></div>
                                <div title="Prompt" class="mes_button mes_prompt fa-solid fa-square-poll-horizontal interactable" data-i18n="[title]Prompt" style="display: none;" tabindex="0" role="button"></div>
                                <div title="Exclude message from prompts" class="mes_button mes_hide fa-solid fa-eye interactable" data-i18n="[title]Exclude message from prompts" tabindex="0" role="button"></div>
                                <div title="Include message in prompts" class="mes_button mes_unhide fa-solid fa-eye-slash interactable" data-i18n="[title]Include message in prompts" tabindex="0" role="button"></div>
                                <div title="Toggle media display style" class="mes_button mes_media_gallery fa-solid fa-photo-film interactable" data-i18n="[title]Toggle media display style" tabindex="0" role="button"></div>
                                <div title="Toggle media display style" class="mes_button mes_media_list fa-solid fa-table-cells-large interactable" data-i18n="[title]Toggle media display style" tabindex="0" role="button"></div>
                                <div title="Embed file or image" class="mes_button mes_embed fa-solid fa-paperclip interactable" data-i18n="[title]Embed file or image" tabindex="0" role="button"></div>
                                <div title="Jump to swipe history" class="mes_button mes_swipe_picker fa-solid fa-bookmark interactable" data-i18n="[title]Jump to swipe history" style="display: none;" tabindex="0" role="button"></div>
                                <div title="Create checkpoint" class="mes_button mes_create_bookmark fa-regular fa-solid fa-flag-checkered interactable" data-i18n="[title]Create checkpoint" tabindex="0" role="button"></div>
                                <div title="Create branch" class="mes_button mes_create_branch fa-regular fa-code-branch interactable" data-i18n="[title]Create Branch" tabindex="0" role="button"></div>
                                <div title="Copy" class="mes_button mes_copy fa-solid fa-copy interactable" data-i18n="[title]Copy" tabindex="0" role="button"></div>`;

const EXTRA_BUTTONS_ASSISTANT = `<div title="Why? — See which lore was injected" class="mes_button mes_deeplore_sources fa-solid fa-book-open interactable" role="button" tabindex="0" aria-label="Why? — See which lore was injected"></div>
                                <div title="Translate message" class="mes_button mes_translate fa-solid fa-language interactable" data-i18n="[title]Translate message" tabindex="0" role="button"></div>
                                <div title="Generate Image" class="mes_button sd_message_gen fa-solid fa-paintbrush interactable" data-i18n="[title]Generate Image" tabindex="0" role="button"></div>
                                <div title="Narrate" class="mes_button mes_narrate fa-solid fa-bullhorn interactable" data-i18n="[title]Narrate" tabindex="0" role="button"></div>
                                <div title="Prompt" class="mes_button mes_prompt fa-solid fa-square-poll-horizontal interactable" data-i18n="[title]Prompt" style="" tabindex="0" role="button"></div>
                                <div title="Exclude message from prompts" class="mes_button mes_hide fa-solid fa-eye interactable" data-i18n="[title]Exclude message from prompts" tabindex="0" role="button"></div>
                                <div title="Include message in prompts" class="mes_button mes_unhide fa-solid fa-eye-slash interactable" data-i18n="[title]Include message in prompts" tabindex="0" role="button"></div>
                                <div title="Toggle media display style" class="mes_button mes_media_gallery fa-solid fa-photo-film interactable" data-i18n="[title]Toggle media display style" tabindex="0" role="button"></div>
                                <div title="Toggle media display style" class="mes_button mes_media_list fa-solid fa-table-cells-large interactable" data-i18n="[title]Toggle media display style" tabindex="0" role="button"></div>
                                <div title="Embed file or image" class="mes_button mes_embed fa-solid fa-paperclip interactable" data-i18n="[title]Embed file or image" tabindex="0" role="button"></div>
                                <div title="Jump to swipe history" class="mes_button mes_swipe_picker fa-solid fa-bookmark interactable" data-i18n="[title]Jump to swipe history" style="display: none;" tabindex="0" role="button"></div>
                                <div title="Create checkpoint" class="mes_button mes_create_bookmark fa-regular fa-solid fa-flag-checkered interactable" data-i18n="[title]Create checkpoint" tabindex="0" role="button"></div>
                                <div title="Create branch" class="mes_button mes_create_branch fa-regular fa-code-branch interactable" data-i18n="[title]Create Branch" tabindex="0" role="button"></div>
                                <div title="Copy" class="mes_button mes_copy fa-solid fa-copy interactable" data-i18n="[title]Copy" tabindex="0" role="button"></div>`;

const EDIT_BUTTONS = `<div class="mes_edit_done menu_button fa-solid fa-check interactable" title="Confirm" data-i18n="[title]Confirm" tabindex="0" role="button"></div>
                            <div class="mes_edit_copy menu_button fa-solid fa-copy interactable" title="Copy this message" data-i18n="[title]Copy this message" tabindex="0" role="button"></div>
                            <div class="mes_edit_add_reasoning menu_button fa-solid fa-lightbulb interactable" title="Add reasoning block" data-i18n="[title]Add a reasoning block" tabindex="0" role="button"></div>
                            <div class="mes_edit_delete menu_button fa-solid fa-trash-can interactable" title="Delete this message" data-i18n="[title]Delete this message" tabindex="0" role="button"></div>
                            <div class="mes_edit_up menu_button fa-solid fa-chevron-up interactable" title="Move message up" data-i18n="[title]Move message up" tabindex="0" role="button"></div>
                            <div class="mes_edit_down menu_button fa-solid fa-chevron-down interactable" title="Move message down" data-i18n="[title]Move message down" tabindex="0" role="button"></div>
                            <div class="mes_edit_cancel menu_button fa-solid fa-xmark interactable" title="Cancel" data-i18n="[title]Cancel" tabindex="0" role="button"></div>`;

const REASONING_ACTIONS = `<div class="mes_reasoning_edit_done menu_button edit_button fa-solid fa-check interactable" title="Confirm" data-i18n="[title]Confirm Edit" tabindex="0" role="button"></div>
                                <div class="mes_reasoning_delete menu_button edit_button fa-solid fa-trash-can interactable" title="Remove reasoning" data-i18n="[title]Remove reasoning" tabindex="0" role="button"></div>
                                <div class="mes_reasoning_edit_cancel menu_button edit_button fa-solid fa-xmark interactable" title="Cancel edit" data-i18n="[title]Cancel edit" tabindex="0" role="button"></div>
                                <div class="mes_reasoning_close_all mes_button fa-solid fa-minimize" title="Collapse all reasoning blocks" data-i18n="[title]Collapse all reasoning blocks" role="button"></div>
                                <div class="mes_reasoning_copy mes_button fa-solid fa-copy" title="Copy reasoning" data-i18n="[title]Copy reasoning" role="button"></div>
                                <div class="mes_reasoning_edit mes_button fa-solid fa-pencil" title="Edit reasoning" data-i18n="[title]Edit reasoning" role="button"></div>`;

// ─── Build one message ───
function buildMessage(mesid, msg, isLast) {
  const isUser = msg.role === 'user';
  const classes = ['mes'];
  if (!isUser) classes.push('reasoning');
  if (isLast) classes.push('last_mes', 'last_swipe');
  classes.push('fade');

  const extraButtons = isUser ? EXTRA_BUTTONS_USER : EXTRA_BUTTONS_ASSISTANT;
  const timerTitle = msg.timerTitle || '';
  const timerText = msg.timer || '';

  // Reasoning block
  let reasoningBlock;
  if (isUser) {
    reasoningBlock = `<details class="mes_reasoning_details" data-state="none" data-type="undefined">
                        <summary class="mes_reasoning_summary flex-container">
                            <div class="mes_reasoning_header_block flex-container">
                                <div class="mes_reasoning_header flex-container">
                                    <span class="mes_reasoning_header_title" data-i18n="Thought for some time" title="">Thinking...</span>
                                    <div class="mes_reasoning_arrow fa-solid fa-chevron-up"></div>
                                </div>
                            </div>
                            <div class="mes_reasoning_actions flex-container">
                                ${REASONING_ACTIONS}
                            </div>
                        </summary>
                        <div class="mes_reasoning"></div>
                    </details>`;
  } else {
    reasoningBlock = `<details class="mes_reasoning_details" data-state="done" data-type="undefined" data-duration="unknown">
                        <summary class="mes_reasoning_summary flex-container">
                            <div class="mes_reasoning_header_block flex-container">
                                <div class="mes_reasoning_header flex-container">
                                    ${claudeSvg('thinking-icon')}<span class="mes_reasoning_header_title" data-i18n="Thought for some time" title="" data-duration="unknown">Thought for some time</span>
                                    <div class="mes_reasoning_arrow fa-solid fa-chevron-up"></div>
                                </div>
                            </div>
                            <div class="mes_reasoning_actions flex-container">
                                ${REASONING_ACTIONS}
                            </div>
                        </summary>
                        <div class="mes_reasoning">${msg.reasoning || ''}</div>
                    </details>`;
  }

  // Librarian block (assistant only)
  let librarianBlock = '';
  if (!isUser && msg.librarian && msg.librarian.length > 0) {
    const entries = msg.librarian.map(l => `<div class="dle-librarian-dropdown-entry">
            <span class="dle-librarian-icon fa-solid fa-magnifying-glass"></span>
            <span class="dle-librarian-query">${l.query}</span>
            <span class="dle-librarian-result">${l.result}</span>
        </div>`).join('\n');
    librarianBlock = `<details class="dle-librarian-details">
        <summary class="dle-librarian-summary">
            <div class="dle-librarian-header">
                <span class="dle-librarian-icon-header fa-solid fa-book-bookmark"></span>
                <span class="dle-librarian-title">Consulted lore vault (${msg.librarian.length} search${msg.librarian.length > 1 ? 'es' : ''})</span>
                <div class="dle-librarian-arrow fa-solid fa-chevron-up"></div>
            </div>
        </summary>
        <div class="dle-librarian-content">
            ${entries}
        </div>
    </details>`;
  }

  // Timestamp with optional Claude SVG
  const timestampExtra = isUser ? '' : claudeSvg('timestamp-icon');

  return `<div class="${classes.join(' ')}" mesid="${mesid}" ch_name="${isUser ? 'User' : 'Assistant'}" is_user="${isUser}" is_system="false" bookmark_link="" swipeid="0" force_avatar="${isUser}" timestamp="${msg.timestamp}" type=""${!isUser ? ' data-reasoning-state="done"' : ''}>
                <div class="for_checkbox" style="display: block;"></div><input type="checkbox" class="del_checkbox" style="display: none;">
                <div class="mesAvatarWrapper">
                    <div class="avatar">
                        <img src="${isUser ? 'img/avatar-user.png' : 'img/avatar-assistant.png'}">
                    </div>
                    <div class="mesIDDisplay">#${mesid}</div>
                    <div class="mes_timer"${timerTitle ? ` title="${timerTitle}"` : ''}>${timerText}</div>
                    <div class="tokenCounterDisplay"></div>
                </div>
                <div class="swipe_left fa-solid fa-chevron-left interactable" tabindex="0" role="button"></div>
                <div class="mes_block">
                    <div class="ch_name flex-container justifySpaceBetween">
                        <div class="flex-container flex1 alignitemscenter">
                            <div class="flex-container alignItemsBaseline">
                                <span class="name_text">${isUser ? 'User' : 'Assistant'}</span>
                                <i class="mes_ghost fa-solid fa-ghost" title="This message is invisible for the AI" data-i18n="[title]This message is invisible for the AI"></i>
                                <small class="timestamp" title="${!isUser ? 'claude - claude-opus-4-6' : ''}">${msg.timestamp}</small>${timestampExtra}
                            </div>
                        </div>
                        <div class="mes_buttons">
                            <div title="Message Actions" class="mes_button extraMesButtonsHint fa-solid fa-ellipsis interactable" data-i18n="[title]Message Actions" tabindex="0" role="button" style=""></div>
                            <div class="extraMesButtons">${extraButtons}
                            </div>
                            <div data-tooltip="Click to open checkpoint chat
Shift+Click to replace the existing checkpoint with a new one" class="mes_button mes_bookmark fa-solid fa-flag interactable" data-i18n="[data-tooltip]Open checkpoint chat
Shift+Click to replace the existing checkpoint with a new one" tabindex="0" role="button"></div>
                            <div title="Edit" class="mes_button mes_edit fa-solid fa-pencil interactable" data-i18n="[title]Edit" tabindex="0" role="button"></div>
                        </div>
                        <div class="mes_edit_buttons"${!isUser ? ' style="display: none;"' : ''}>
                            ${EDIT_BUTTONS}
                        </div>
                    </div>
                    ${reasoningBlock}${librarianBlock}
                    <div class="mes_text">${msg.text}</div>
                    <div class="mes_media_wrapper"></div>
                    <div class="mes_file_wrapper"></div>
                    <div class="mes_bias"></div>
                </div>
                <div class="flex-container swipeRightBlock flexFlowColumn flexNoGap">
                    <div class="swipe_right fa-solid fa-chevron-right interactable" tabindex="0" role="button"></div>
                    <div class="swipes-counter">${!isUser ? '1\u200B/\u200B1' : ''}</div>
                </div>
            </div>`;
}

// ═══════════════════════════════════════════════════════════════════
//  CONTENT — edit this array to change the demo conversation
// ═══════════════════════════════════════════════════════════════════
const messages = [
  // ── 0: What is DLE? ──
  {
    role: 'user',
    timestamp: 'April 10, 2026 7:30 PM',
    text: '<p>What exactly is DeepLore Enhanced? I keep seeing it mentioned for worldbuilding in SillyTavern.</p>',
  },
  // ── 1: Overview ──
  {
    role: 'assistant',
    timestamp: 'April 10, 2026 7:30 PM',
    timer: '3.2s',
    reasoning: '<p>The user is asking for a high-level overview of DLE. Let me explain the core value proposition: Obsidian vault connection, automatic retrieval, and transparent pipeline.</p>',
    librarian: [
      { query: 'Duskfrost world rules; character roster; Bellsummit landmarks; Highwallow geography',
        result: '14 entries found (Duskfrost World Rules, Gorduin Wynlar, Bellsummit, Highwallow, Angel Crown, Antecedent Script, Oracles of Might, Duskfrost Academy, Wardenship, Solarguard, First Triumvirate Compact, Thyren, Kethvali, Gnaino)' },
    ],
    text: `<p>DeepLore Enhanced bridges your <strong>Obsidian worldbuilding vault</strong> directly into SillyTavern's prompt pipeline. Instead of manually copying lore into character cards or World Info entries, you point DLE at your Obsidian vault and it handles the rest.</p>
<p>Every time you send a message, DLE scans your conversation, identifies which lore entries are relevant, and injects them into the AI's context \u2014 automatically. Your 10-page document about an ancient oath? The AI reads it when oaths come up in conversation, not before.</p>
<p>It's a full lorebook replacement with AI-powered retrieval, a live dashboard, and tools to help you maintain your vault \u2014 all from within SillyTavern.</p>`,
  },
  // ── 2: How does retrieval work? ──
  {
    role: 'user',
    timestamp: 'April 10, 2026 7:31 PM',
    text: '<p>How does it decide what lore to inject each turn?</p>',
  },
  // ── 3: Two-stage pipeline ──
  {
    role: 'assistant',
    timestamp: 'April 10, 2026 7:31 PM',
    timer: '4.1s',
    reasoning: '<p>Let me explain the core retrieval pipeline \u2014 the two-stage approach is the key differentiator from traditional lorebooks. Keywords for recall, AI for precision.</p>',
    text: `<p>DLE runs a <strong>two-stage retrieval pipeline</strong> every generation:</p>
<p><strong>Stage 1 \u2014 Keywords cast a wide net.</strong> DLE scans recent messages for keyword matches against your vault entries. BM25 fuzzy matching catches synonyms and thematic overlaps \u2014 "sorcery" can trigger your "Magic System" entry even if that exact word isn't a keyword.</p>
<p><strong>Stage 2 \u2014 AI narrows it down.</strong> The keyword candidates and their summaries are sent to an AI call that selects the most <em>contextually relevant</em> entries. A conversation about "breaking an oath" pulls in your oath-related lore even if the entry title was never mentioned \u2014 because the AI understands the thematic connection.</p>
<p>You can also run <strong>AI-only mode</strong> (skip keywords, maximum thoroughness) or <strong>keywords-only mode</strong> (zero API calls, traditional lorebook behavior).</p>`,
  },
  // ── 4: Scale ──
  {
    role: 'user',
    timestamp: 'April 10, 2026 7:32 PM',
    text: '<p>My vault has over 200 entries. Won\'t that blow up my token budget?</p>',
  },
  // ── 5: Budget & performance ──
  {
    role: 'assistant',
    timestamp: 'April 10, 2026 7:32 PM',
    timer: '3.8s',
    reasoning: '<p>The user has a large vault and is worried about token costs. Let me explain the three mechanisms that keep things efficient: clustering, budgeting, and caching.</p>',
    librarian: [
      { query: 'Duskfrost faction politics; Triumvirate power structure; Wardenship military hierarchy',
        result: '11 entries found (First Triumvirate Compact, Wardenship, Solarguard, Archmage Tessavel Orindal, Duskfrost Academy, Tybellan Hercyne, Felicitas Langguth, Great Census of Year 180, Scorchhelm, Compact Vault, Lorant)' },
      { query: 'Antecedent artifacts; pre-Calamity technology; Angel Crown properties; Scribe Fragment translation',
        result: '8 entries found (Antecedent Script, Scribe Fragment \u2014 Lost Translation, Angel Crown, Compact Vault, Oracles of Might, Gorduin Wynlar, Professor Taevis Wrent, Undertow)' },
    ],
    text: `<p>No \u2014 DLE has multiple layers of protection:</p>
<p><strong>Hierarchical clustering</strong> kicks in for large vaults (40+ entries). Instead of sending all 200+ entry summaries to the AI, it groups entries by category, asks the AI which categories are relevant, then only sends entries from those categories. Two small API calls instead of one massive one.</p>
<p><strong>Token budget cap</strong> \u2014 you set a hard ceiling (e.g. 4,000 tokens). DLE over-requests from the AI, then sorts by confidence and cuts from the bottom until budget fits. High-confidence picks always survive.</p>
<p><strong>Sliding window cache</strong> \u2014 if the conversation hasn't changed meaningfully (no new entity mentions, same manifest), DLE reuses the last AI selection. Regenerations and swipes are essentially free.</p>
<p>The token budget bar in the drawer shows real-time usage so you can see exactly where your budget is going.</p>`,
  },
  // ── 6: Control ──
  {
    role: 'user',
    timestamp: 'April 10, 2026 7:33 PM',
    text: '<p>Can I control what gets injected, or is it all automatic?</p>',
  },
  // ── 7: Manual controls ──
  {
    role: 'assistant',
    timestamp: 'April 10, 2026 7:33 PM',
    timer: '3.5s',
    reasoning: '<p>The user wants to know about manual overrides. Let me cover pin/block, priority, cooldown, warmup, and probability \u2014 the key per-entry controls.</p>',
    text: `<p>Both. The automatic pipeline handles most cases, but you have fine-grained manual controls:</p>
<p><strong>Pin/Block per chat</strong> \u2014 pin entries to always inject in this conversation, or block entries to never inject. One click in the Browse tab or <code>/dle-pin</code>.</p>
<p><strong>Priority system</strong> \u2014 entries have priority 0\u201310. Higher priority entries are selected first. Constants (priority 10) are always injected regardless of keyword matches.</p>
<p><strong>Cooldowns</strong> \u2014 skip an entry for N turns after it triggers, preventing repetitive injection. Warmup gates require keywords to appear multiple times before an entry activates.</p>
<p><strong>Probability gates</strong> \u2014 entries can have a 0\u2013100% chance of triggering even when matched. Good for flavor text you want to appear <em>sometimes</em>.</p>
<p>All of this is per-entry in your Obsidian frontmatter, so your vault is the single source of truth.</p>`,
  },
  // ── 8: Gating ──
  {
    role: 'user',
    timestamp: 'April 10, 2026 7:34 PM',
    text: '<p>What about context-sensitive lore? Castle descriptions shouldn\'t show up when the scene is on a spaceship.</p>',
  },
  // ── 9: Contextual gating ──
  {
    role: 'assistant',
    timestamp: 'April 10, 2026 7:34 PM',
    timer: '4.0s',
    reasoning: '<p>Contextual gating is a major feature. Let me cover the four built-in fields and then highlight custom fields as the differentiator.</p>',
    librarian: [
      { query: 'Duskfrost geography and climate; Bellsummit tower complex; Highwallow marshes; Scorchhelm desert',
        result: '9 entries found (Bellsummit, Highwallow, Scorchhelm, Duskfrost World Rules, Undertow, Kethvali, Lorant, Gnaino, Ayre Waesphyra)' },
    ],
    text: `<p>That's what <strong>contextual gating</strong> handles. DLE has four built-in gating fields:</p>
<ul>
<li><strong>Era</strong> \u2014 medieval, modern, future, etc.</li>
<li><strong>Location</strong> \u2014 tavern, castle, forest, spaceship, etc.</li>
<li><strong>Scene type</strong> \u2014 combat, romance, investigation, etc.</li>
<li><strong>Character presence</strong> \u2014 only inject when specific characters are active</li>
</ul>
<p>Set them with slash commands (<code>/dle-set-era future</code>) or from the <strong>Gating tab</strong> in the drawer. Each entry declares which contexts it belongs to in frontmatter, and DLE filters automatically.</p>
<p>But the real power is <strong>custom fields</strong>. Define <em>any</em> gating dimension your world needs \u2014 faction, time_of_day, threat_level, magic_school \u2014 with a visual rule builder. No YAML editing required.</p>`,
  },
  // ── 10: Transparency ──
  {
    role: 'user',
    timestamp: 'April 10, 2026 7:35 PM',
    text: '<p>How do I know what was injected and why?</p>',
  },
  // ── 11: Visibility layers ──
  {
    role: 'assistant',
    timestamp: 'April 10, 2026 7:35 PM',
    timer: '4.3s',
    reasoning: '<p>Transparency is one of DLE\'s strongest selling points. Let me cover all four visibility layers \u2014 Why tab, Context Cartographer, Why Not diagnostics, and Pipeline Inspector.</p>',
    text: `<p>DLE is obsessively transparent. Multiple layers of visibility:</p>
<p><strong>Why? tab</strong> \u2014 the first tab in the drawer. Shows every injected entry this generation with match type (keyword, AI, constant, pinned), confidence level, token cost, and injection count. Switch to "Filtered" view to see what was <em>rejected</em> and why.</p>
<p><strong>Context Cartographer</strong> \u2014 the \uD83D\uDCD6 button on each AI message. Click it to see the full injection breakdown for that specific response: which entries, why they matched, grouped by injection position, with expandable content previews.</p>
<p><strong>"Why Not?" diagnostics</strong> \u2014 click any unmatched entry to get the exact failure reason: no keyword match, warmup not met, gating conflict, cooldown active, AI rejected, budget cut. Includes suggestions like "increase scan depth to reach this entry."</p>
<p><strong>Pipeline Inspector</strong> (<code>/dle-inspect</code>) \u2014 the full trace of every keyword match, fuzzy score, AI selection, filter applied, and cut made.</p>`,
  },
  // ── 12: Browse ──
  {
    role: 'user',
    timestamp: 'April 10, 2026 7:36 PM',
    text: '<p>Can I explore my vault without leaving SillyTavern?</p>',
  },
  // ── 13: Browse tab ──
  {
    role: 'assistant',
    timestamp: 'April 10, 2026 7:36 PM',
    timer: '3.6s',
    reasoning: '<p>The Browse tab is the most visually impressive drawer feature. Let me describe the filtering, sorting, heatmap, and inline controls.</p>',
    text: `<p>The <strong>Browse tab</strong> is a full vault explorer with virtual scrolling \u2014 smooth even with 200+ entries.</p>
<p>Filter by status (injected, pinned, blocked, constants, seeds, never injected), by tags, by folders, or by any custom gating field. Sort by priority, alphabetically, by token count, or by injection frequency.</p>
<p>Each entry row shows the title, priority badge, injection count, and a <strong>temperature heatmap</strong> \u2014 entries that trigger more than average glow warm (red), underused entries glow cold (blue). At a glance you can spot imbalances.</p>
<p>Expand any entry for a content preview, keyword list, and an Obsidian deep-link to edit it directly. Pin or block entries with inline buttons \u2014 no slash commands needed.</p>`,
  },
  // ── 14: Vault gaps ──
  {
    role: 'user',
    timestamp: 'April 10, 2026 7:37 PM',
    text: '<p>What if the AI needs lore that doesn\'t exist in my vault yet?</p>',
  },
  // ── 15: Librarian & Auto Lorebook ──
  {
    role: 'assistant',
    timestamp: 'April 10, 2026 7:37 PM',
    timer: '3.9s',
    reasoning: '<p>Vault growth tools are a key differentiator. Let me cover the Librarian (passive gap detection), Auto Lorebook (active suggestions), and AI Vault Review (structural analysis).</p>',
    librarian: [
      { query: 'Undertow chambers; pre-Calamity ruins; Antecedent metalwork; sealed vaults beneath Highwallow',
        result: '7 entries found (Undertow, Antecedent Script, Scribe Fragment \u2014 Lost Translation, Angel Crown, Compact Vault, Highwallow, Gorduin Wynlar)' },
    ],
    text: `<p>DLE has three features for vault growth:</p>
<p><strong>Librarian</strong> \u2014 the fourth drawer tab. When the AI encounters topics not covered by your vault, DLE flags them automatically. The Librarian inbox shows what was needed, how often, and how urgently. Sort by frequency to find systematic gaps.</p>
<p><strong>Auto Lorebook</strong> \u2014 analyzes your chat and suggests new entries with proper frontmatter (title, keywords, summary, content). One click to accept and write to your vault. Run on-demand with <code>/dle-newlore</code>.</p>
<p><strong>AI Vault Review</strong> \u2014 submit your entire vault structure for AI analysis. Get feedback on coverage gaps, inconsistencies, and areas that need expansion.</p>
<p>The AI helps you build the vault, not just use it.</p>`,
  },
  // ── 16: Memory ──
  {
    role: 'user',
    timestamp: 'April 10, 2026 7:38 PM',
    text: '<p>Does the AI remember things across a long conversation?</p>',
  },
  // ── 17: Scribe & Notepad ──
  {
    role: 'assistant',
    timestamp: 'April 10, 2026 7:38 PM',
    timer: '4.2s',
    reasoning: '<p>Long conversation memory is a common pain point. Scribe handles external memory (vault notes), AI Notepad handles internal memory (hidden AI state).</p>',
    text: `<p>Two features handle conversational memory:</p>
<p><strong>Session Scribe</strong> \u2014 auto-summarizes your conversation at configurable intervals. Writes timestamped markdown notes to your vault with tags, dates, and character context. Each summary builds on the previous one \u2014 no repetition. The AI can use these summaries for <em>scribe-informed retrieval</em>, giving it narrative perspective beyond just the recent messages.</p>
<p><strong>AI Notepad</strong> \u2014 the AI maintains private session notes that persist across turns but are invisible to you. It tracks character motivations, unresolved plot threads, and secrets without saying them aloud. View it anytime with <code>/dle-ai-notepad</code>.</p>
<p>Scribe writes to your vault (external memory). Notepad stays in the chat session (internal memory). Together they make responses feel dramatically more coherent over long sessions.</p>`,
  },
  // ── 18: Visualization ──
  {
    role: 'user',
    timestamp: 'April 10, 2026 7:39 PM',
    text: '<p>Is there a way to see how all my entries connect to each other?</p>',
  },
  // ── 19: Graph & Simulation ──
  {
    role: 'assistant',
    timestamp: 'April 10, 2026 7:39 PM',
    timer: '3.4s',
    reasoning: '<p>Visualization tools are impressive demos. Graph for relationships, Simulation for keyword behavior over time.</p>',
    librarian: [
      { query: 'Gorduin Wynlar relationships; Angel Crown connections; Duskfrost Academy staff; Bellsummit organizations',
        result: '12 entries found (Gorduin Wynlar, Angel Crown, Oracles of Might, Duskfrost Academy, Bellsummit, Professor Taevis Wrent, Archmage Tessavel Orindal, Wardenship, Solarguard, Ayre Waesphyra, Tybellan Hercyne, Compact Vault)' },
    ],
    text: `<p><code>/dle-graph</code> opens an interactive <strong>relationship graph</strong> \u2014 force-directed layout that handles 200+ nodes smoothly. Entries are color-coded nodes; edges show wikilinks, requires/excludes dependencies, and cascade links.</p>
<p><strong>Ego-centric focus mode</strong> \u2014 click any node to isolate its N-hop neighborhood. Great for exploring one character's web of connections without the noise.</p>
<p><strong>Gap analysis</strong> \u2014 highlights orphaned entries with no relationships. Dead entry detection clusters unreachable nodes. These are your vault's blind spots.</p>
<p>There's also <strong>Activation Simulation</strong> (<code>/dle-simulate</code>) \u2014 replays your chat history message-by-message showing which entries activate and deactivate at each step. Blue for newly active, red for deactivated. Invaluable for tuning keywords.</p>`,
  },
  // ── 20: Setup ──
  {
    role: 'user',
    timestamp: 'April 10, 2026 7:40 PM',
    text: '<p>This sounds complex. How hard is it to set up?</p>',
  },
  // ── 21: Setup wizard ──
  {
    role: 'assistant',
    timestamp: 'April 10, 2026 7:40 PM',
    timer: '3.1s',
    reasoning: '<p>Setup friction is a common concern. The wizard, import tool, and "just markdown" format address all three barriers to adoption.</p>',
    text: `<p>Five minutes with the <strong>Setup Wizard</strong> (<code>/dle-setup</code>). It walks you through:</p>
<ol>
<li>Connecting your Obsidian vault (just the URL \u2014 DLE uses the built-in CORS proxy, no server plugin needed)</li>
<li>Setting up AI search (choose a connection profile or custom proxy endpoint)</li>
<li>Configuring your vault tag (which Obsidian notes are lore entries)</li>
<li>Optionally defining custom gating fields</li>
</ol>
<p>If you're migrating from SillyTavern's built-in World Info, <code>/dle-import</code> converts your existing JSON to Obsidian vault notes with proper frontmatter \u2014 keywords, summaries, tags, everything.</p>
<p>Your vault entries are just regular Obsidian markdown files with YAML frontmatter. No special format. You can start with plain notes and add metadata incrementally.</p>`,
  },
  // ── 22: Drawer ──
  {
    role: 'user',
    timestamp: 'April 10, 2026 7:41 PM',
    text: '<p>What\'s all the stuff in the side panel?</p>',
  },
  // ── 23: Drawer tour ──
  {
    role: 'assistant',
    timestamp: 'April 10, 2026 7:41 PM',
    timer: '4.5s',
    reasoning: '<p>The drawer is the primary UI surface. Let me give a complete tour \u2014 all five tabs, the status zone, and the footer with its health indicators.</p>',
    text: `<p>The DLE drawer has <strong>five tabs</strong> and two status zones:</p>
<p><strong>Tabs:</strong></p>
<ul>
<li><strong>Why?</strong> \u2014 injection results, filtered entries, per-generation diff</li>
<li><strong>Browse</strong> \u2014 searchable vault explorer with filters, heatmap, inline controls</li>
<li><strong>Gating</strong> \u2014 view and edit contextual filters (era, location, scene, characters, custom fields)</li>
<li><strong>Librarian</strong> \u2014 lore gap inbox with AI-detected missing entries</li>
<li><strong>Tools</strong> \u2014 one-click buttons for all 30+ slash commands, organized by category</li>
</ul>
<p><strong>Status zone</strong> (top) \u2014 color-coded pipeline health dot, entry count and mode, token budget bar that shifts from green to red as you approach the limit, active gating filters, and quick action buttons.</p>
<p><strong>Footer</strong> (bottom) \u2014 context window usage bar, recent activity feed, five health indicator icons (vault, connection, pipeline, cache, AI service), and session statistics that accumulate across chat switches.</p>
<p>Everything updates in real time as you chat.</p>`,
  },
];

// ═══════════════════════════════════════════════════════════════════
//  BUILD & INJECT
// ═══════════════════════════════════════════════════════════════════
const chatHTML = messages.map((msg, i) =>
  buildMessage(i, msg, i === messages.length - 1)
).join('');

const indexPath = path.join(__dirname, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');

const chatOpenTag = '<div id="chat">';
const chatStartIdx = html.indexOf(chatOpenTag);
if (chatStartIdx === -1) { console.error('Could not find <div id="chat">'); process.exit(1); }

const formSheldIdx = html.indexOf('<div id="form_sheld"');
if (formSheldIdx === -1) { console.error('Could not find <div id="form_sheld">'); process.exit(1); }

// Replace everything between chat open tag and form_sheld with our messages + chat close
const before = html.slice(0, chatStartIdx + chatOpenTag.length);
const after = html.slice(formSheldIdx);

html = before + '\n' + chatHTML + '\n        </div>\n        ' + after;

fs.writeFileSync(indexPath, html, 'utf8');
console.log(`\u2705 Built ${messages.length} messages into index.html`);
