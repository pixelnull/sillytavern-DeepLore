/**
 * DeepLore Enhanced — Entry Point
 * Wires up the generation interceptor, event listeners, and UI initialization.
 */
import {
    setExtensionPrompt,
    extension_prompts,
    saveSettingsDebounced,
    saveChatDebounced,
    chat,
    chat_metadata,
    messageFormatting,
} from '../../../../script.js';
import { renderExtensionTemplateAsync } from '../../../extensions.js';
import { eventSource, event_types } from '../../../events.js';
import { promptManager } from '../../../openai.js';
import { formatAndGroup } from './core/matching.js';
import { simpleHash } from './core/utils.js';
import {
    buildExemptionPolicy, applyPinBlock, applyContextualGating,
    applyReinjectionCooldown, applyRequiresExcludesGating,
    applyStripDedup, trackGeneration, decrementTrackers, recordAnalytics,
} from './src/stages.js';
import { clearPrompts } from './core/pipeline.js';
import { getSettings, getConnectionConfig, PROMPT_TAG_PREFIX, PROMPT_TAG, invalidateSettingsCache } from './settings.js';
import {
    vaultIndex, indexEverLoaded, indexing,
    lastInjectionSources, lastInjectionEpoch, lastScribeChatLength, scribeInProgress,
    cooldownTracker, generationCount, injectionHistory, consecutiveInjections,
    chatInjectionCounts, setChatInjectionCounts, trackerKey,
    lastWarningRatio, decayTracker, chatEpoch,
    lastGenerationChatHash, lastGenerationInjectedKeys,
    setLastGenerationChatHash, setLastGenerationInjectedKeys,
    generationLock, generationLockTimestamp, generationLockEpoch, setGenerationLock,
    setLastInjectionSources, setLastInjectionEpoch, setLastScribeChatLength, setLastScribeSummary,
    setGenerationCount, setLastWarningRatio, setChatEpoch, setLastIndexGenerationCount,
    setAiSearchCache, setAutoSuggestMessageCount, setLastPipelineTrace,
    setScribeInProgress, setPreviousSources,
    notifyPipelineComplete, notifyGatingChanged,
    fieldDefinitions,
} from './src/state.js';
import { DEFAULT_FIELD_DEFINITIONS } from './src/fields.js';
import { buildIndex, ensureIndexFresh, hydrateFromCache, buildIndexWithReuse } from './src/vault/vault.js';
import { resetAiThrottle, callAI } from './src/ai/ai.js';
import { runPipeline } from './src/pipeline/pipeline.js';
import { setupSyncPolling } from './src/vault/sync.js';
import { runScribe } from './src/ai/scribe.js';
import { injectSourcesButton, showSourcesPopup, resetCartographer } from './src/ui/cartographer.js';
import { loadSettingsUI, bindSettingsEvents } from './src/ui/settings-ui.js';
import { registerSlashCommands } from './src/ui/commands.js';
import { dedupError, dedupWarning } from './src/toast-dedup.js';
import { createDrawerPanel, resetDrawerState } from './src/drawer/drawer.js';
import { extractAiNotes } from './src/helpers.js';

/** Default instruction prompt for the AI Notebook feature. */
const DEFAULT_AI_NOTEPAD_PROMPT = `[AI Notebook Instructions]
You have a private notebook. After your roleplay response, you may append a <dle-notes> block. This block is AUTOMATICALLY HIDDEN from the reader — they will never see it. Your notes are saved and returned to you in future messages as "[Your previous session notes]" above.

FORMAT — place this AFTER your entire response, on a new line:
<dle-notes>
- your notes here
</dle-notes>

RULES:
- The <dle-notes> block must be the LAST thing you write, after all roleplay prose
- Do NOT write notes as visible prose (no "Note to self:", "OOC:", or similar in your response)
- Do NOT mention the notebook, notes, or <dle-notes> tags in your roleplay prose

Use this space for anything you want to remember but can't put into the story right now — character motivations, unspoken thoughts, plot threads to revisit, world state, emotional arcs, planned callbacks, or anything else you find relevant.`;

/** Default extraction prompt for AI Notebook extract mode. */
const DEFAULT_AI_NOTEPAD_EXTRACT_PROMPT = `You are a session note-taker for a roleplay. Given the AI's latest response and (optionally) its previous session notes, extract anything worth remembering for future context.

Extract: character decisions, relationship shifts, emotional states, revealed information, plot developments, world state changes, unresolved threads, promises made, lies told, or anything else a writer would want to track.

If the response contains visible "notes to self", "OOC" commentary, or meta-commentary by the AI, extract the useful content from those too.

If there is nothing noteworthy, respond with exactly: NOTHING_TO_NOTE

Otherwise, respond with concise bullet points only — no preamble, no headers, no explanation. Just the notes.`;

/** Regex patterns for visible AI note-taking that should be stripped from the message. */
const VISIBLE_NOTES_PATTERNS = [
    /\[Note to self:[\s\S]*?\]/gi,
    /\[OOC:[\s\S]*?\]/gi,
    /\(OOC:[\s\S]*?\)/gi,
    /\[Author['']?s? note:[\s\S]*?\]/gi,
    /\[Session note:[\s\S]*?\]/gi,
    /\[Meta:[\s\S]*?\]/gi,
];

// ============================================================================
// Generation Interceptor
// ============================================================================

/**
 * Called by SillyTavern's generation interceptor system.
 * @param {object[]} chat - Array of chat messages
 * @param {number} contextSize - Context size
 * @param {function} abort - Abort callback
 * @param {string} type - Generation type
 */
async function onGenerate(chat, contextSize, abort, type) {
    const settings = getSettings();

    if (type === 'quiet' || !settings.enabled) {
        return;
    }

    // Prevent concurrent onGenerate runs — warn the user instead of silently dropping lore
    if (generationLock) {
        // Auto-recover stale locks after 90 seconds (allows time for large vaults + slow AI)
        const lockAge = Date.now() - generationLockTimestamp;
        if (lockAge > 90_000) {
            console.warn(`[DLE] Previous lore selection took too long (${Math.round(lockAge / 1000)}s) — releasing lock`);
            setGenerationLock(false);
        } else {
            console.warn('[DLE] Generation lock active — another pipeline is still running. Lore skipped for this generation.');
            toastr.warning('Still selecting lore from the previous message. This response will reuse the last set of entries.', 'DeepLore Enhanced', { timeOut: 5000, preventDuplicates: true });
            return;
        }
    }
    setGenerationLock(true);

    // Capture chat epoch to detect stale writes if CHAT_CHANGED fires mid-generation
    const epoch = chatEpoch;
    // Capture lock epoch to detect if this pipeline has been superseded by a force-released lock
    const lockEpoch = generationLockEpoch;

    // Track whether the pipeline ran far enough to need generation tracking
    let pipelineRan = false;
    let injectedEntries = [];

    try {
        // Tag sources with this generation's epoch so CHARACTER_MESSAGE_RENDERED
        // only consumes sources from the correct generation (race condition fix).
        // We do NOT clear lastInjectionSources here — the render handler clears
        // them after reading, and the epoch tag prevents stale consumption.
        //
        // NOTE: clearPrompts is intentionally deferred to the commit phase below.
        // Clearing here caused silent lore loss when early returns fired (vault timeout,
        // empty vault, no matches) — the old prompts were destroyed with nothing replacing them.
        // On first generation after hydration, clear stale dedup logs
        // (cached _contentHash values may not match current Obsidian content)
        if (!indexEverLoaded && vaultIndex.length > 0 && chat_metadata?.deeplore_injection_log?.length > 0) {
            chat_metadata.deeplore_injection_log = [];
        }

        // Ensure index is fresh (with timeout to prevent indefinite hangs)
        const INDEX_TIMEOUT_MS = 60_000;
        try {
            let indexTimer;
            await Promise.race([
                ensureIndexFresh().finally(() => clearTimeout(indexTimer)),
                new Promise((_, reject) => { indexTimer = setTimeout(() => reject(new Error('Index refresh timed out')), INDEX_TIMEOUT_MS); }),
            ]);
        } catch (timeoutErr) {
            console.warn(`[DLE] ${timeoutErr.message} — proceeding with stale data`);
            if (vaultIndex.length === 0) {
                dedupWarning('Obsidian connection timed out and no cached data available. Check that Obsidian is running with the REST API plugin.', 'obsidian_connect');
                return;
            }
        }

        // Snapshot vaultIndex at pipeline start to avoid races with background rebuilds
        const vaultSnapshot = [...vaultIndex];

        if (vaultSnapshot.length === 0) {
            if (!indexEverLoaded) {
                dedupWarning(
                    'No lorebook entries found. Run /dle-health to check your Obsidian connection and vault settings.',
                    'obsidian_connect', { timeOut: 10000 },
                );
            }
            if (settings.debugMode) {
                console.debug('[DLE] No entries indexed, skipping');
            }
            return;
        }

        // From here on, generation tracking must run even if no entries match
        pipelineRan = true;

        // Contextual gating context: passed to both pipeline (pre-filter) and post-pipeline stages
        const ctx = chat_metadata.deeplore_context || {};

        const pins = chat_metadata.deeplore_pins || [];
        const blocks = chat_metadata.deeplore_blocks || [];

        const { finalEntries: pipelineEntries, matchedKeys, trace } = await runPipeline(chat, vaultSnapshot, ctx, { pins, blocks });
        const policy = buildExemptionPolicy(vaultSnapshot, pins, blocks);

        // Stage 1: Pin/Block overrides
        let finalEntries = applyPinBlock(pipelineEntries, vaultSnapshot, policy, matchedKeys);

        // Stage 2: Contextual gating (driven by field definitions)
        const preContextual = new Set(finalEntries.map(e => e.title));
        const fieldDefs = fieldDefinitions.length > 0 ? fieldDefinitions : DEFAULT_FIELD_DEFINITIONS;
        finalEntries = applyContextualGating(finalEntries, ctx, policy, settings.debugMode, settings, fieldDefs);
        if (trace) {
            const postContextual = new Set(finalEntries.map(e => e.title));
            trace.contextualGatingRemoved = [...preContextual].filter(t => !postContextual.has(t));
        }

        if (trace?.aiFallback) {
            const aiErr = trace.aiError || '';
            let fallbackMsg = 'AI search failed';
            if (/timeout|timed out|abort/i.test(aiErr)) fallbackMsg += ' (timed out — try increasing the timeout in Settings > AI Search)';
            else if (/401|403|auth/i.test(aiErr)) fallbackMsg += ' (auth error — check your API key or connection profile)';
            else if (/not found|no.*profile/i.test(aiErr)) fallbackMsg += ' (connection profile not found — check Settings > AI Search)';
            else if (/ECONNREFUSED|Failed to fetch|NetworkError|fetch|network/i.test(aiErr)) fallbackMsg += ' (network error — check your AI connection settings)';
            else if (/5\d\d|502|503|server/i.test(aiErr)) fallbackMsg += ' (server error — try again later)';
            else if (aiErr) fallbackMsg += ` (${aiErr.slice(0, 80)})`;
            console.warn('[DLE] AI search error:', aiErr);
            dedupWarning(`${fallbackMsg} — falling back to keywords`, 'ai_search', { timeOut: 6000 });
        }

        if (settings.debugMode && trace) {
            console.log(`[DLE] Pipeline (${trace.mode}): ${trace.keywordMatched.length} keyword matches, ${trace.aiSelected.length} AI selected` + (trace.aiFallback ? ' (AI FALLBACK)' : ''));
        }

        if (finalEntries.length === 0) {
            if (settings.debugMode) {
                console.debug('[DLE] No entries matched');
            }
            // BUG-AUDIT-4: Clear stale prompts when pipeline ran but nothing matched.
            // This prevents stale lore from the previous generation persisting when
            // the context has changed such that nothing matches anymore.
            clearPrompts(extension_prompts, PROMPT_TAG_PREFIX, PROMPT_TAG);
            return;
        }

        // Stage 3: Re-injection cooldown
        const preCooldown = new Set(finalEntries.map(e => e.title));
        finalEntries = applyReinjectionCooldown(finalEntries, policy, injectionHistory, generationCount, settings.reinjectionCooldown, settings.debugMode);
        if (trace) {
            const postCooldown = new Set(finalEntries.map(e => e.title));
            trace.cooldownRemoved = [...preCooldown].filter(t => !postCooldown.has(t));
        }

        if (finalEntries.length === 0) {
            if (settings.debugMode) console.debug('[DLE] All entries removed by re-injection cooldown');
            clearPrompts(extension_prompts, PROMPT_TAG_PREFIX, PROMPT_TAG);
            return;
        }

        // Stage 4: Requires/excludes gating (forceInject entries exempt)
        const { result: gated, removed: gatingRemoved } = applyRequiresExcludesGating(finalEntries, policy, settings.debugMode);

        if (gated.length === 0) {
            if (settings.debugMode) console.debug('[DLE] All entries removed by gating rules');
            clearPrompts(extension_prompts, PROMPT_TAG_PREFIX, PROMPT_TAG);
            return;
        }

        // Stage 5: Strip duplicate injections
        let postDedup = gated;
        if (settings.stripDuplicateInjections) {
            postDedup = applyStripDedup(gated, policy, chat_metadata.deeplore_injection_log, settings.stripLookbackDepth, settings, settings.debugMode);
            if (trace) {
                const postDedupTitles = new Set(postDedup.map(e => e.title));
                trace.stripDedupRemoved = gated.filter(e => !postDedupTitles.has(e.title)).map(e => e.title);
            }
        }

        // Stage 6: Format with budget, grouped by injection position
        // BUG-014: Use the captured settings object (line 63) for consistent settings throughout pipeline
        const { groups, count: injectedCount, totalTokens, acceptedEntries } = formatAndGroup(postDedup, settings, PROMPT_TAG_PREFIX);

        injectedEntries = acceptedEntries;

        // Enrich pipeline trace with post-pipeline info
        if (trace) {
            trace.gatedOut = gatingRemoved.map(e => ({
                title: e.title, requires: e.requires, excludes: e.excludes,
            }));
            const acceptedTitles = new Set(acceptedEntries.map(e => e.title));
            trace.budgetCut = postDedup.filter(e => !acceptedTitles.has(e.title))
                .map(e => ({ title: e.title, tokens: e.tokenEstimate, priority: e.priority }));
            trace.injected = acceptedEntries.map(e => ({
                title: e.title,
                tokens: e.tokenEstimate,
                truncated: !!e._truncated,
                originalTokens: e._originalTokens || e.tokenEstimate,
            }));
            trace.totalTokens = totalTokens;
            trace.budgetLimit = settings.maxTokensBudget;
            setLastPipelineTrace(trace);
        }

        // BUG-AUDIT-5: Epoch guard on clearPrompts — prevent stale force-released pipelines
        // from wiping prompts that the new pipeline just set.
        if (epoch !== chatEpoch || lockEpoch !== generationLockEpoch) {
            console.warn('[DLE] Stale pipeline reached commit phase — discarding');
            return;
        }
        // Commit phase: clear previous prompts only now that we have results to replace them.
        // This prevents silent lore loss when the pipeline fails or returns early — old prompts
        // remain in context rather than being wiped to nothing.
        clearPrompts(extension_prompts, PROMPT_TAG_PREFIX, PROMPT_TAG);
        if (settings.injectionMode === 'prompt_list' && promptManager) {
            for (const id of [`${PROMPT_TAG_PREFIX}constants`, `${PROMPT_TAG_PREFIX}lore`, 'deeplore_notebook', 'deeplore_ai_notepad']) {
                const pmEntry = promptManager.getPromptById(id);
                if (pmEntry) pmEntry.content = '';
            }
        }

        if (groups.length > 0) {
            // Bail if chat changed during pipeline — lore belongs to the old chat
            if (epoch !== chatEpoch) {
                console.warn('[DLE] Chat changed during pipeline — discarding results');
                return;
            }
            // Bail if this pipeline was superseded by a force-released stale lock
            if (lockEpoch !== generationLockEpoch) {
                console.warn('[DLE] Pipeline superseded by a newer request — discarding stale results');
                return;
            }
            const usePromptList = settings.injectionMode === 'prompt_list';
            for (const group of groups) {
                if (usePromptList && promptManager) {
                    // Prompt List mode: write content directly to the PM entry.
                    // The PM collection order (user's drag position) controls placement.
                    const pmEntry = promptManager.getPromptById(group.tag);
                    if (pmEntry) {
                        pmEntry.content = group.text;
                        // Don't call setExtensionPrompt — it would override PM positioning
                        continue;
                    }
                    // Fallback: PM entry not found, use setExtensionPrompt
                }
                setExtensionPrompt(
                    group.tag,
                    group.text,
                    group.position,
                    group.depth,
                    settings.allowWIScan,
                    group.role,
                );
            }

            // Capture injection sources for Context Cartographer (epoch-tagged for race safety)
            setLastInjectionSources(injectedEntries.map(e => ({
                title: e.title,
                filename: e.filename,
                matchedBy: matchedKeys.get(e.title) || '?',
                priority: e.priority,
                tokens: e.tokenEstimate,
                vaultSource: e.vaultSource || '',
            })));
            setLastInjectionEpoch(epoch);
        }

        // Author's Notebook injection (independent of entry pipeline)
        if (settings.notebookEnabled && chat_metadata?.deeplore_notebook?.trim()) {
            const rawNotebook = chat_metadata.deeplore_notebook.trim();
            const notebookContent = rawNotebook;
            const usePromptList = settings.injectionMode === 'prompt_list';
            if (usePromptList && promptManager) {
                const pmEntry = promptManager.getPromptById('deeplore_notebook');
                if (pmEntry) {
                    pmEntry.content = notebookContent;
                } else {
                    // Fallback: PM entry not found
                    setExtensionPrompt('deeplore_notebook', notebookContent, settings.notebookPosition, settings.notebookDepth, false, settings.notebookRole);
                }
            } else {
                setExtensionPrompt('deeplore_notebook', notebookContent, settings.notebookPosition, settings.notebookDepth, false, settings.notebookRole);
            }
        }

        // AI Notebook injection
        // Tag mode: inject previous notes + instruction prompt (AI writes <dle-notes> tags)
        // Extract mode: inject previous notes only (no instruction — extraction happens post-gen)
        if (settings.aiNotepadEnabled) {
            const notepadMode = settings.aiNotepadMode || 'tag';
            const parts = [];
            const storedNotes = chat_metadata?.deeplore_ai_notepad?.trim();
            if (storedNotes) {
                parts.push(`[Your previous session notes]\n${storedNotes}\n[End of session notes]`);
            }
            if (notepadMode === 'tag') {
                // Tag mode: include instruction prompt so AI knows to use <dle-notes>
                const instructionPrompt = settings.aiNotepadPrompt?.trim() || DEFAULT_AI_NOTEPAD_PROMPT;
                parts.push(instructionPrompt);
            }
            // Only inject if we have content (extract mode with no existing notes = nothing to inject)
            if (parts.length > 0) {
                const notepadContent = parts.join('\n\n');
                const usePromptList = settings.injectionMode === 'prompt_list';
                if (usePromptList && promptManager) {
                    const pmEntry = promptManager.getPromptById('deeplore_ai_notepad');
                    if (pmEntry) {
                        pmEntry.content = notepadContent;
                    } else {
                        setExtensionPrompt('deeplore_ai_notepad', notepadContent, settings.aiNotepadPosition, settings.aiNotepadDepth, false, settings.aiNotepadRole);
                    }
                } else {
                    setExtensionPrompt('deeplore_ai_notepad', notepadContent, settings.aiNotepadPosition, settings.aiNotepadDepth, false, settings.aiNotepadRole);
                }
            }
        }

        // Stage 7: Track cooldowns and injection history (epoch-guarded, lock-guarded)
        // lockEpoch guard prevents a force-released stale pipeline from corrupting these Maps
        // concurrently with the active pipeline that superseded it.
        if (epoch === chatEpoch && lockEpoch === generationLockEpoch) {
            trackGeneration(injectedEntries, generationCount, cooldownTracker, decayTracker, injectionHistory, settings);
        }

        // Clear stale injection log when dedup is toggled off (epoch-guarded)
        if (!settings.stripDuplicateInjections && epoch === chatEpoch && chat_metadata.deeplore_injection_log?.length > 0) {
            chat_metadata.deeplore_injection_log = [];
            saveChatDebounced();
        }

        // Record injection for deduplication (epoch-guarded to avoid writing to wrong chat)
        if (settings.stripDuplicateInjections && epoch === chatEpoch) {
            if (!chat_metadata.deeplore_injection_log) {
                chat_metadata.deeplore_injection_log = [];
            }
            chat_metadata.deeplore_injection_log.push({
                gen: generationCount + 1,
                entries: injectedEntries.map(e => ({
                    title: e.title,
                    pos: e.injectionPosition ?? settings.injectionPosition,
                    depth: e.injectionDepth ?? settings.injectionDepth,
                    role: e.injectionRole ?? settings.injectionRole,
                    contentHash: e._contentHash || '',
                })),
            });
            const maxHistory = settings.stripLookbackDepth + 1;
            if (chat_metadata.deeplore_injection_log.length > maxHistory) {
                chat_metadata.deeplore_injection_log = chat_metadata.deeplore_injection_log.slice(-maxHistory);
            }
            saveChatDebounced();
        }

        // Stage 8: Analytics (use postDedup — entries that passed all gating — as "matched")
        // BUG-FIX: Epoch-guard analytics like Stages 7 and 9 to prevent cross-chat pollution
        if (postDedup.length > 0 && epoch === chatEpoch && lockEpoch === generationLockEpoch) {
            recordAnalytics(postDedup, injectedEntries, settings.analyticsData);
            // Only persist analytics every 5 generations to reduce write amplification
            if (generationCount % 5 === 0) {
                invalidateSettingsCache();
                saveSettingsDebounced();
            }
        }

        // Stage 9: Per-chat injection counts (epoch-guarded, lock-guarded, swipe-aware)
        //
        // Swipe detection: When the user swipes (regenerates), SillyTavern replaces
        // the last message and fires onGenerate again. Without dedup, the same entries
        // would be double-counted (once for the original, once for the swipe).
        //
        // Solution: Hash the last message content + chat length. If the hash matches
        // the previous generation, the last message was replaced (swipe), so we subtract
        // the previous round's counts before adding the new round's counts. This gives
        // an accurate injection count that survives swipes without inflating.
        if (epoch === chatEpoch && lockEpoch === generationLockEpoch) {
            const lastMsg = chat.length > 0 ? (chat[chat.length - 1]?.mes || '') : '';
            const chatHash = simpleHash(lastMsg + '|' + chat.length);
            if (chatHash === lastGenerationChatHash && lastGenerationInjectedKeys.size > 0) {
                for (const key of lastGenerationInjectedKeys) {
                    const cur = chatInjectionCounts.get(key) || 0;
                    if (cur > 0) chatInjectionCounts.set(key, cur - 1);
                }
            }

            // Track this round
            const thisRoundKeys = new Set();
            for (const entry of injectedEntries) {
                const key = trackerKey(entry);
                chatInjectionCounts.set(key, (chatInjectionCounts.get(key) || 0) + 1);
                thisRoundKeys.add(key);
            }
            setLastGenerationChatHash(chatHash);
            setLastGenerationInjectedKeys(thisRoundKeys);

            // Persist to chat_metadata every generation (counts are lost on chat switch otherwise)
            chat_metadata.deeplore_chat_counts = Object.fromEntries(chatInjectionCounts);
            saveChatDebounced();
        }

        if (groups.length > 0) {
            // Context usage warning — BUG 6 FIX: reset ratio when it drops below threshold
            if (contextSize > 0) {
                const ratio = totalTokens / contextSize;
                if (ratio > 0.20 && ratio > lastWarningRatio + 0.05) {
                    const pct = Math.round(ratio * 100);
                    toastr.warning(
                        `Lore is using ${pct}% of your context window (~${totalTokens} tokens, ${injectedCount} entries). You can set a token budget in Settings to manage this.`,
                        'DeepLore Enhanced',
                        { preventDuplicates: true, timeOut: 8000 },
                    );
                    setLastWarningRatio(ratio);
                } else if (ratio <= 0.15) {
                    // Reset when ratio drops well below threshold to allow re-warning if it climbs again
                    setLastWarningRatio(0);
                }
            }

            if (settings.debugMode) {
                console.log(`[DLE] ${finalEntries.length} selected, ${postDedup.length} after gating+dedup, ${injectedCount} injected (~${totalTokens} tokens) in ${groups.length} group(s)` +
                    (contextSize > 0 ? ` (${Math.round(totalTokens / contextSize * 100)}% of ${contextSize} context)` : ''));
                console.table(injectedEntries.map(e => ({
                    title: e.title,
                    matchedBy: matchedKeys.get(e.title) || '?',
                    priority: e.priority,
                    tokens: e.tokenEstimate,
                    constant: e.constant,
                })));
                if (groups.length > 1) {
                    console.log('[DLE] Injection groups:', groups.map(g =>
                        `${g.tag}: pos=${g.position} depth=${g.depth} role=${g.role}`));
                }
            }
        }

    } catch (err) {
        console.error('[DLE] Error during generation:', err);
        dedupError('Something went wrong loading your lore. Try /dle-health to check for issues, or /dle-refresh to reload.', 'pipeline');
    } finally {
        // Generation tracking must always run when the pipeline was entered,
        // even if no entries matched — otherwise cooldown timers freeze permanently.
        // Wrapped in try/catch to prevent tracking errors from blocking ST generation.
        try {
            if (pipelineRan && epoch === chatEpoch && lockEpoch === generationLockEpoch) {
                setGenerationCount(generationCount + 1);
                decrementTrackers(cooldownTracker, decayTracker, injectedEntries, settings, consecutiveInjections);
            }
        } catch (trackingErr) {
            console.error('[DLE] Error in generation tracking:', trackingErr);
        }
        // Release lock FIRST so pipeline-complete renders see correct state.
        // A force-released stale pipeline must NOT release the newer pipeline's lock.
        if (lockEpoch === generationLockEpoch) {
            setGenerationLock(false);
        }
        // Notify drawer that pipeline is done (regardless of success/failure)
        notifyPipelineComplete();
    }
}

// Register the interceptor on globalThis so SillyTavern can find it
globalThis.deepLoreEnhanced_onGenerate = onGenerate;

// External API: match vault entries against arbitrary text
// (imported from pipeline.js, re-exported on globalThis)
import { matchTextForExternal } from './src/pipeline/pipeline.js';
globalThis.deepLoreEnhanced_matchText = matchTextForExternal;

// ============================================================================
// Initialization
// ============================================================================

jQuery(async function () {
    try {
        const settingsHtml = await renderExtensionTemplateAsync(
            'third-party/sillytavern-DeepLore-Enhanced',
            'settings',
        );
        $('#extensions_settings2').append(settingsHtml);

        // Create the drawer panel in the top bar
        await createDrawerPanel();

        loadSettingsUI();
        bindSettingsEvents(buildIndex);
        registerSlashCommands();
        setupSyncPolling(buildIndex, buildIndexWithReuse);

        // First-run detection: if no vaults configured and wizard not completed, show wizard
        const firstRunSettings = getSettings();
        const hasEnabledVaults = (firstRunSettings.vaults || []).some(v => v.enabled);
        if (!hasEnabledVaults && !firstRunSettings._wizardCompleted) {
            // Delay so ST finishes rendering first
            setTimeout(async () => {
                const { showSetupWizard } = await import('./src/ui/setup-wizard.js');
                showSetupWizard();
            }, 500);
        }

        // Register PM prompts on init so they appear in the Prompt Manager immediately.
        // Content is written directly to PM entries at generation time (not via setExtensionPrompt),
        // so the PM collection order (user's drag position) controls placement.
        const initSettings = getSettings();
        if (initSettings.injectionMode === 'prompt_list') {
            // Register directly in PM (so entries appear in the list without generating first).
            // promptManager may not be initialized yet, so poll briefly.
            const PM_DISPLAY_NAMES = {
                [`${PROMPT_TAG_PREFIX}constants`]: 'DLE Constants',
                [`${PROMPT_TAG_PREFIX}lore`]: 'DLE Lore Entries',
                'deeplore_notebook': 'DLE Author\'s Notebook',
                'deeplore_ai_notepad': 'DLE AI Notebook',
            };
            const registerPmEntries = () => {
                if (!promptManager) return false;
                const ids = [`${PROMPT_TAG_PREFIX}constants`, `${PROMPT_TAG_PREFIX}lore`, 'deeplore_notebook', 'deeplore_ai_notepad'];
                for (const id of ids) {
                    const existing = promptManager.getPromptById(id);
                    if (!existing) {
                        promptManager.addPrompt({
                            name: PM_DISPLAY_NAMES[id] || id,
                            content: '',
                            system_prompt: true,
                            role: 'system',
                            position: 'end',
                            marker: false,
                            enabled: true,
                            extension: true,
                        }, id);
                    } else {
                        // Patch legacy entries missing role, position, or old display name
                        if (!existing.role) existing.role = 'system';
                        if (!existing.position) existing.position = 'end';
                        if (!existing.extension) existing.extension = true;
                        const friendlyName = PM_DISPLAY_NAMES[id];
                        if (friendlyName && existing.name !== friendlyName) existing.name = friendlyName;
                    }
                    // Add to active character's prompt order if not already there
                    if (promptManager.activeCharacter) {
                        const order = promptManager.getPromptOrderForCharacter(promptManager.activeCharacter);
                        if (!order.find(e => e.identifier === id)) {
                            order.push({ identifier: id, enabled: true });
                        }
                    }
                }
                promptManager.render(false);
                return true;
            };
            if (!registerPmEntries()) {
                // PM not ready yet — retry after a short delay
                const interval = setInterval(() => {
                    if (registerPmEntries()) clearInterval(interval);
                }, 500);
                // Stop trying after 10s
                setTimeout(() => clearInterval(interval), 10000);
            }
        }
        if (initSettings.enabled) {
            // Try instant hydration from IndexedDB, then validate against Obsidian in background
            eventSource.once(event_types.APP_READY, async () => {
                // Skip if a build was already triggered (e.g. by early user generation)
                if (indexEverLoaded || indexing) return;
                try {
                    const hydrated = await hydrateFromCache();
                    if (!hydrated) {
                        // No cache — do a full build
                        await buildIndex();
                    }
                    // If hydrated, hydrateFromCache already triggers a background buildIndex
                } catch (err) {
                    console.warn('[DLE] Auto-connect:', err.message);
                }
            });
        }

        // Context Cartographer: click + keyboard handler (event delegation — registered once)
        $('#chat').on('click keydown', '.mes_deeplore_sources', function (e) {
            if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
            if (e.type === 'keydown') e.preventDefault();
            const messageId = $(this).closest('.mes').attr('mesid');
            const message = chat[messageId];
            const sources = message?.extra?.deeplore_sources;
            if (!sources || sources.length === 0) return;
            showSourcesPopup(sources, { aiNotes: message?.extra?.deeplore_ai_notes });
        });

        // AI Notebook: GENERATION_ENDED handler for both tag and extract modes.
        // Tag mode: extract <dle-notes> from AI response before rendering.
        // Extract mode: strip visible notes, then fire async API call to extract session notes.
        eventSource.on(event_types.GENERATION_ENDED, () => {
            const settings = getSettings();
            if (!settings.aiNotepadEnabled) return;
            const mode = settings.aiNotepadMode || 'tag';
            const lastMessage = chat[chat.length - 1];
            if (!lastMessage || lastMessage.is_user || !lastMessage.mes) return;

            if (mode === 'tag') {
                // Tag mode: extract <dle-notes> blocks
                const { notes, cleanedMessage } = extractAiNotes(lastMessage.mes);
                if (notes) {
                    lastMessage.mes = cleanedMessage;
                    lastMessage.extra = lastMessage.extra || {};
                    lastMessage.extra.deeplore_ai_notes = notes;
                    const existing = chat_metadata.deeplore_ai_notepad || '';
                    chat_metadata.deeplore_ai_notepad = (existing + '\n' + notes).trim();
                    saveChatDebounced();
                }
            } else if (mode === 'extract') {
                // Extract mode: strip visible note-taking prose, then async API extraction
                let cleaned = lastMessage.mes;
                for (const pattern of VISIBLE_NOTES_PATTERNS) {
                    cleaned = cleaned.replace(pattern, '');
                }
                cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trimEnd();
                if (cleaned !== lastMessage.mes) {
                    lastMessage.mes = cleaned;
                    saveChatDebounced();
                }

                // BUG-AUDIT-7: Fire-and-forget async extraction with epoch guard
                // to prevent writing notes to the wrong chat after a chat switch.
                const extractEpoch = chatEpoch;
                (async () => {
                    try {
                        const extractPrompt = settings.aiNotepadExtractPrompt?.trim() || DEFAULT_AI_NOTEPAD_EXTRACT_PROMPT;
                        const existingNotes = chat_metadata?.deeplore_ai_notepad?.trim();
                        let userMsg = `[Latest AI response]\n${lastMessage.mes}`;
                        if (existingNotes) {
                            userMsg = `[Previous session notes]\n${existingNotes}\n\n${userMsg}`;
                        }

                        const connectionConfig = getConnectionConfig('aiNotepad', { skipThrottle: true });

                        const result = await callAI(extractPrompt, userMsg, connectionConfig);
                        const responseText = (result?.text || result || '').trim();

                        // BUG-AUDIT-7: Bail if chat changed during async extraction
                        if (extractEpoch !== chatEpoch) return;
                        if (responseText && responseText !== 'NOTHING_TO_NOTE') {
                            lastMessage.extra = lastMessage.extra || {};
                            lastMessage.extra.deeplore_ai_notes = responseText;
                            const existing = chat_metadata.deeplore_ai_notepad || '';
                            chat_metadata.deeplore_ai_notepad = (existing + '\n' + responseText).trim();
                            saveChatDebounced();
                        }
                    } catch (err) {
                        console.warn('[DLE] AI Notebook extract error:', err.message);
                    }
                })();
            }
        });

        // Context Cartographer + Session Scribe: post-render handler
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => {
            const settings = getSettings();

            // --- Context Cartographer: store sources and inject button ---
            // Only consume sources that belong to the current chat epoch (race condition guard:
            // prevents stale sources from a previous chat from being stored on the wrong message).
            if (settings.showLoreSources && lastInjectionSources && lastInjectionSources.length > 0) {
                if (lastInjectionEpoch === chatEpoch) {
                    const message = chat[messageId];
                    if (message && !message.is_user) {
                        message.extra = message.extra || {};
                        message.extra.deeplore_sources = lastInjectionSources;
                        setLastInjectionSources(null);
                        saveChatDebounced();
                    }
                }
            }

            if (settings.showLoreSources) {
                injectSourcesButton(messageId);
            }

            // --- AI Notebook: fallback extraction (if GENERATION_ENDED missed it, e.g. swipe) ---
            if (settings.aiNotepadEnabled) {
                const message = chat[messageId];
                if (message && !message.is_user && message.mes) {
                    const { notes, cleanedMessage } = extractAiNotes(message.mes);
                    if (notes) {
                        message.mes = cleanedMessage;
                        message.extra = message.extra || {};
                        if (!message.extra.deeplore_ai_notes) {
                            message.extra.deeplore_ai_notes = notes;
                            const existing = chat_metadata.deeplore_ai_notepad || '';
                            chat_metadata.deeplore_ai_notepad = (existing + '\n' + notes).trim();
                        }
                        saveChatDebounced();
                        const mesBlock = document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`);
                        if (mesBlock) mesBlock.innerHTML = messageFormatting(cleanedMessage, message.name, message.is_system, message.is_user, messageId);
                    }
                }
            }

            // --- Session Scribe: track chat position and auto-trigger ---
            if (settings.enabled && settings.scribeEnabled && settings.scribeInterval > 0) {
                const newMessages = chat.length - lastScribeChatLength;
                if (newMessages >= settings.scribeInterval && !scribeInProgress) {
                    runScribe(); // fire-and-forget
                }
            }
        });

        // Context Cartographer: re-inject buttons on chat load
        eventSource.on(event_types.CHAT_CHANGED, () => {
            // Increment epoch first so any in-flight onGenerate sees the mismatch
            setChatEpoch(chatEpoch + 1);

            setLastScribeChatLength(chat ? chat.length : 0);
            setLastScribeSummary(chat_metadata?.deeplore_lastScribeSummary || '');
            setScribeInProgress(false); // Reset scribe lock so auto-scribe works in new chat
            // Reset per-chat tracking on chat change
            // Note: aiSearchStats is intentionally NOT reset — it tracks session-level cumulative stats
            injectionHistory.clear();
            cooldownTracker.clear();
            decayTracker.clear();
            consecutiveInjections.clear();
            // Hydrate per-chat injection counts from saved metadata (survives page reload)
            const savedCounts = chat_metadata?.deeplore_chat_counts;
            setChatInjectionCounts(savedCounts ? new Map(Object.entries(savedCounts)) : new Map());
            setLastGenerationInjectedKeys(new Set());
            setLastGenerationChatHash('');
            setGenerationCount(0);
            setLastIndexGenerationCount(0);
            setLastInjectionEpoch(-1);
            setLastWarningRatio(0);
            setAiSearchCache({ hash: '', manifestHash: '', chatLineCount: 0, results: [] });
            resetAiThrottle();
            setAutoSuggestMessageCount(0);
            setLastPipelineTrace(null);
            setLastInjectionSources(null);
            setPreviousSources(null);
            resetCartographer();

            // Reset drawer ephemeral state (browse filters, context tokens) and refresh
            resetDrawerState();
            notifyPipelineComplete();
            notifyGatingChanged();

            // Re-register PM entries for the new active character (prompt_list mode)
            if (getSettings().injectionMode === 'prompt_list' && promptManager?.activeCharacter) {
                const ids = [`${PROMPT_TAG_PREFIX}constants`, `${PROMPT_TAG_PREFIX}lore`, 'deeplore_notebook', 'deeplore_ai_notepad'];
                for (const id of ids) {
                    const existing = promptManager.getPromptById(id);
                    if (!existing) {
                        const pmNames = { [`${PROMPT_TAG_PREFIX}constants`]: 'DLE Constants', [`${PROMPT_TAG_PREFIX}lore`]: 'DLE Lore Entries', 'deeplore_notebook': 'DLE Author\'s Notebook', 'deeplore_ai_notepad': 'DLE AI Notebook' };
                        promptManager.addPrompt({
                            name: pmNames[id] || id, content: '', system_prompt: true,
                            role: 'system', position: 'end', marker: false, enabled: true, extension: true,
                        }, id);
                    } else {
                        if (!existing.role) existing.role = 'system';
                        if (!existing.position) existing.position = 'end';
                        if (!existing.extension) existing.extension = true;
                        const friendlyName = pmNames[id];
                        if (friendlyName && existing.name !== friendlyName) existing.name = friendlyName;
                    }
                    const order = promptManager.getPromptOrderForCharacter(promptManager.activeCharacter);
                    if (order && !order.find(e => e.identifier === id)) {
                        order.push({ identifier: id, enabled: true });
                    }
                }
            }

            // Retry with backoff to handle slow DOM rendering on large chats
            const injectAllSourceButtons = (attempt = 0) => {
                const settings = getSettings();
                if (!settings.showLoreSources) return;
                const chatEl = document.getElementById('chat');
                if (!chatEl?.children.length && attempt < 5) {
                    setTimeout(() => injectAllSourceButtons(attempt + 1), 200 * (attempt + 1));
                    return;
                }
                // Batch DOM reads/writes in rAF to avoid layout thrashing
                requestAnimationFrame(() => {
                    // Only inject for the last N visible messages to avoid O(n) on large chats
                    const start = Math.max(0, chat.length - 50);
                    for (let i = start; i < chat.length; i++) {
                        if (chat[i]?.extra?.deeplore_sources) {
                            injectSourcesButton(i);
                        }
                    }
                });
            };
            setTimeout(injectAllSourceButtons, 100);
        });

        if (getSettings().debugMode) console.log('[DLE] DeepLore Enhanced client extension initialized');
    } catch (err) {
        console.error('[DLE] Failed to initialize:', err);
    }
});
