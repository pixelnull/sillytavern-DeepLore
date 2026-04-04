/**
 * DeepLore Enhanced — Session Scribe
 */
import { getSettings, getPrimaryVault, getConnectionConfig } from '../../settings.js';
import { writeNote } from '../vault/obsidian-api.js';
import { buildAiChatContext } from '../../core/utils.js';
import { callAI } from './ai.js';
import { stripObsidianSyntax } from '../helpers.js';
import {
    scribeInProgress, lastScribeSummary, lastScribeChatLength, chatEpoch,
    setScribeInProgress, setLastScribeSummary, setLastScribeChatLength,
} from '../state.js';
import { dedupError, dedupWarning } from '../toast-dedup.js';

export const DEFAULT_SCRIBE_PROMPT = `Summarize this roleplay session segment. Write in past tense, third person.

Cover:
- Key events and plot developments (what happened, decisions made, consequences)
- Character dynamics (relationship shifts, emotional moments, conflicts, alliances)
- New information revealed (world-building, backstory, secrets, lore)
- State changes (injuries, location moves, items gained/lost, powers used)

If a previous session note is provided, do NOT repeat what it already covers — only add new developments since then.

Format with markdown headings and bullet points. Be specific — use character names and concrete details, not vague summaries.`;

let _orphanedScribePending = false;

/**
 * Route a Scribe AI call based on the configured connection mode.
 * @param {string} systemPrompt - System prompt text
 * @param {string} userMessage - User message content (chat context + instructions)
 * @param {typeof import('../settings.js').defaultSettings} settings - Current settings
 * @returns {Promise<string>} Generated summary text
 */
export async function callScribe(systemPrompt, userMessage, settings) {
    const connConfig = getConnectionConfig('scribe');
    const mode = connConfig.mode || 'st';

    if (mode === 'profile' || mode === 'proxy') {
        const result = await callAI(systemPrompt, userMessage, connConfig);
        return result.text || '';
    }

    // Default: 'st' mode — use SillyTavern's active connection via generateQuietPrompt
    // Note: generateQuietPrompt cannot be aborted — timed-out generation completes in background.
    // _orphanedScribePending guards against overlapping calls that waste API tokens.
    if (_orphanedScribePending) {
        throw new Error('Scribe skipped — a previous ST generation is still running in the background');
    }
    const quietPrompt = `${systemPrompt}\n\n${userMessage}`;
    // BUG-FIX: timeout=0 should mean "no timeout", not "instant timeout" (setTimeout(fn, 0) fires immediately)
    const timeout = connConfig.timeout || 60000;
    const { generateQuietPrompt } = SillyTavern.getContext();
    _orphanedScribePending = true;
    const quietPromise = generateQuietPrompt({ quietPrompt, skipWIAN: true, responseLength: connConfig.maxTokens });
    let scribeTimer;
    try {
        return await Promise.race([
            quietPromise.finally(() => { _orphanedScribePending = false; clearTimeout(scribeTimer); }),
            new Promise((_, reject) => { scribeTimer = setTimeout(() => {
                console.warn('[DLE] Scribe quiet prompt timed out — orphaned generation may still complete in background');
                reject(new Error(`Scribe quiet prompt timed out (${Math.round(timeout / 1000)}s)`));
            }, timeout); }),
        ]);
    } catch (err) {
        // On timeout, _orphanedScribePending stays true until the orphaned promise resolves
        throw err;
    }
}

/**
 * Run Session Scribe: summarize recent chat and write to Obsidian.
 * @param {string} [customPrompt] - Optional custom focus/question
 */
export async function runScribe(customPrompt) {
    if (scribeInProgress) return;
    setScribeInProgress(true);

    // Capture epoch to detect chat changes during async scribe work
    const epoch = chatEpoch;

    try {
        const settings = getSettings();
        const { chat, chatMetadata, name2, saveChatDebounced } = SillyTavern.getContext();
        if (!chat || chat.length === 0) {
            toastr.info('No active chat to summarize.', 'DeepLore Enhanced');
            return;
        }

        // Build context using shared utility with configurable depth
        const context = buildAiChatContext(chat, settings.scribeScanDepth);
        if (!context.trim()) {
            dedupWarning('No messages to summarize.', 'scribe');
            return;
        }

        // Build system prompt
        const systemPrompt = settings.scribePrompt?.trim() || DEFAULT_SCRIBE_PROMPT;

        // Build user message with optional prior note context and custom focus
        const parts = [];
        if (lastScribeSummary) {
            parts.push(`[PREVIOUS SESSION NOTE]\n${lastScribeSummary}`);
        }
        parts.push(`[RECENT CONVERSATION]\n${context}`);
        if (customPrompt) {
            parts.push(`[ADDITIONAL FOCUS]\n${customPrompt}`);
        }
        const userMessage = parts.join('\n\n');

        // Generate summary via configured connection
        const summary = await callScribe(systemPrompt, userMessage, settings);

        if (!summary || !summary.trim()) {
            dedupWarning('Scribe generated an empty summary.', 'scribe');
            return;
        }

        // Sanitize AI output: strip Obsidian-interpretable syntax and bare YAML delimiters
        const sanitizedSummary = stripObsidianSyntax(summary).replace(/^---$/gm, '- - -');

        // Build filename and content
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10);
        const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '-');
        let charName = (name2 || 'Unknown').replace(/[<>:"/\\|?*]/g, '_');
        charName = charName.replace(/^\.+|\.+$/g, ''); // strip leading/trailing dots
        charName = charName.trimEnd(); // strip trailing spaces
        // Prefix Windows reserved names to prevent filesystem conflicts
        if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(charName)) {
            charName = '_' + charName;
        }
        if (!charName) charName = 'Unknown';
        const filename = `${settings.scribeFolder}/${charName} - ${dateStr} ${timeStr}.md`;

        const noteContent = `---\ntags:\n  - lorebook-session\ndate: ${now.toISOString()}\ncharacter: "${charName.replace(/"/g, '\\"')}"\n---\n# Session: ${charName} - ${dateStr} ${timeStr}\n\n${sanitizedSummary.trim()}\n`;

        // Bail if chat changed during async scribe work
        if (epoch !== chatEpoch) {
            if (getSettings().debugMode) console.log('[DLE] Scribe: chat changed during generation, discarding result');
            return;
        }

        // Write to Obsidian directly (uses primary vault)
        const scribeVault = getPrimaryVault(settings);
        const data = await writeNote(scribeVault.host, scribeVault.port, scribeVault.apiKey, filename, noteContent);

        if (data.ok) {
            // Re-check epoch after async writeNote to avoid writing to wrong chat's metadata
            if (epoch !== chatEpoch) {
                if (getSettings().debugMode) console.log('[DLE] Scribe: chat changed during note write, skipping metadata update');
                return;
            }
            setLastScribeSummary(sanitizedSummary.trim());
            setLastScribeChatLength(SillyTavern.getContext().chat?.length || 0); // Use current length, not stale start value
            chatMetadata.deeplore_lastScribeSummary = lastScribeSummary;
            saveChatDebounced();
            toastr.success(`Session note saved: ${filename}`, 'DeepLore Enhanced', { timeOut: 5000 });
        } else {
            dedupError(`Failed to save session note: ${data.error}`, 'scribe');
        }
    } catch (err) {
        console.error('[DLE] Session Scribe error:', err);
        dedupError(`Scribe error: ${err.message}`, 'scribe');
    } finally {
        // Only reset if we're still the active scribe (CHAT_CHANGED may have already reset it)
        if (epoch === chatEpoch) {
            setScribeInProgress(false);
        }
    }
}
