/**
 * DeepLore Enhanced — AI Search module
 * aiSearch, callViaProfile, extractAiResponseClient, buildCandidateManifest,
 * hierarchicalPreFilter, getProfileModelHint
 */
import { ConnectionManagerRequestService } from '../../../../shared.js';
import { truncateToSentence, simpleHash, buildAiChatContext, escapeXml } from '../../core/utils.js';
import { getSettings, DEFAULT_AI_SYSTEM_PROMPT } from '../../settings.js';
import { callProxyViaCorsBridge } from './proxy-api.js';
import {
    vaultIndex, aiSearchCache, aiSearchStats, decayTracker, lastScribeSummary,
    trackerKey, setAiSearchCache, entityNameSet, entityShortNameRegexes, consecutiveInjections,
    notifyAiStatsUpdated,
    isAiCircuitOpen, tryAcquireHalfOpenProbe, recordAiSuccess, recordAiFailure,
    fieldDefinitions,
} from '../state.js';
import { dedupWarning } from '../toast-dedup.js';
// Import for local use
import { extractAiResponseClient, clusterEntries, buildCategoryManifest, normalizeResults, isForceInjected, fuzzyTitleMatch } from '../helpers.js';

// Re-export for consumers that import from ai.js
export { extractAiResponseClient, clusterEntries, buildCategoryManifest, normalizeResults, isForceInjected, fuzzyTitleMatch };

// ── AI call throttle ──
// Minimum 500ms between actual AI API calls to prevent rapid-generation spam.
// Cache hits and circuit breaker skips are not throttled (they don't make API calls).
let _lastAiCallTimestamp = 0;
const AI_CALL_MIN_INTERVAL_MS = 500;

// Default model for proxy mode when no model is specified
const DEFAULT_PROXY_MODEL = 'claude-haiku-4-5-20251001';

/** Reset AI call throttle — call on chat change to avoid cross-chat penalty. */
export function resetAiThrottle() { _lastAiCallTimestamp = 0; }

/**
 * Get the model name from the selected Connection Manager profile.
 * @returns {string} Model name or empty string
 */
export function getProfileModelHint() {
    const settings = getSettings();
    if (!settings.aiSearchProfileId) return '';
    try {
        const profile = ConnectionManagerRequestService.getProfile(settings.aiSearchProfileId);
        return profile.model || '';
    } catch (err) {
        if (settings.debugMode) console.debug('[DLE] Could not read profile model hint:', err.message);
        return '';
    }
}

/**
 * Make an API call via a SillyTavern Connection Manager profile.
 * Used by both AI Search and Session Scribe.
 * @param {string} systemPrompt - System prompt text
 * @param {string} userMessage - User message content
 * @param {number} maxTokens - Max tokens for response
 * @param {number} timeout - Timeout in milliseconds
 * @param {string} [profileId] - Profile ID (defaults to aiSearchProfileId)
 * @param {string} [modelOverride] - Model override (defaults to aiSearchModel)
 * @returns {Promise<{text: string, usage: {input_tokens: number, output_tokens: number}}>}
 */
export async function callViaProfile(systemPrompt, userMessage, maxTokens, timeout, profileId, modelOverride) {
    const settings = getSettings();
    const resolvedProfileId = profileId || settings.aiSearchProfileId;
    const resolvedModel = modelOverride !== undefined ? modelOverride : settings.aiSearchModel;
    if (!profileId && settings.debugMode) {
        console.debug('[DLE] callViaProfile: No profileId passed, falling back to aiSearchProfileId');
    }
    if (!resolvedProfileId) throw new Error('No connection profile selected. Set one in AI Search settings, or create one in SillyTavern\'s Connection Manager.');

    // Validate profile exists before making the API call
    try {
        const profile = ConnectionManagerRequestService.getProfile(resolvedProfileId);
        if (!profile) throw new Error(`Connection profile not found. Select one in AI Search settings, or create one in SillyTavern's Connection Manager.`);
    } catch (e) {
        if (e.message.includes('not found') || e.message.includes('Connection Manager')) throw e;
        throw new Error(`Connection profile not found or invalid. Select one in AI Search settings, or create one in SillyTavern's Connection Manager.`);
    }

    // Some providers (e.g. Anthropic) require system prompt separately, not as a message.
    // ConnectionManagerRequestService handles this via the options parameter.
    // Pass system as first user message with clear framing as fallback for providers that
    // don't extract system messages, while also providing it in options for those that do.
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
    ];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        // BUG-028: Use Promise.race to enforce timeout even if CMRS ignores AbortSignal
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(Object.assign(new Error(`Request timed out (${Math.round(timeout / 1000)}s)`), { name: 'AbortError' })), timeout + 500);
        });
        const result = await Promise.race([
            ConnectionManagerRequestService.sendRequest(
                resolvedProfileId,
                messages,
                maxTokens,
                {
                    stream: false,
                    signal: controller.signal,
                    extractData: true,
                    includePreset: false,
                    includeInstruct: false,
                },
                // Override model if user specified one
                resolvedModel ? { model: resolvedModel } : {},
            ),
            timeoutPromise,
        ]);

        return {
            text: result.content || '',
            usage: {
                input_tokens: result.usage?.input_tokens || result.usage?.prompt_tokens || 0,
                output_tokens: result.usage?.output_tokens || result.usage?.completion_tokens || 0,
            },
        };
    } catch (err) {
        // Enhance error with profile context for diagnosability
        const profileLabel = resolvedProfileId ? ` [profile: ${resolvedProfileId}]` : '';
        const modelLabel = resolvedModel ? ` [model: ${resolvedModel}]` : '';
        if (err.name === 'AbortError') {
            throw new Error(`Request timed out (${Math.round(timeout / 1000)}s)${profileLabel}${modelLabel}`);
        }
        throw new Error(`${err.message}${profileLabel}${modelLabel}`);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Unified AI connection router. Routes calls to either a Connection Manager profile
 * or the CORS proxy bridge, based on connectionConfig.mode.
 * Eliminates duplicated if/else routing across aiSearch, callScribe, callAutoSuggest.
 *
 * @param {string} systemPrompt - System prompt text
 * @param {string} userMessage - User message content
 * @param {object} connectionConfig
 * @param {string} connectionConfig.mode - 'profile' or 'proxy'
 * @param {string} [connectionConfig.profileId] - Profile ID (for profile mode)
 * @param {string} [connectionConfig.proxyUrl] - Proxy URL (for proxy mode)
 * @param {string} [connectionConfig.model] - Model override
 * @param {number} connectionConfig.maxTokens - Max tokens for response
 * @param {number} connectionConfig.timeout - Timeout in ms
 * @param {object} [connectionConfig.cacheHints] - Optional cache hints for proxy mode
 * @returns {Promise<{text: string, usage: {input_tokens: number, output_tokens: number}}>}
 */
export async function callAI(systemPrompt, userMessage, connectionConfig) {
    // BUG-006: Allow callers to skip throttle (e.g. hierarchicalPreFilter which chains with aiSearch)
    if (!connectionConfig.skipThrottle) {
        // Throttle: enforce minimum interval between API calls to prevent rapid-generation spam.
        // Throws a distinct error type so callers can distinguish throttle from real failure
        // (throttle should NOT trip the circuit breaker).
        const now = Date.now();
        if (now - _lastAiCallTimestamp < AI_CALL_MIN_INTERVAL_MS) {
            const err = new Error(`AI call throttled — minimum ${AI_CALL_MIN_INTERVAL_MS}ms between calls`);
            err.throttled = true;
            throw err;
        }
    }

    const { mode, profileId, proxyUrl, model, maxTokens, timeout, cacheHints } = connectionConfig;

    // BUG-039 + BUG-H1: Set throttle timestamp only on SUCCESS.
    // Failed calls must not consume the throttle window (prevents blocking retries).
    let result;
    if (mode === 'profile') {
        result = await callViaProfile(systemPrompt, userMessage, maxTokens, timeout, profileId, model);
    } else {
        // Proxy mode
        if (!model) {
            console.warn('[DLE] No model specified for proxy mode, falling back to:', DEFAULT_PROXY_MODEL);
        }
        result = await callProxyViaCorsBridge(
            proxyUrl,
            model || DEFAULT_PROXY_MODEL,
            systemPrompt,
            userMessage,
            maxTokens,
            timeout,
            cacheHints,
        );
    }
    // Only stamp throttle on success, and only for non-skipped calls
    if (!connectionConfig.skipThrottle) {
        _lastAiCallTimestamp = Date.now();
    }
    return result;
}

/**
 * Build a compact manifest from a specific set of candidate entries (for AI search).
 * @param {VaultEntry[]} candidates - Entries to include (constants are filtered out)
 * @param {boolean} [excludeBootstrap=false] - Also exclude bootstrap entries (when they're being force-injected)
 * @returns {{ manifest: string, header: string }}
 */
export function buildCandidateManifest(candidates, excludeBootstrap = false) {
    const settings = getSettings();
    const summaryLen = settings.aiSearchManifestSummaryLength || 600;

    const summaryMode = settings.manifestSummaryMode || 'prefer_summary';
    let selectable = candidates.filter(e => !isForceInjected(e, { bootstrapActive: excludeBootstrap }));

    // E8: In summary_only mode, exclude entries that have no summary field
    if (summaryMode === 'summary_only') {
        selectable = selectable.filter(e => e.summary && e.summary.trim());
    }

    if (selectable.length === 0) return { manifest: '', header: '' };

    const manifest = selectable
        .map(entry => {
            // E8: Select summary text based on manifestSummaryMode
            const summaryText = summaryMode === 'content_only'
                ? truncateToSentence(entry.content.substring(0, summaryLen * 3).replace(/\n+/g, ' ').trim(), summaryLen)
                : (entry.summary || truncateToSentence(entry.content.substring(0, summaryLen * 3).replace(/\n+/g, ' ').trim(), summaryLen));
            const safeSummary = summaryText;
            const links = entry.resolvedLinks && entry.resolvedLinks.length > 0
                ? ` → ${entry.resolvedLinks.join(', ')}`
                : '';
            // Decay/freshness annotation: hint to AI about stale or frequently-injected entries
            let decayHint = '';
            if (settings.decayEnabled && decayTracker.size > 0) {
                const staleness = decayTracker.get(trackerKey(entry));
                if (staleness !== undefined && staleness >= settings.decayBoostThreshold) {
                    decayHint = ' [STALE — consider refreshing]';
                }
                // Penalty: entries injected many consecutive times get a nudge.
                if (!decayHint && settings.decayPenaltyThreshold > 0) {
                    const streak = consecutiveInjections.get(trackerKey(entry));
                    if (streak !== undefined && streak >= settings.decayPenaltyThreshold) {
                        decayHint = ' [FREQUENT — consider diversifying]';
                    }
                }
            }
            // Custom field annotations (e.g. [Era: medieval | Location: tavern])
            let fieldsHint = '';
            if (entry.customFields) {
                const labelMap = new Map(fieldDefinitions.map(f => [f.name, f.label]));
                const pairs = Object.entries(entry.customFields)
                    .filter(([, v]) => v != null && v !== '' && (!Array.isArray(v) || v.length > 0))
                    .map(([k, v]) => `${labelMap.get(k) || k}: ${Array.isArray(v) ? v.join(', ') : v}`);
                if (pairs.length > 0) fieldsHint = `\n[${pairs.join(' | ')}]`;
            }
            const attrSafeTitle = escapeXml(entry.title);
            const header = `${entry.title} (${entry.tokenEstimate}tok)${links}${decayHint}${fieldsHint}`;

            // Wrap each entry in structural delimiters to prevent summary content
            // from being interpreted as manifest-level instructions
            return `<entry name="${attrSafeTitle}">\n${header}\n${safeSummary}\n</entry>`;
        })
        .join('\n');

    // BUG-047: Use candidates.length (includes force-injected) not selectable.length (tautological)
    const forcedCount = candidates.length - selectable.length;
    let forcedTokens = 0;
    for (const e of candidates) { if (isForceInjected(e)) forcedTokens += e.tokenEstimate; }
    const budgetInfo = settings.unlimitedBudget
        ? ''
        : `\nToken budget: ~${settings.maxTokensBudget} tokens total.`;

    const header = `Candidate entries: ${selectable.length} (from ${candidates.length} total).`
        + (forcedCount > 0 ? `\n${forcedCount} entries are always included (~${forcedTokens} tokens).` : '')
        + budgetInfo;

    return { manifest, header };
}

// clusterEntries, buildCategoryManifest — imported from ./helpers.js

/** Threshold for enabling hierarchical two-call search */
const HIERARCHICAL_THRESHOLD = 40;

/**
 * Pre-filter candidates using hierarchical category selection for large vaults.
 * Call 1: asks AI which categories are relevant to the current chat.
 * Returns filtered candidates containing only entries from selected categories.
 * @param {VaultEntry[]} candidates - All selectable entries
 * @param {object[]} chat - Chat messages array
 * @returns {Promise<VaultEntry[]|null>} Filtered candidates, or null to skip (use all)
 */
export async function hierarchicalPreFilter(candidates, chat) {
    const settings = getSettings();
    const bootstrapActive = chat.length <= settings.newChatThreshold;
    const selectable = candidates.filter(e => !isForceInjected(e, { bootstrapActive }));

    if (selectable.length < HIERARCHICAL_THRESHOLD) return null; // Too few, skip clustering

    const clusters = clusterEntries(selectable);
    if (clusters.size <= 3) return null; // Not enough categories to benefit

    const categoryManifest = buildCategoryManifest(clusters);
    const chatContext = buildAiChatContext(chat, settings.aiSearchScanDepth);

    const categoryPrompt = `You are a lore retrieval assistant. Given categories of lore entries and recent chat context, identify which categories are relevant to the current conversation.

A category is relevant if:
1. Characters, places, or concepts from that category are explicitly mentioned in the chat
2. The category's theme (e.g., combat, politics, magic) matches the current scene
3. The category could provide useful background context for what is happening

Be inclusive — when in doubt, include the category. A second stage will filter individual entries.
If no categories are relevant, return an empty array.

Respond with ONLY a JSON array of category name strings.
Example: ["Characters - Inner Circle", "Locations - Districts", "Lore - Magic Systems"]`;
    const categoryUserMessage = `## Categories\n${categoryManifest}\n\n## Recent Chat\n${chatContext}`;

    // BUG-AUDIT-1: Use tryAcquireHalfOpenProbe for actual AI calls (not pure query)
    if (!tryAcquireHalfOpenProbe()) {
        dedupWarning('AI circuit breaker is open — skipping hierarchical pre-filter.', 'circuit-prefilter');
        return null;
    }

    try {
        const result = await callAI(categoryPrompt, categoryUserMessage, {
            mode: settings.aiSearchConnectionMode,
            profileId: settings.aiSearchProfileId,
            proxyUrl: settings.aiSearchProxyUrl,
            model: settings.aiSearchModel,
            maxTokens: 512,
            timeout: settings.aiSearchTimeout,
            skipThrottle: true, // BUG-006: Don't throttle hierarchical pre-filter (it chains with aiSearch)
        });
        const responseText = result.text;
        const usage = result.usage;

        // BUG-017: Don't increment aiSearchStats.calls here — only count in aiSearch()
        // to avoid double-counting when hierarchical + main search both run
        if (usage) {
            aiSearchStats.totalInputTokens += usage.input_tokens || 0;
            aiSearchStats.totalOutputTokens += usage.output_tokens || 0;
        }
        notifyAiStatsUpdated();

        let parsed = extractAiResponseClient(responseText);
        if (!parsed) return null;

        // BUG-027: Handle object format responses (e.g. {"categories": ["cat1", "cat2"]})
        if (!Array.isArray(parsed) && typeof parsed === 'object') {
            // Try common wrapper keys
            let arrayValue = parsed.categories || parsed.labels || parsed.selected || Object.values(parsed).find(Array.isArray);
            // Flatten nested arrays (e.g. [["cat1", "cat2"]] → ["cat1", "cat2"])
            if (Array.isArray(arrayValue) && arrayValue.length > 0 && Array.isArray(arrayValue[0])) {
                arrayValue = arrayValue.flat();
            }
            if (Array.isArray(arrayValue)) {
                parsed = arrayValue;
            } else {
                if (settings.debugMode) console.warn('[DLE] Hierarchical response: unexpected object format, skipping');
                return null;
            }
        }
        if (!Array.isArray(parsed) || parsed.length === 0) return null;

        // parsed should be an array of category name strings
        const selectedCategories = new Set(
            parsed.map(item => (typeof item === 'string' ? item : item.title || item.name || item.category || item.label || '').toLowerCase()).filter(Boolean),
        );

        if (selectedCategories.size === 0) return null;

        // Filter candidates to only those in selected categories
        // Fuzzy match: check if any selected category is a substring or the entry's category is a substring
        const filtered = selectable.filter(entry => {
            const category = (entry.tags && entry.tags.length > 0) ? entry.tags[0].toLowerCase() : 'uncategorized';
            return [...selectedCategories].some(sc => category.includes(sc) || sc.includes(category));
        });

        // Always include force-injected entries
        const forceInjected = candidates.filter(e => isForceInjected(e));
        const filteredResult = [...forceInjected, ...filtered];

        if (settings.debugMode) {
            console.log(`[DLE] Hierarchical pre-filter: ${clusters.size} categories → ${selectedCategories.size} selected, ${selectable.length} → ${filtered.length} entries`);
        }

        // If filtering removed too many entries (>80% by default), skip — the AI was probably too aggressive
        const minRetention = 1 - (settings.hierarchicalAggressiveness ?? 0.8);
        if (filtered.length < selectable.length * minRetention) {
            if (settings.debugMode) console.log('[DLE] Hierarchical pre-filter too aggressive, using full manifest');
            return null;
        }

        // BUG-H3: Warn when pre-filter drops >50% of candidates (even if within threshold)
        if (filtered.length < selectable.length * 0.5 && settings.debugMode) {
            console.warn(`[DLE] Hierarchical pre-filter dropped ${selectable.length - filtered.length}/${selectable.length} candidates — consider lowering aggressiveness`);
        }

        // BUG-AUDIT-1: Pre-filter succeeded — record success so circuit closes and
        // the subsequent aiSearch() call can pass through normally.
        recordAiSuccess();

        return filteredResult;
    } catch (err) {
        // BUG-FIX: Pre-filter failures should NOT trip the circuit breaker — pre-filter is
        // optional and its failure shouldn't cascade to block the main aiSearch() call.
        // Record success to release the probe cleanly (the main search will handle its own probing).
        if (!err.throttled) recordAiSuccess();
        if (settings.debugMode) console.warn('[DLE] Hierarchical pre-filter failed:', err.message);
        return null; // Fall back to single-call
    }
}

/**
 * @typedef {object} AiSearchMatch
 * @property {VaultEntry} entry
 * @property {string} confidence - "high", "medium", or "low"
 * @property {string} reason - Brief explanation
 */

/**
 * Perform AI-powered semantic search using Claude Haiku via the proxy.
 * @param {object[]} chat - Chat messages array
 * @param {string} candidateManifest - Manifest string of candidate entries
 * @param {string} candidateHeader - Header with metadata about candidates
 * @param {VaultEntry[]} [snapshot] - Vault index snapshot (avoids stale global reads after await)
 * @returns {Promise<{ results: AiSearchMatch[], error: boolean }>}
 */
export async function aiSearch(chat, candidateManifest, candidateHeader, snapshot, candidateEntries) {
    const settings = getSettings();

    if (!settings.aiSearchEnabled || !candidateManifest) {
        return { results: [], error: false };
    }

    // BUG-AUDIT-1: Use tryAcquireHalfOpenProbe for actual AI calls (not pure query)
    if (!tryAcquireHalfOpenProbe()) {
        if (settings.debugMode) console.debug('[DLE] AI circuit breaker open — skipping AI search');
        dedupWarning('AI search temporarily paused after repeated failures. Using keyword matching.', 'ai_circuit', { timeOut: 8000 });
        return { results: [], error: true, errorMessage: 'AI search temporarily paused' };
    }

    let chatContext = buildAiChatContext(chat, settings.aiSearchScanDepth);
    if (!chatContext.trim()) return { results: [], error: false };

    // Prepend seed entry content as story context on new chats
    const isNewChat = chat.length <= settings.newChatThreshold;
    if (isNewChat) {
        const seedEntries = (snapshot || vaultIndex).filter(e => e.seed);
        if (seedEntries.length > 0) {
            const seedContext = seedEntries.map(e => e.content).join('\n\n');
            chatContext = `[STORY CONTEXT — use this to understand the setting and make better selections]\n${seedContext}\n\n[RECENT CHAT]\n${chatContext}`;
            if (settings.debugMode) {
                console.log(`[DLE] New chat: injecting ${seedEntries.length} seed entries as AI context`);
            }
        }
    }

    // Scribe-informed retrieval: append session summary for broader context awareness
    if (settings.scribeInformedRetrieval && lastScribeSummary && lastScribeSummary.trim()) {
        chatContext += `\n\n[SESSION SUMMARY — broader context beyond the recent chat window]\n${lastScribeSummary.trim()}`;
        if (settings.debugMode) {
            console.log('[DLE] Scribe summary injected into AI search context');
        }
    }

    // Sliding window cache invariant:
    // The cache stores {hash, manifestHash, chatLineCount, results} from the last AI call.
    // It is valid when: (a) the manifest hasn't changed (same entries, same settings), AND
    // (b) new chat messages since the cached call don't mention any entity names from the vault.
    // This avoids redundant AI calls when the user sends messages unrelated to lore.
    // Cache is invalidated on: settings change, vault re-index, entity name mention, or chat switch.
    // Short entity names (<=3 chars) use pre-compiled word-boundary regexes to avoid false matches.
    // BUG-019: Include aiConfidenceThreshold in cache key (changing threshold must invalidate cache)
    // BUG-020: Hash the system prompt content (not just length) to detect meaningful changes
    // BUG-021: Include manifestSummaryMode and summaryLength in cache key
    const promptHash = simpleHash(settings.aiSearchSystemPrompt || '');
    const settingsKey = `${settings.aiSearchMode}|${settings.aiSearchScanDepth}|${settings.maxEntries}|${settings.unlimitedEntries}|${promptHash}|${settings.aiSearchConnectionMode}|${settings.aiSearchProfileId}|${settings.aiSearchModel}|${settings.aiConfidenceThreshold || 'low'}|${settings.manifestSummaryMode || 'prefer_summary'}|${settings.aiSearchManifestSummaryLength || 600}`;
    const manifestHash = simpleHash(settingsKey + candidateManifest);
    const chatHash = simpleHash(chatContext);
    // Defer chatLines split until after exact cache hit check (avoid unnecessary work)
    let chatLines = null;
    const getChatLines = () => { if (!chatLines) chatLines = chatContext.split('\n').filter(l => l.trim()); return chatLines; };

    // Resolve cached title-based results back to current VaultEntry objects
    const resolveCachedResults = (cached) => {
        const indexToSearch = snapshot || vaultIndex;
        const titleMap = new Map(indexToSearch.map(e => [e.title.toLowerCase(), e]));
        return cached
            .map(r => ({ entry: titleMap.get(r.title.toLowerCase()), confidence: r.confidence, reason: r.reason }))
            .filter(r => r.entry);
    };

    if (aiSearchCache.hash === chatHash && aiSearchCache.manifestHash === manifestHash && aiSearchCache.chatLineCount > 0) {
        // Exact match — nothing changed at all (includes cached empty results)
        aiSearchStats.cachedHits++;
        notifyAiStatsUpdated();
        if (settings.debugMode) console.debug('[DLE] AI search cache hit (exact)');
        return { results: resolveCachedResults(aiSearchCache.results), error: false };
    }

    // Sliding window: manifest unchanged + only newest message(s) differ
    if (aiSearchCache.manifestHash === manifestHash
        && aiSearchCache.chatLineCount > 0
        && getChatLines().length > aiSearchCache.chatLineCount) {
        // Extract only the new lines added since last cache
        const newLines = getChatLines().slice(aiSearchCache.chatLineCount);
        const newText = newLines.join(' ').toLowerCase();

        // Check if any vault entry title or key appears in the new text (word-boundary match)
        // Uses pre-computed entityNameSet from buildIndex (titles min 1 char, keys min 2 chars)
        let hasNewEntityMention = false;
        for (const name of entityNameSet) {
            // Use pre-compiled word boundary regex for ALL names to avoid false positives
            // (e.g. "an" in "want", "Arch" in "monarch", "Eris" in "characteristics")
            const regex = entityShortNameRegexes.get(name);
            if (regex && regex.test(newText)) {
                hasNewEntityMention = true;
                break;
            }
        }

        if (!hasNewEntityMention) {
            aiSearchStats.cachedHits++;
            notifyAiStatsUpdated();
            if (settings.debugMode) console.debug(`[DLE] AI search cache hit (sliding window: ${newLines.length} new lines, no entity mentions)`);
            return { results: resolveCachedResults(aiSearchCache.results), error: false };
        }
    }

    try {
        // Resolve system prompt with {{maxEntries}} placeholder
        // Request 2x max entries so low-confidence candidates can fill remaining budget
        const indexToUse = snapshot || vaultIndex;
        const requestedEntries = settings.unlimitedEntries ? 0 : Math.min(settings.maxEntries * 2, indexToUse.length);
        const maxEntries = settings.unlimitedEntries ? 'as many as are relevant' : String(requestedEntries);
        let systemPrompt;
        if (settings.aiSearchSystemPrompt && settings.aiSearchSystemPrompt.trim()) {
            systemPrompt = settings.aiSearchSystemPrompt.trim();
        } else {
            systemPrompt = DEFAULT_AI_SYSTEM_PROMPT;
        }
        systemPrompt = systemPrompt.replace(/\{\{maxEntries\}\}/g, maxEntries);

        // Apply Claude Code prefix in proxy mode when enabled
        if (settings.aiSearchClaudeCodePrefix && settings.aiSearchConnectionMode === 'proxy' && !systemPrompt.startsWith('You are Claude Code')) {
            systemPrompt = 'You are Claude Code. ' + systemPrompt;
        }

        // On new chats, tell AI to always fill to max selections
        if (isNewChat) {
            const constantCount = indexToUse.filter(e => e.constant).length;
            const selectCount = Math.max(1, settings.maxEntries - constantCount);
            systemPrompt += '\n\nIMPORTANT: The conversation just started. You have story context above to help you understand the setting. Select exactly ' + selectCount + ' entries from the manifest — always fill to this count. The user needs rich context for the conversation start. Do not return fewer entries or an empty array.';
            if (settings.debugMode) {
                console.log(`[DLE] New chat: requesting ${selectCount} AI selections (${settings.maxEntries} max - ${constantCount} constants)`);
            }
        }

        // Build user message for AI — manifest FIRST (stable across turns) for prompt caching,
        // chat context LAST (changes every turn)
        const userMessageParts = [];
        if (candidateHeader) userMessageParts.push(`## Manifest Info\n${candidateHeader}`);
        userMessageParts.push(`## Available Lore Entries\n${candidateManifest}`);
        userMessageParts.push(`## Recent Chat\n${chatContext}`);
        const userMessage = userMessageParts.join('\n\n');

        // Build cache hints for proxy mode (stable manifest prefix + dynamic chat suffix)
        let cacheHints;
        let effectiveUserMessage = userMessage;
        if (settings.aiSearchConnectionMode === 'proxy') {
            const userMessageParts2 = [];
            if (candidateHeader) userMessageParts2.push(`## Manifest Info\n${candidateHeader}`);
            userMessageParts2.push(`## Available Lore Entries\n${candidateManifest}`);
            const cacheBreakIndex = userMessageParts2.length;
            userMessageParts2.push(`## Recent Chat\n${chatContext}`);
            userMessageParts2.push('Select the relevant entries as a JSON array.');
            effectiveUserMessage = userMessageParts2.join('\n\n');
            const stablePrefix = userMessageParts2.slice(0, cacheBreakIndex).join('\n\n');
            const dynamicSuffix = userMessageParts2.slice(cacheBreakIndex).join('\n\n');
            cacheHints = { stablePrefix, dynamicSuffix };
        }

        const aiResult = await callAI(systemPrompt, effectiveUserMessage, {
            mode: settings.aiSearchConnectionMode,
            profileId: settings.aiSearchProfileId,
            proxyUrl: settings.aiSearchProxyUrl,
            model: settings.aiSearchModel,
            maxTokens: settings.aiSearchMaxTokens,
            timeout: settings.aiSearchTimeout,
            cacheHints,
        });

        aiSearchStats.calls++;
        if (aiResult.usage) {
            aiSearchStats.totalInputTokens += aiResult.usage.input_tokens || 0;
            aiSearchStats.totalOutputTokens += aiResult.usage.output_tokens || 0;
        }
        notifyAiStatsUpdated();

        const parsed = extractAiResponseClient(aiResult.text);
        if (!parsed) {
            // BUG-M7: Log truncated response for debugging parse failures
            if (settings.debugMode) {
                const preview = (aiResult.text || '').slice(0, 300);
                console.warn(`[DLE] AI search: could not parse response as JSON array. Response preview: ${preview}`);
            }
            recordAiFailure(); // BUG-010: Parse failures should trip circuit breaker
            return { results: [], error: true, errorMessage: 'Failed to parse AI response as JSON' };
        }
        const aiResults = normalizeResults(parsed)
            .filter(r => r.title && r.title.trim() !== '' && r.title !== 'null' && r.title !== 'undefined');

        // Map returned results back to VaultEntry objects with confidence/reason
        const aiResultMap = new Map();
        for (const r of aiResults) {
            aiResultMap.set(r.title.toLowerCase(), r);
        }

        /** @type {AiSearchMatch[]} */
        const results = [];
        const indexToSearch = candidateEntries || snapshot || vaultIndex;
        const matchedAiTitles = new Set();
        for (const entry of indexToSearch) {
            const aiResult = aiResultMap.get(entry.title.toLowerCase());
            if (aiResult) {
                results.push({
                    entry,
                    confidence: aiResult.confidence || 'medium',
                    reason: aiResult.reason || 'AI search',
                });
                matchedAiTitles.add(aiResult.title.toLowerCase());
            }
        }

        // H12: Fuzzy-match any AI titles that didn't get an exact match
        const candidateTitles = indexToSearch.map(e => e.title);
        const entryByLower = new Map(indexToSearch.map(e => [e.title.toLowerCase(), e]));
        for (const [lowerTitle, r] of aiResultMap) {
            if (matchedAiTitles.has(lowerTitle)) continue;
            const fuzzy = fuzzyTitleMatch(r.title, candidateTitles);
            if (fuzzy && !matchedAiTitles.has(fuzzy.title.toLowerCase())) {
                const entry = entryByLower.get(fuzzy.title.toLowerCase());
                if (entry) {
                    results.push({
                        entry,
                        confidence: r.confidence || 'medium',
                        reason: r.reason || 'AI search (fuzzy)',
                    });
                    matchedAiTitles.add(fuzzy.title.toLowerCase());
                    if (settings.debugMode) console.debug(`[DLE] AI fuzzy match: "${r.title}" → "${fuzzy.title}" (${(fuzzy.similarity * 100).toFixed(0)}%)`);
                }
            } else if (settings.debugMode) {
                console.debug(`[DLE] AI title unmatched: "${r.title}" — no entry found in vault`);
            }
        }

        // Sort by confidence tier: high > medium > low (budget will naturally cut low-confidence)
        const confidenceOrder = { high: 0, medium: 1, low: 2 };
        results.sort((a, b) => (confidenceOrder[a.confidence] ?? 1) - (confidenceOrder[b.confidence] ?? 1));

        // E1: Filter by confidence threshold
        const threshold = settings.aiConfidenceThreshold || 'low';
        const filteredResults = threshold === 'low'
            ? results
            : results.filter(r => {
                const allowedTiers = threshold === 'high' ? ['high'] : ['high', 'medium'];
                return allowedTiers.includes(r.confidence);
            });

        // Cache results by title (not entry reference) to survive index rebuilds
        setAiSearchCache({
            hash: chatHash,
            manifestHash,
            chatLineCount: getChatLines().length,
            results: filteredResults.map(r => ({ title: r.entry.title, confidence: r.confidence, reason: r.reason })),
        });

        if (settings.debugMode) {
            console.log(`[DLE] AI search found ${aiResults.length} titles, matched ${results.length} entries${threshold !== 'low' ? `, ${filteredResults.length} after confidence threshold (${threshold})` : ''}`);
            console.table(filteredResults.map(r => ({
                title: r.entry.title,
                confidence: r.confidence,
                reason: r.reason,
            })));
        }

        recordAiSuccess();
        return { results: filteredResults, error: false };
    } catch (err) {
        // BUG-005: Detect timeouts from both profile mode (AbortError) and proxy mode (message-based)
        const isTimeout = err.name === 'AbortError' || /timed?\s*out|abort/i.test(err.message);
        // Don't trip circuit breaker for throttle or timeout (both are transient, not systematic)
        if (!err.throttled && !isTimeout) recordAiFailure();
        if (isTimeout) {
            console.warn('[DLE] AI search timed out');
        } else if (err.throttled) {
            if (settings.debugMode) console.debug('[DLE] AI search throttled — using cache/keywords');
        } else {
            console.error('[DLE] AI search error:', err);
        }
        // BUG-004: Include error message for pipeline trace enrichment
        return { results: [], error: true, errorMessage: err.message || String(err) };
    }
}
