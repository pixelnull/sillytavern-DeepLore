/** DeepLore — Slash Commands: AI Features */
import {
    sendMessageAsUser,
    Generate,
    chat,
    eventSource,
    event_types,
} from '../../../../../../script.js';
import { escapeHtml } from '../../../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../../popup.js';
import { SlashCommandParser } from '../../../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../../../slash-commands/SlashCommand.js';
import { SlashCommandArgument, ARGUMENT_TYPE } from '../../../../../slash-commands/SlashCommandArgument.js';
import { SlashCommandEnumValue } from '../../../../../slash-commands/SlashCommandEnumValue.js';
import { classifyError, NO_ENTRIES_MSG, yamlEscape } from '../../core/utils.js';
import { getSettings, getPrimaryVault, resolveConnectionConfig } from '../../settings.js';
import { vaultIndex, scribeInProgress, setIndexTimestamp, setSkipNextPipeline, loreGaps, tryAcquireHalfOpenProbe, recordAiSuccess, recordAiFailure, releaseHalfOpenProbe } from '../state.js';
import { buildIndex, ensureIndexFresh, getMaxResponseTokens } from '../vault/vault.js';
import { runScribe } from '../ai/scribe.js';
import { runAutoSuggest, showSuggestionPopup } from '../ai/auto-suggest.js';
import { optimizeEntryKeys, showOptimizePopup } from './popups.js';
import { parseRange, summarizeRange, rollbackSummary, listSummaries } from '../ai/summarize.js';
import { ensureFreshOrToast, resolveEntryByName } from './commands-shared.js';
import { tr, trf } from '../i18n/i18n.js';
import { notify } from '../toast-dedup.js';
import { abortWith } from '../diagnostics/interceptors.js';

export function registerAiCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-optimize-keys',
        callback: async (_args, entryName) => {
            if (!await ensureFreshOrToast('/dle-optimize-keys')) return '';
            if (vaultIndex.length === 0) {
                toastr.info(NO_ENTRIES_MSG, 'DeepLore');
                return '';
            }
            const name = (entryName || '').trim();
            if (!name) {
                toastr.info(tr('dle_cmd_optimizekeys_usage_toast'), 'DeepLore');
                return '';
            }
            // Shared fuzzy resolver so a typo / partial name doesn't drop on the floor.
            const entry = await resolveEntryByName(name, vaultIndex, { commandLabel: 'Optimize keys' });
            if (!entry) return '';
            const loadingToast = toastr.info(trf('dle_cmd_optimizekeys_loading_toast', entry.title), 'DeepLore', { timeOut: 0, extendedTimeOut: 0 });
            try {
                const result = await optimizeEntryKeys(entry);
                toastr.clear(loadingToast);
                await showOptimizePopup(entry, result);
            } catch (err) {
                toastr.clear(loadingToast);
                console.error('[DLE] Optimize keys error:', err);
                notify.error(classifyError(err), { copyable: true });
            }
            return '';
        },
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'vault entry title',
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: true,
            enumProvider: () => vaultIndex.map(e => new SlashCommandEnumValue(e.title)),
        })],
        helpString: 'Suggest better keywords for an entry using AI. Usage: /dle-optimize-keys <entry name>.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    const newloreCallback = async () => {
        if (!chat || chat.length === 0) {
            toastr.info(tr('dle_cmd_newlore_nochat_toast'), 'DeepLore');
            return '';
        }
        const loadingToast = toastr.info(tr('dle_cmd_newlore_analyzing_toast'), 'DeepLore', { timeOut: 0, extendedTimeOut: 0 });
        try {
            const suggestions = await runAutoSuggest();
            toastr.clear(loadingToast);
            await showSuggestionPopup(suggestions);
        } catch (err) {
            toastr.clear(loadingToast);
            console.error('[DLE] Auto-suggest error:', err);
            notify.error(classifyError(err), { copyable: true });
        }
        return '';
    };
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-newlore',
        callback: newloreCallback,
        helpString: 'Analyze the chat for characters, locations, and concepts not in your lorebook, and suggest new entries to create.',
        returns: ARGUMENT_TYPE.STRING,
    }));
    // Backwards-compatible alias.
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-suggest',
        callback: newloreCallback,
        helpString: 'Analyze the chat and suggest new lorebook entries. Alias for /dle-newlore.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-scribe',
        callback: async (_args, userPrompt) => {
            if (scribeInProgress) {
                toastr.warning(tr('dle_cmd_scribe_inprogress_toast'), 'DeepLore');
                return '';
            }
            // BUG-AUDIT-H23: missing scribeFolder would write to "undefined/".
            const settings = getSettings();
            if (!settings.scribeFolder) {
                toastr.warning(tr('dle_cmd_scribe_nofolder_toast'), 'DeepLore');
                return '';
            }
            toastr.info(tr('dle_cmd_scribe_writing_toast'), 'DeepLore');
            await runScribe(userPrompt?.trim() || '');
            return 'Session note written.';
        },
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'optional focus topic for the scribe',
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: false,
        })],
        helpString: 'Write a session summary note to Obsidian. Usage: /dle-scribe <focus topic>. Example: /dle-scribe What happened with the sword?',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-review',
        callback: async (_args, userPrompt) => {
            try {
            await ensureIndexFresh();

            // BUG-AUDIT Fix 21: lorebook-guide entries are Librarian-only and must
            // never reach the writing AI. /dle-review previously dumped raw vaultIndex,
            // leaking guide content as a persistent user message. Mirrors writer-visible
            // contract from getWriterVisibleEntries() / matchTextForExternal.
            const reviewEntries = vaultIndex.filter(e => !e.guide);

            if (reviewEntries.length === 0) {
                toastr.info(NO_ENTRIES_MSG, 'DeepLore');
                return '';
            }

            const settings = getSettings();
            const totalTokens = reviewEntries.reduce((sum, e) => sum + e.tokenEstimate, 0);

            const confirmed = await callGenericPopup(
                `<p>This will send <b>${reviewEntries.length}</b> entries (~${totalTokens} tokens) as a visible user message and generate an AI response.</p>
                <p class="dle-text-xs dle-muted">Warning: The review message will remain in chat history and may influence subsequent AI responses. Consider starting a new chat or deleting the messages afterward if you don't want this.</p>
                <p>This may be expensive. Continue?</p>`,
                POPUP_TYPE.CONFIRM, '', {},
            );
            if (!confirmed) return '';

            const loreDump = reviewEntries.map(entry => {
                return `## ${entry.title}\n${entry.content}`;
            }).join('\n\n---\n\n');

            const responseTokens = settings.reviewResponseTokens > 0
                ? settings.reviewResponseTokens
                : getMaxResponseTokens();
            const budgetHint = `\n\nKeep your response under ${responseTokens} tokens.`;
            const defaultQuestion = 'Review this lorebook/world-building vault. Comment on consistency, gaps, interesting connections between entries, and any suggestions for improvement.';
            const question = (userPrompt && userPrompt.trim()) ? userPrompt.trim() : defaultQuestion;

            const message = `[DeepLore Review — ${reviewEntries.length} entries, ~${totalTokens} tokens]\n\n${loreDump}\n\n---\n\n${question}${budgetHint}`;
            if (settings.debugMode) {
                console.log('[DLE] Lore review prompt:', message);
            }

            toastr.info(`Sending ${reviewEntries.length} entries (~${totalTokens} tokens)...`, 'DeepLore', { timeOut: 5000 });

            // Bypass DLE pipeline for this generation — review prompt is the entire vault.
            setSkipNextPipeline(true);
            try {
                await sendMessageAsUser(message, '');
                await Generate('normal');
            } finally {
                setSkipNextPipeline(false);
            }

            return '';
            } catch (err) {
                console.warn('[DLE] /dle-review failed:', err);
                toastr.error(tr('dle_cmd_review_error_msg'), 'DeepLore');
                return '';
            }
        },
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'optional question to ask about the vault',
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: false,
        })],
        helpString: 'Send the entire vault to the AI for review and feedback. Usage: /dle-review <question>. Example: /dle-review What inconsistencies do you see?',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-summarize',
        callback: async () => {
            if (!await ensureFreshOrToast('/dle-summarize')) return '';
            if (vaultIndex.length === 0) {
                toastr.info(NO_ENTRIES_MSG, 'DeepLore');
                return '';
            }

            const missingSummary = vaultIndex.filter(e => !e.summary || !e.summary.trim());
            if (missingSummary.length === 0) {
                toastr.success(tr('dle_cmd_summarize_allhave_toast'), 'DeepLore');
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
            let msg = `Done: ${result.generated} written, ${result.skipped} skipped, ${result.failed} failed`;
            if (result.aborted > 0) msg += `, ${result.aborted} aborted`;
            msg += '.';
            toastr.success(msg, 'DeepLore');

            if (result.generated > 0) {
                setIndexTimestamp(0);
                await buildIndex();
            }
            return '';
        },
        helpString: 'Generate AI search summaries for entries that are missing them. Each summary is presented for review before writing.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-librarian',
        callback: async (_args, subcommand) => {
            if (!getSettings().librarianEnabled) {
                toastr.warning(tr('dle_cmd_librarian_disabled_toast'), 'DeepLore');
                return '';
            }
            const { openLibrarianPopup } = await import('../librarian/librarian-review.js');
            const { loreGaps } = await import('../state.js');
            const sub = (subcommand || '').trim();

            if (sub.startsWith('gap ')) {
                const gapId = sub.slice(4).trim();
                const gap = loreGaps.find(g => g.id === gapId);
                if (!gap) {
                    toastr.warning(`Gap "${gapId}" not found.`, 'DeepLore');
                    return '';
                }
                await openLibrarianPopup('gap', { gap });
            } else if (sub === 'review') {
                await openLibrarianPopup('review');
            } else if (sub === 'audit') {
                await openLibrarianPopup('audit');
            } else {
                await openLibrarianPopup('new');
            }
            return '';
        },
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'subcommand: review | audit | gap <id>',
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: false,
            // Dynamic enum: static subcommands + gap-by-id for any open gaps.
            // MUST be sync — ST's SlashCommandAutoCompleteNameResult calls
            // enumProvider without awaiting and reads `.length` immediately, so
            // returning a Promise produces silent autocomplete failure.
            enumProvider: () => {
                const base = [
                    new SlashCommandEnumValue('review', 'open the review browser'),
                    new SlashCommandEnumValue('audit', 'audit existing entries'),
                ];
                const gaps = (Array.isArray(loreGaps) ? loreGaps : []).map(g =>
                    new SlashCommandEnumValue(`gap ${g.id}`, g.summary || g.title || g.id),
                );
                return [...base, ...gaps];
            },
        })],
        helpString: 'Open the Librarian AI session. Usage: /dle-librarian [gap &lt;id&gt; | review | audit]',
        returns: ARGUMENT_TYPE.STRING,
    }));

    // #15 — Dedicated summary feature: AI-summarize a chat range, hide originals, prepend summary.
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-summarize-range',
        callback: async (_args, rangeArg) => {
            if (!chat || chat.length === 0) {
                toastr.info(tr('dle_cmd_summarizerange_nochat_toast'), 'DeepLore');
                return '';
            }
            const range = parseRange(rangeArg || '', chat.length);
            if (!range) {
                toastr.warning(tr('dle_cmd_summarizerange_usage_toast'), 'DeepLore');
                return '';
            }
            const loading = toastr.info(`Summarizing messages ${range.start}–${range.end}...`, 'DeepLore', { timeOut: 0, extendedTimeOut: 0 });
            // L-16: summarizeRange accepts a signal but nothing ever passed one, so a
            // slow summary couldn't be cancelled and would mutate the chat even after
            // the user switched away. Abort on CHAT_CHANGED so it bails before the
            // hide+prepend (summarizeRange re-checks signal.aborted around the AI call).
            const summarizeAbort = new AbortController();
            // Gotcha #38: route through abortWith so signal.reason carries attribution
            // (a bare .abort() loses the post-mortem reason the diagnostics depend on).
            const onChatChange = () => abortWith(summarizeAbort, 'summarize:chat_changed');
            try { eventSource.on(event_types.CHAT_CHANGED, onChatChange); } catch { /* noop */ }
            try {
                const result = await summarizeRange(range, summarizeAbort.signal);
                toastr.clear(loading);
                if (!result.ok) {
                    notify.error(result.error, { copyable: true });
                    return '';
                }
                toastr.success(`Summarized ${result.hiddenCount} messages. ID: ${result.summaryId} (use /dle-summarize-rollback ${result.summaryId} to undo).`, 'DeepLore', { timeOut: 8000 });
                return result.summaryId;
            } catch (err) {
                toastr.clear(loading);
                notify.error(trf('dle_cmd_summarizerange_error_msg', err.message), { copyable: true });
                return '';
            } finally {
                try { eventSource.removeListener(event_types.CHAT_CHANGED, onChatChange); } catch { /* noop */ }
            }
        },
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'range: start-end, N- (from N), -N (last N), or single N',
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: true,
        })],
        helpString: 'AI-summarize a chat range, hide originals, prepend the summary. Usage: /dle-summarize-range <range>. Examples: 5-15 (range), 10- (from 10 to end), -8 (last 8 messages), 7 (single message).',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-summarize-rollback',
        callback: async (_args, idArg) => {
            const id = (idArg || '').trim();
            const result = await rollbackSummary(id || 'all');
            if (!result.ok) {
                toastr.warning(result.error || 'Rollback failed', 'DeepLore');
                return '';
            }
            toastr.success(`Restored ${result.restored} messages, removed ${result.removed} summary message${result.removed === 1 ? '' : 's'}.`, 'DeepLore');
            return '';
        },
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'summary id to roll back (omit or "all" = roll back every summary in this chat)',
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: false,
            enumProvider: () => {
                const list = listSummaries();
                return [
                    new SlashCommandEnumValue('all', 'roll back every summary'),
                    ...list.map(s => new SlashCommandEnumValue(s.id, `#${s.summaryIndex} · ${s.hiddenCount} hidden · ${new Date(s.createdAt).toLocaleTimeString()}`)),
                ];
            },
        })],
        helpString: 'Roll back a /dle-summarize-range operation. Usage: /dle-summarize-rollback [id|all].',
        returns: ARGUMENT_TYPE.STRING,
    }));
}

/**
 * Each summary is presented for review before writing. Aborted via button in review popup.
 * @returns {{ generated: number, skipped: number, failed: number, aborted: number }}
 */
export async function summarizeEntries(entries) {
    const { callAI, isExcludedFromBreaker } = await import('../ai/ai.js');
    const { writeNote, obsidianFetch, encodeVaultPath } = await import('../vault/obsidian-api.js');
    const settings = getSettings();
    const vault = getPrimaryVault(settings);
    // Wave-B contract: the batch summary path was bypassing BOTH resolveConnectionConfig
    // AND the breaker. Without breaker integration a bad API key here used to bake every
    // per-entry call without ever shedding load; without resolveConnectionConfig the loop
    // ignored settings.optimizeKeys / inheritance and reached straight into aiSearch.* .
    // Mirror callScribe / callAutoSuggest: resolve a tool config, gate every call with
    // tryAcquireHalfOpenProbe, route the trip decision through isExcludedFromBreaker.
    const resolved = resolveConnectionConfig('optimizeKeys');

    let generated = 0;
    let skipped = 0;
    let failed = 0;
    let aborted = false;

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        toastr.info(`Generating summary ${i + 1}/${entries.length}: "${entry.title}"...`, 'DeepLore', { timeOut: 0, extendedTimeOut: 0 });

        try {
            const systemPrompt = 'You are a lore librarian. Write a concise AI search summary (max 600 chars) for the following lorebook entry. The summary should answer: What is this? When should it be selected? Key relationships? Do NOT include physical descriptions or atmospheric prose. Write for an AI that needs to decide whether to inject this entry.';
            const userMsg = `Entry: ${entry.title}\n\nContent:\n${entry.content.substring(0, 3000)}`;

            // Breaker probe per call. If open (or probe taken), skip this entry but keep
            // looping — `failed++` (not aborted), so the toast at the end still reports
            // a useful count.
            if (!tryAcquireHalfOpenProbe()) {
                console.warn('[DLE] summarizeEntries: circuit breaker open — skipping entry', entry.title);
                failed++;
                continue;
            }
            let result;
            try {
                result = await callAI(systemPrompt, userMsg, {
                    ...resolved,
                    caller: 'summaryGen',
                    maxTokens: 300,
                    // #45: serial, user-driven batch. A throttled call fails instantly,
                    // so without this every remaining entry lands in the same 500ms window.
                    skipThrottle: true,
                });
                recordAiSuccess();
            } catch (callErr) {
                if (!isExcludedFromBreaker(callErr)) recordAiFailure(); else releaseHalfOpenProbe();
                throw callErr;
            }
            // Audit DIAG-09: result.text may be undefined when the AI call fails or returns
            // an unexpected shape. Bare .trim() would throw and crash the per-entry loop.
            const responseText = (result && typeof result.text === 'string') ? result.text : '';

            const summary = responseText.trim().substring(0, 600);
            if (!summary) {
                failed++;
                continue;
            }

            const remaining = entries.length - i - 1;
            const reviewHtml = `
                <div class="dle-popup">
                    <h4>${escapeHtml(entry.title)}</h4>
                    <p class="dle-text-xs dle-muted dle-mb-2">Progress: ${i + 1} of ${entries.length} | ${generated} written, ${skipped} skipped, ${failed} failed${remaining > 0 ? ` | ${remaining} remaining` : ''}</p>
                    <p class="dle-text-sm dle-muted">Entry content preview: ${escapeHtml(entry.content.substring(0, 200))}...</p>
                    <hr>
                    <p><b>Generated Summary:</b></p>
                    <textarea id="dle-summary-edit" class="text_pole dle-summary-textarea">${escapeHtml(summary)}</textarea>
                    <p class="dle-text-xs dle-faint">OK = write to Obsidian, Cancel = skip this entry.</p>
                    ${remaining > 0 ? '<button type="button" id="dle-summary-abort" class="menu_button" style="margin-top:8px;"><i class="fa-solid fa-stop"></i> Abort remaining</button>' : ''}
                </div>`;

            let capturedTextarea = null;
            let userAborted = false;
            const approved = await callGenericPopup(reviewHtml, POPUP_TYPE.CONFIRM, '', {
                wide: true,
                onOpen: () => {
                    capturedTextarea = document.getElementById('dle-summary-edit');
                    const abortBtn = document.getElementById('dle-summary-abort');
                    if (abortBtn) {
                        abortBtn.addEventListener('click', () => {
                            userAborted = true;
                            document.querySelector('.popup-button-cancel')?.click();
                        });
                    }
                },
            });

            if (userAborted) {
                aborted = true;
                break;
            }

            if (!approved) {
                skipped++;
                continue;
            }

            const finalSummary = capturedTextarea?.value?.trim() || summary;

            const fileResult = await obsidianFetch({
                host: vault.host,
                port: vault.port,
                apiKey: vault.apiKey,
                https: !!vault.https,
                path: `/vault/${encodeVaultPath(entry.filename)}`,
                accept: 'text/markdown',
            });

            if (fileResult.status !== 200) {
                failed++;
                console.warn(`[DLE] Failed to read ${entry.filename}: HTTP ${fileResult.status}`);
                continue;
            }

            let fileContent = fileResult.data;
            if (fileContent.startsWith('---')) {
                const endIdx = fileContent.indexOf('---', 3);
                if (endIdx > 0) {
                    const fmSection = fileContent.substring(0, endIdx);
                    const rest = fileContent.substring(endIdx);
                    const cleaned = fmSection.replace(/^summary:.*$/m, '').replace(/\n{3,}/g, '\n\n');
                    fileContent = cleaned + `summary: ${yamlEscape(finalSummary)}\n` + rest;
                }
            }

            const writeResult = await writeNote(vault.host, vault.port, vault.apiKey, entry.filename, fileContent, !!vault.https);
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

    const abortedCount = aborted ? entries.length - generated - skipped - failed : 0;
    return { generated, skipped, failed, aborted: abortedCount };
}
