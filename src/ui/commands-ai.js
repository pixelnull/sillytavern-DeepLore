/**
 * DeepLore Enhanced — Slash Commands: AI Features
 * /dle-optimize-keys, /dle-newlore, /dle-suggest, /dle-scribe, /dle-review, /dle-summarize
 */
import {
    sendMessageAsUser,
    Generate,
} from '../../../../../../script.js';
import { escapeHtml } from '../../../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../../popup.js';
import { SlashCommandParser } from '../../../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../../../slash-commands/SlashCommand.js';
import { classifyError, NO_ENTRIES_MSG, yamlEscape } from '../../core/utils.js';
import { getSettings, getPrimaryVault, getConnectionConfig } from '../../settings.js';
import { vaultIndex, scribeInProgress, setIndexTimestamp } from '../state.js';
import { buildIndex, ensureIndexFresh, getMaxResponseTokens } from '../vault/vault.js';
import { runScribe } from '../ai/scribe.js';
import { runAutoSuggest, showSuggestionPopup } from '../ai/auto-suggest.js';
import { optimizeEntryKeys, showOptimizePopup } from './popups.js';

export function registerAiCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-optimize-keys',
        callback: async (_args, entryName) => {
            try { await ensureIndexFresh(); } catch (err) {
                toastr.error('Could not refresh vault index.', 'DeepLore Enhanced');
                console.error('[DLE] ensureIndexFresh failed in /dle-optimize-keys:', err);
                return '';
            }
            if (vaultIndex.length === 0) {
                toastr.info(NO_ENTRIES_MSG, 'DeepLore Enhanced');
                return '';
            }
            const name = (entryName || '').trim();
            if (!name) {
                toastr.info('Usage: /dle-optimize-keys <entry name>', 'DeepLore Enhanced');
                return '';
            }
            const entry = vaultIndex.find(e => e.title.toLowerCase() === name.toLowerCase());
            if (!entry) {
                toastr.warning(`Entry "${name}" not found.`, 'DeepLore Enhanced');
                return '';
            }
            const loadingToast = toastr.info(`Optimizing keywords for "${entry.title}"...`, 'DeepLore Enhanced', { timeOut: 0, extendedTimeOut: 0 });
            try {
                const result = await optimizeEntryKeys(entry);
                toastr.clear(loadingToast);
                await showOptimizePopup(entry, result);
            } catch (err) {
                toastr.clear(loadingToast);
                console.error('[DLE] Optimize keys error:', err);
                toastr.error(classifyError(err), 'DeepLore Enhanced');
            }
            return '';
        },
        helpString: 'Suggest better keywords for an entry using AI. Usage: /dle-optimize-keys <entry name>.',
        returns: 'Optimization popup',
    }));

    const newloreCallback = async () => {
        const { chat } = SillyTavern.getContext();
        if (!chat || chat.length === 0) {
            toastr.info('No active chat.', 'DeepLore Enhanced');
            return '';
        }
        const loadingToast = toastr.info('Analyzing chat for new entries...', 'DeepLore Enhanced', { timeOut: 0, extendedTimeOut: 0 });
        try {
            const suggestions = await runAutoSuggest();
            toastr.clear(loadingToast);
            await showSuggestionPopup(suggestions);
        } catch (err) {
            toastr.clear(loadingToast);
            console.error('[DLE] Auto-suggest error:', err);
            toastr.error(classifyError(err), 'DeepLore Enhanced');
        }
        return '';
    };
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-newlore',
        callback: newloreCallback,
        helpString: 'Analyze the chat for characters, locations, and concepts not in your lorebook, and suggest new entries to create.',
        returns: 'Suggestion popup',
    }));
    // Backwards-compatible alias
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-suggest',
        callback: newloreCallback,
        helpString: 'Analyze the chat and suggest new lorebook entries. Alias for /dle-newlore.',
        returns: 'Suggestion popup',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-scribe',
        callback: async (_args, userPrompt) => {
            if (scribeInProgress) {
                toastr.warning('A session summary is already being written. Wait for it to finish.', 'DeepLore Enhanced');
                return '';
            }
            toastr.info('Writing session note...', 'DeepLore Enhanced');
            await runScribe(userPrompt?.trim() || '');
            return 'Session note written.';
        },
        helpString: 'Write a session summary note to Obsidian. Usage: /dle-scribe <focus topic>. Example: /dle-scribe What happened with the sword?',
        returns: 'Status message',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-review',
        callback: async (_args, userPrompt) => {
            try {
            await ensureIndexFresh();

            if (vaultIndex.length === 0) {
                toastr.info(NO_ENTRIES_MSG, 'DeepLore Enhanced');
                return '';
            }

            const settings = getSettings();
            const totalTokens = vaultIndex.reduce((sum, e) => sum + e.tokenEstimate, 0);

            const confirmed = await callGenericPopup(
                `<p>This will send <b>${vaultIndex.length}</b> entries (~${totalTokens} tokens) as a message and generate an AI response.</p><p>This may be expensive. Continue?</p>`,
                POPUP_TYPE.CONFIRM, '', {},
            );
            if (!confirmed) return '';

            const loreDump = vaultIndex.map(entry => {
                return `## ${entry.title}\n${entry.content}`;
            }).join('\n\n---\n\n');

            const responseTokens = settings.reviewResponseTokens > 0
                ? settings.reviewResponseTokens
                : getMaxResponseTokens();
            const budgetHint = `\n\nKeep your response under ${responseTokens} tokens.`;
            const defaultQuestion = 'Review this lorebook/world-building vault. Comment on consistency, gaps, interesting connections between entries, and any suggestions for improvement.';
            const question = (userPrompt && userPrompt.trim()) ? userPrompt.trim() : defaultQuestion;

            const message = `[DeepLore Enhanced Review — ${vaultIndex.length} entries, ~${totalTokens} tokens]\n\n${loreDump}\n\n---\n\n${question}${budgetHint}`;
            if (settings.debugMode) {
                console.log('[DLE] Lore review prompt:', message);
            }

            toastr.info(`Sending ${vaultIndex.length} entries (~${totalTokens} tokens)...`, 'DeepLore Enhanced', { timeOut: 5000 });

            await sendMessageAsUser(message, '');
            await Generate('normal');

            return '';
            } catch (err) {
                toastr.error('Review failed: ' + err.message, 'DeepLore Enhanced');
                return '';
            }
        },
        helpString: 'Send the entire vault to the AI for review and feedback. Usage: /dle-review <question>. Example: /dle-review What inconsistencies do you see?',
        returns: 'AI review posted to chat',
    }));

    // ── Auto-Summary Generation ──

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-summarize',
        callback: async () => {
            try { await ensureIndexFresh(); } catch (err) {
                toastr.error('Could not refresh vault index.', 'DeepLore Enhanced');
                console.error('[DLE] ensureIndexFresh failed in /dle-summarize:', err);
                return '';
            }
            if (vaultIndex.length === 0) {
                toastr.info(NO_ENTRIES_MSG, 'DeepLore Enhanced');
                return '';
            }

            const missingSummary = vaultIndex.filter(e => !e.summary || !e.summary.trim());
            if (missingSummary.length === 0) {
                toastr.success('All entries already have summaries.', 'DeepLore Enhanced');
                return '';
            }

            const confirmed = await callGenericPopup(
                `<p>Found <b>${missingSummary.length}</b> entries without AI search summaries.</p>
                <p>This will generate summaries using your AI search connection and present each for review before writing to Obsidian.</p>
                <p>Continue?</p>`,
                POPUP_TYPE.CONFIRM, '', {},
            );
            if (!confirmed) return '';

            const result = await summarizeEntries(missingSummary);
            const msg = `Done: ${result.generated} written, ${result.skipped} skipped, ${result.failed} failed.`;
            toastr.success(msg, 'DeepLore Enhanced');

            if (result.generated > 0) {
                setIndexTimestamp(0);
                await buildIndex();
            }
            return '';
        },
        helpString: 'Generate AI search summaries for entries that are missing them. Each summary is presented for review before writing.',
        returns: 'Summary generation status',
    }));
}

/**
 * Generate AI summaries for a list of vault entries.
 * Each summary is presented for review before writing to Obsidian.
 * @param {Array} entries - VaultEntry objects to summarize
 * @returns {{ generated: number, skipped: number, failed: number }}
 */
export async function summarizeEntries(entries) {
    const { callAI } = await import('../ai/ai.js');
    const { writeNote, obsidianFetch, encodeVaultPath } = await import('../vault/obsidian-api.js');
    const settings = getSettings();
    const vault = getPrimaryVault(settings);

    let generated = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        toastr.info(`Generating summary ${i + 1}/${entries.length}: "${entry.title}"...`, 'DeepLore Enhanced', { timeOut: 0, extendedTimeOut: 0 });

        try {
            const systemPrompt = 'You are a lore librarian. Write a concise AI search summary (max 600 chars) for the following lorebook entry. The summary should answer: What is this? When should it be selected? Key relationships? Do NOT include physical descriptions or atmospheric prose. Write for an AI that needs to decide whether to inject this entry.';
            const userMsg = `Entry: ${entry.title}\n\nContent:\n${entry.content.substring(0, 3000)}`;

            const result = await callAI(systemPrompt, userMsg, getConnectionConfig('aiSearch', { maxTokens: 300 }));
            const responseText = result.text;

            const summary = responseText.trim().substring(0, 600);
            if (!summary) {
                failed++;
                continue;
            }

            // Present for review
            const reviewHtml = `
                <div class="dle-popup">
                    <h4>${escapeHtml(entry.title)} (${i + 1}/${entries.length})</h4>
                    <p class="dle-text-sm dle-muted">Entry content preview: ${escapeHtml(entry.content.substring(0, 200))}...</p>
                    <hr>
                    <p><b>Generated Summary:</b></p>
                    <textarea id="dle-summary-edit" class="text_pole dle-summary-textarea">${escapeHtml(summary)}</textarea>
                    <p class="dle-text-xs dle-faint">Edit the summary above if needed. Click OK to write to Obsidian, Cancel to skip.</p>
                </div>`;

            let capturedTextarea = null;
            const approved = await callGenericPopup(reviewHtml, POPUP_TYPE.CONFIRM, '', {
                wide: true,
                onOpen: () => { capturedTextarea = document.getElementById('dle-summary-edit'); },
            });

            if (!approved) {
                skipped++;
                continue;
            }

            const finalSummary = capturedTextarea?.value?.trim() || summary;

            // Read current file, inject summary into frontmatter, write back
            const fileResult = await obsidianFetch({
                host: vault.host,
                port: vault.port,
                apiKey: vault.apiKey,
                path: `/vault/${encodeVaultPath(entry.filename)}`,
                accept: 'text/markdown',
            });

            if (fileResult.status !== 200) {
                failed++;
                console.warn(`[DLE] Failed to read ${entry.filename}: HTTP ${fileResult.status}`);
                continue;
            }

            // Insert summary into frontmatter
            let fileContent = fileResult.data;
            if (fileContent.startsWith('---')) {
                const endIdx = fileContent.indexOf('---', 3);
                if (endIdx > 0) {
                    const fmSection = fileContent.substring(0, endIdx);
                    const rest = fileContent.substring(endIdx);
                    // Remove existing summary line if present
                    const cleaned = fmSection.replace(/^summary:.*$/m, '').replace(/\n{3,}/g, '\n\n');
                    fileContent = cleaned + `summary: ${yamlEscape(finalSummary)}\n` + rest;
                }
            }

            const writeResult = await writeNote(vault.host, vault.port, vault.apiKey, entry.filename, fileContent);
            if (writeResult.ok) {
                generated++;
            } else {
                failed++;
            }
        } catch (err) {
            console.error(`[DLE] Summary generation error for "${entry.title}":`, err);
            failed++;
        }
    }

    return { generated, skipped, failed };
}
