/**
 * DeepLore Enhanced — Auto Lorebook Creation
 * Fixes Bug 1 (callAutoSuggest st mode) and Bug 3 (scan depth)
 */
import { escapeHtml } from '../../../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../../popup.js';
import { getSettings, getPrimaryVault } from '../../settings.js';
import { writeNote } from '../vault/obsidian-api.js';
import { buildAiChatContext, yamlEscape, classifyError } from '../../core/utils.js';
import { callAI, extractAiResponseClient } from './ai.js';
import { vaultIndex, chatEpoch, isAiCircuitOpen, tryAcquireHalfOpenProbe } from '../state.js';
import { stripObsidianSyntax } from '../helpers.js';
import { ensureIndexFresh } from '../vault/vault.js';

const DEFAULT_AUTO_SUGGEST_PROMPT = `You are a lore analyst for a roleplay session. Analyze the recent chat and identify characters, locations, items, concepts, or events that are mentioned but do NOT have an existing lorebook entry.

For each suggested entry, provide:
- "title": A short, unique title for the entry
- "type": One of "character", "location", "lore", "organization", "story"
- "keys": Array of 2-5 trigger keywords that would match this entry
- "summary": A brief description of what this entry is and when to select it (for AI search)
- "content": A 2-3 paragraph description based on what is known from the chat context

Respond with a JSON array of suggested entries. If nothing new is worth creating, respond with [].
Example: [{"title": "The Silver Crown", "type": "lore", "keys": ["silver crown", "crown"], "summary": "A magical artifact mentioned in the throne room scene.", "content": "The Silver Crown is a..."}]`;

/**
 * Route an Auto Suggest AI call based on connection mode (mirrors callScribe pattern).
 * BUG 1 FIX: st mode now uses object form of generateQuietPrompt.
 */
export async function callAutoSuggest(systemPrompt, userMessage) {
    if (isAiCircuitOpen() && !tryAcquireHalfOpenProbe()) {
        throw new Error('AI circuit breaker is open — skipping auto-suggest');
    }

    const settings = getSettings();
    const mode = settings.autoSuggestConnectionMode;
    const timeout = settings.autoSuggestTimeout;
    const maxTokens = settings.autoSuggestMaxTokens;

    if (mode === 'st') {
        // Note: generateQuietPrompt cannot be aborted — timed-out generation completes in background
        const quietPrompt = `${systemPrompt}\n\n${userMessage}`;
        // BUG-FIX: timeout=0 should mean "no timeout", not "instant timeout" (setTimeout(fn, 0) fires immediately)
        const effectiveTimeout = timeout || 60000;
        const { generateQuietPrompt } = SillyTavern.getContext();
        const quietPromise = generateQuietPrompt({ quietPrompt, skipWIAN: true, responseLength: maxTokens });
        let suggestTimer;
        const response = await Promise.race([
            quietPromise.finally(() => clearTimeout(suggestTimer)),
            new Promise((_, reject) => { suggestTimer = setTimeout(() => {
                console.warn('[DLE] Auto-suggest quiet prompt timed out — orphaned generation may still complete in background');
                reject(new Error(`Auto-suggest quiet prompt timed out (${Math.round(effectiveTimeout / 1000)}s)`));
            }, effectiveTimeout); }),
        ]);
        return { text: response, usage: null };
    } else if (mode === 'profile' || mode === 'proxy') {
        return await callAI(systemPrompt, userMessage, {
            mode,
            profileId: settings.autoSuggestProfileId,
            proxyUrl: settings.autoSuggestProxyUrl,
            model: settings.autoSuggestModel,
            maxTokens,
            timeout,
        });
    }
    throw new Error(`Unknown auto-suggest connection mode: ${mode}`);
}

let autoSuggestInProgress = false;

/**
 * Run auto-suggest: analyze chat for entities not in lorebook, return suggestions.
 * BUG 3 FIX: Uses aiSearchScanDepth instead of autoSuggestInterval for chat context depth.
 */
export async function runAutoSuggest() {
    if (autoSuggestInProgress) return [];
    autoSuggestInProgress = true;
    const epoch = chatEpoch;
    try {
    const settings = getSettings();
    await ensureIndexFresh();
    if (epoch !== chatEpoch) return []; // chat changed during index refresh

    const existingTitles = vaultIndex.map(e => `"${e.title.replace(/"/g, '\\"')}"`).join(', ');
    // BUG 3 FIX: Use a proper scan depth, not the interval frequency
    const { chat } = SillyTavern.getContext();
    const chatContext = buildAiChatContext(chat, settings.aiSearchScanDepth || 20);

    const systemPrompt = DEFAULT_AUTO_SUGGEST_PROMPT;
    const userMessage = `## Existing lorebook entries (do NOT suggest these):\n${existingTitles}\n\n## Recent Chat:\n${chatContext}\n\nSuggest new lorebook entries as a JSON array.`;

    const result = await callAutoSuggest(systemPrompt, userMessage);
    const parsed = extractAiResponseClient(result.text);

    if (!Array.isArray(parsed)) return [];

    // Filter out entries that already exist
    const existingLower = new Set(vaultIndex.map(e => e.title.toLowerCase()));
    return parsed.filter(s =>
        s && typeof s === 'object' && s.title &&
        !existingLower.has(s.title.toLowerCase())
    );
    } finally {
        autoSuggestInProgress = false;
    }
}

/**
 * Show suggestion popup with editable fields and accept/reject buttons.
 */
export async function showSuggestionPopup(suggestions) {
    if (!suggestions || suggestions.length === 0) {
        toastr.info('No new entries suggested.', 'DeepLore Enhanced');
        return;
    }

    const settings = getSettings();
    const container = document.createElement('div');
    container.classList.add('dle-popup');

    let cardsHtml = '';
    for (let i = 0; i < suggestions.length; i++) {
        const s = suggestions[i];
        cardsHtml += `
            <div id="dle-suggest-${i}" class="dle-suggest-card dle-card">
                <div class="dle-card-header dle-mb-1">
                    <strong>${escapeHtml(s.title || 'Untitled')}</strong>
                    <span class="dle-text-xs dle-muted">${escapeHtml(s.type || 'lore')}</span>
                </div>
                <div class="dle-text-sm dle-mb-1">
                    <strong>Keywords:</strong> ${escapeHtml((s.keys || []).join(', '))}
                </div>
                <div class="dle-text-sm dle-mb-1">
                    <strong>Summary:</strong> ${escapeHtml(s.summary || '')}
                </div>
                <details>
                    <summary class="dle-text-sm dle-cursor-pointer">Content preview</summary>
                    <div class="dle-preview dle-preview--short dle-mt-1">${escapeHtml(s.content || '')}</div>
                </details>
                <div class="dle-flex dle-mt-1 dle-gap-1">
                    <button class="menu_button dle-accept-suggest dle-text-sm" data-index="${i}">Accept</button>
                    <button class="menu_button dle-reject-suggest dle-text-sm dle-muted" data-index="${i}">Reject</button>
                </div>
            </div>`;
    }

    container.innerHTML = `
        <h3>Suggested Entries (${suggestions.length})</h3>
        <p class="dle-muted dle-text-sm">Review each suggestion. Accept to write to Obsidian, reject to skip.</p>
        <label class="checkbox_label dle-text-sm dle-checkbox-row">
            <input type="checkbox" class="checkbox" id="dle-suggest-skip-review" ${settings.autoSuggestSkipReview ? 'checked' : ''}>
            <span>Write directly (skip review)</span>
        </label>
        ${cardsHtml}
    `;

    await callGenericPopup(container, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        onOpen: () => {
            // E11: Sync skip-review checkbox with settings
            const skipCheckbox = container.querySelector('#dle-suggest-skip-review');
            if (skipCheckbox) {
                skipCheckbox.addEventListener('change', function () {
                    settings.autoSuggestSkipReview = this.checked;
                    SillyTavern.getContext().saveSettingsDebounced();
                });
            }

            container.querySelectorAll('.dle-accept-suggest').forEach(btn => {
                btn.addEventListener('click', async function () {
                    if (this.disabled) return; // Double-click guard
                    this.disabled = true;
                    const idx = Number(this.dataset.index);
                    const s = suggestions[idx];
                    const card = document.getElementById(`dle-suggest-${idx}`);
                    if (!card) { this.disabled = false; return; }

                    // Build frontmatter
                    const folder = settings.autoSuggestFolder || '';
                    // Sanitize title for filesystem safety (same pattern as Scribe)
                    let safeTitle = s.title.replace(/[<>:"/\\|?*]/g, '_');
                    safeTitle = safeTitle.replace(/^\.+|\.+$/g, ''); // strip leading/trailing dots
                    safeTitle = safeTitle.trimEnd(); // strip trailing spaces
                    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(safeTitle)) safeTitle = '_' + safeTitle;
                    if (!safeTitle) safeTitle = 'Untitled';
                    const filename = folder
                        ? `${folder}/${safeTitle}.md`
                        : `${safeTitle}.md`;

                    const keysYaml = (s.keys || []).map(k => `  - ${yamlEscape(k)}`).join('\n');
                    // Sanitize AI-generated content: strip Obsidian-interpretable syntax and bare YAML delimiters
                    const safeContent = stripObsidianSyntax(s.content || '').replace(/^---$/gm, '- - -');
                    const fileContent = `---
type: ${yamlEscape(s.type || 'lore')}
priority: 50
tags:
  - ${settings.lorebookTag}
keys:
${keysYaml}
summary: "${(s.summary || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"
---
# ${s.title}

${safeContent}`;

                    try {
                        const suggestVault = getPrimaryVault(settings);
                        const data = await writeNote(suggestVault.host, suggestVault.port, suggestVault.apiKey, filename, fileContent);
                        if (data.ok) {
                            card.classList.add('dle-suggest-card--accepted');
                            this.disabled = true;
                            this.textContent = 'Accepted';
                            toastr.success(`Created: ${s.title}`, 'DeepLore Enhanced');
                        } else {
                            toastr.error(`Could not create entry: ${data.error}`, 'DeepLore Enhanced');
                        }
                    } catch (err) {
                        toastr.error(classifyError(err), 'DeepLore Enhanced');
                        this.disabled = false; // Re-enable on error
                    }
                });
            });

            container.querySelectorAll('.dle-reject-suggest').forEach(btn => {
                btn.addEventListener('click', function () {
                    const idx = Number(this.dataset.index);
                    const card = document.getElementById(`dle-suggest-${idx}`);
                    if (card) {
                        card.classList.add('dle-suggest-card--rejected');
                        // Disable both buttons and update label
                        card.querySelectorAll('button').forEach(b => b.disabled = true);
                        this.textContent = 'Rejected';
                    }
                });
            });
        },
    });
}
