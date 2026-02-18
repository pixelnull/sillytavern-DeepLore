import {
    setExtensionPrompt,
    getRequestHeaders,
    saveSettingsDebounced,
    sendMessageAsUser,
    Generate,
    amount_gen,
    main_api,
} from '../../../../script.js';
import {
    extension_settings,
    renderExtensionTemplateAsync,
} from '../../../extensions.js';
import { oai_settings } from '../../../openai.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';

const MODULE_NAME = 'deeplore';
const PROMPT_TAG = 'deeplore';
const PLUGIN_BASE = '/api/plugins/deeplore';

// ============================================================================
// Settings
// ============================================================================

const defaultSettings = {
    enabled: false,
    obsidianPort: 27123,
    obsidianApiKey: '',
    lorebookTag: 'lorebook',
    constantTag: 'lorebook-always',
    neverInsertTag: 'lorebook-never',
    scanDepth: 4,
    maxEntries: 10,
    unlimitedEntries: true,
    maxTokensBudget: 2048,
    unlimitedBudget: true,
    injectionPosition: 1,   // extension_prompt_types.IN_CHAT
    injectionDepth: 4,
    injectionRole: 0,        // extension_prompt_roles.SYSTEM
    injectionTemplate: '<{{title}}>\n{{content}}\n</{{title}}>',
    allowWIScan: false,
    recursiveScan: false,
    maxRecursionSteps: 3,
    matchWholeWords: false,
    caseSensitive: false,
    cacheTTL: 300,
    reviewResponseTokens: 0,
    debugMode: false,
};

/** Validation constraints for numeric settings */
const settingsConstraints = {
    obsidianPort: { min: 1, max: 65535 },
    scanDepth: { min: 1, max: 100 },
    maxEntries: { min: 1, max: 100 },
    maxTokensBudget: { min: 100, max: 100000 },
    injectionDepth: { min: 0, max: 9999 },
    maxRecursionSteps: { min: 1, max: 10 },
    cacheTTL: { min: 0, max: 86400 },
    reviewResponseTokens: { min: 0, max: 100000 },
};

/**
 * Validate and clamp settings to their allowed ranges.
 * @param {object} settings
 */
function validateSettings(settings) {
    for (const [key, { min, max }] of Object.entries(settingsConstraints)) {
        if (typeof settings[key] === 'number') {
            settings[key] = Math.max(min, Math.min(max, Math.round(settings[key])));
        }
    }
    // Ensure tags are trimmed strings
    if (typeof settings.lorebookTag === 'string') {
        settings.lorebookTag = settings.lorebookTag.trim() || 'lorebook';
    }
}

/** @returns {typeof defaultSettings} */
function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    // Fill in any missing defaults
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = value;
        }
    }
    validateSettings(extension_settings[MODULE_NAME]);
    return extension_settings[MODULE_NAME];
}

// ============================================================================
// Vault Index Cache
// ============================================================================

/**
 * @typedef {object} VaultEntry
 * @property {string} filename - Full path in vault
 * @property {string} title - Display title (from H1 or filename)
 * @property {string[]} keys - Trigger keywords from frontmatter
 * @property {string} content - Cleaned markdown content (frontmatter stripped)
 * @property {number} priority - Sort priority (lower = higher priority)
 * @property {boolean} constant - Always inject regardless of keywords
 * @property {number} tokenEstimate - Rough token count estimate
 * @property {number|null} scanDepth - Per-entry scan depth override (null = use global)
 * @property {boolean} excludeRecursion - Don't scan this entry's content during recursion
 */

/** @type {VaultEntry[]} */
let vaultIndex = [];
let indexTimestamp = 0;
let indexing = false;

/**
 * Parse simple YAML frontmatter from markdown content.
 * Handles basic key-value pairs and arrays (indented with - ).
 * @param {string} content - Raw markdown content
 * @returns {{ frontmatter: object, body: string }}
 */
function parseFrontmatter(content) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) {
        return { frontmatter: {}, body: content };
    }

    const yamlText = match[1];
    const body = match[2];
    const frontmatter = {};
    let currentKey = null;
    let currentArray = null;

    for (const line of yamlText.split('\n')) {
        const trimmed = line.trimEnd();

        // Array item: "  - value"
        if (/^\s+-\s+/.test(trimmed) && currentKey) {
            const value = trimmed.replace(/^\s+-\s+/, '').trim();
            if (!currentArray) {
                currentArray = [];
                frontmatter[currentKey] = currentArray;
            }
            currentArray.push(value);
            continue;
        }

        // Key-value pair: "key: value" or "key:"
        const kvMatch = trimmed.match(/^(\w[\w-]*)\s*:\s*(.*)/);
        if (kvMatch) {
            currentKey = kvMatch[1];
            const rawValue = kvMatch[2].trim();
            currentArray = null;

            if (rawValue === '' || rawValue === '[]') {
                // Value will come as array items on next lines, or is empty
                frontmatter[currentKey] = [];
                currentArray = frontmatter[currentKey];
            } else if (rawValue === 'true') {
                frontmatter[currentKey] = true;
            } else if (rawValue === 'false') {
                frontmatter[currentKey] = false;
            } else if (/^\d+$/.test(rawValue)) {
                frontmatter[currentKey] = parseInt(rawValue, 10);
            } else {
                // Strip surrounding quotes if present
                frontmatter[currentKey] = rawValue.replace(/^['"]|['"]$/g, '');
            }
        }
    }

    return { frontmatter, body };
}

/**
 * Clean markdown content for prompt injection.
 * @param {string} content - Raw markdown body (frontmatter already stripped)
 * @returns {string} Cleaned content
 */
function cleanContent(content) {
    let cleaned = content;

    // Strip image embeds: ![[image.png]] or ![alt](url)
    cleaned = cleaned.replace(/!\[\[.*?\]\]/g, '');
    cleaned = cleaned.replace(/!\[.*?\]\(.*?\)/g, '');

    // Convert wiki links: [[Link|Display]] -> Display, [[Link]] -> Link
    cleaned = cleaned.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
    cleaned = cleaned.replace(/\[\[([^\]]+)\]\]/g, '$1');

    // Collapse excessive blank lines
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    return cleaned.trim();
}

/**
 * Extract title from markdown content.
 * @param {string} body - Markdown body
 * @param {string} filename - Fallback filename
 * @returns {string}
 */
function extractTitle(body, filename) {
    const h1Match = body.match(/^#\s+(.+)$/m);
    if (h1Match) {
        return h1Match[1].trim();
    }
    // Fallback: filename without extension and path
    const parts = filename.split('/');
    const name = parts[parts.length - 1];
    return name.replace(/\.md$/, '');
}

/**
 * Build the vault index by fetching all files from the server plugin.
 */
async function buildIndex() {
    const settings = getSettings();

    if (indexing) {
        console.debug('[DeepLore] Index build already in progress');
        return;
    }

    indexing = true;

    try {
        const response = await fetch(`${PLUGIN_BASE}/index`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                port: settings.obsidianPort,
                apiKey: settings.obsidianApiKey,
            }),
        });

        if (!response.ok) {
            throw new Error(`Server plugin returned HTTP ${response.status}`);
        }

        const data = await response.json();

        if (!data.files || !Array.isArray(data.files)) {
            throw new Error('Invalid response from server plugin');
        }

        const entries = [];
        const tagToMatch = settings.lorebookTag.toLowerCase();
        const constantTagToMatch = settings.constantTag ? settings.constantTag.toLowerCase() : '';
        const neverInsertTagToMatch = settings.neverInsertTag ? settings.neverInsertTag.toLowerCase() : '';

        for (const file of data.files) {
            const { frontmatter, body } = parseFrontmatter(file.content);

            // Check if this file has the lorebook tag
            const tags = Array.isArray(frontmatter.tags)
                ? frontmatter.tags.map(t => String(t).toLowerCase())
                : [];

            if (!tags.includes(tagToMatch)) {
                continue;
            }

            // Skip entries explicitly disabled via frontmatter
            if (frontmatter.enabled === false) {
                continue;
            }

            // Skip entries with the never-insert tag
            if (neverInsertTagToMatch && tags.includes(neverInsertTagToMatch)) {
                continue;
            }

            // Extract keys
            const keys = Array.isArray(frontmatter.keys)
                ? frontmatter.keys.map(k => String(k))
                : [];

            const title = extractTitle(body, file.filename);
            const content = cleanContent(body);
            const priority = typeof frontmatter.priority === 'number' ? frontmatter.priority : 100;
            const constant = frontmatter.constant === true || (constantTagToMatch && tags.includes(constantTagToMatch));
            const scanDepth = typeof frontmatter.scanDepth === 'number' ? frontmatter.scanDepth : null;
            const excludeRecursion = frontmatter.excludeRecursion === true;

            entries.push({
                filename: file.filename,
                title,
                keys,
                content,
                priority,
                constant,
                tokenEstimate: 0,
                scanDepth,
                excludeRecursion,
            });
        }

        // Compute accurate token counts using SillyTavern's tokenizer
        await Promise.all(entries.map(async (entry) => {
            try {
                entry.tokenEstimate = await getTokenCountAsync(entry.content);
            } catch {
                // Fallback to rough estimate if tokenizer unavailable
                entry.tokenEstimate = Math.ceil(entry.content.length / 3.5);
            }
        }));

        vaultIndex = entries;
        indexTimestamp = Date.now();

        console.log(`[DeepLore] Indexed ${entries.length} entries from ${data.total} vault files`);
        updateIndexStats();
    } catch (err) {
        console.error('[DeepLore] Failed to build index:', err);
        toastr.error(String(err), 'DeepLore', { preventDuplicates: true });
    } finally {
        indexing = false;
    }
}

/**
 * Get the max response token length from the current connection profile.
 * @returns {number}
 */
function getMaxResponseTokens() {
    return main_api === 'openai' ? oai_settings.openai_max_tokens : amount_gen;
}

/**
 * Ensure the vault index is fresh, rebuilding if cache has expired.
 */
async function ensureIndexFresh() {
    const settings = getSettings();
    const ttlMs = settings.cacheTTL * 1000;
    const now = Date.now();

    if (vaultIndex.length === 0 || (ttlMs > 0 && now - indexTimestamp > ttlMs)) {
        await buildIndex();
    }
}

// ============================================================================
// Keyword Matching
// ============================================================================

/**
 * Escape a string for use in a regex.
 * @param {string} str
 * @returns {string}
 */
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build scan text from chat messages.
 * @param {object[]} chat - Chat messages array
 * @param {number} depth - Number of recent messages to scan
 * @returns {string}
 */
function buildScanText(chat, depth) {
    const recentMessages = chat.slice(-Math.min(depth, chat.length));
    return recentMessages
        .map(m => `${m.name || ''}: ${m.mes || ''}`)
        .join('\n');
}

/**
 * Test if an entry's keys match against the given text.
 * @param {VaultEntry} entry
 * @param {string} scanText
 * @param {typeof defaultSettings} settings
 * @returns {string|null} The matched key, or null if no match
 */
function testEntryMatch(entry, scanText, settings) {
    if (entry.keys.length === 0) return null;

    const haystack = settings.caseSensitive ? scanText : scanText.toLowerCase();

    for (const rawKey of entry.keys) {
        const key = settings.caseSensitive ? rawKey : rawKey.toLowerCase();

        if (settings.matchWholeWords) {
            const regex = new RegExp(`\\b${escapeRegex(key)}\\b`, settings.caseSensitive ? '' : 'i');
            if (regex.test(scanText)) return rawKey;
        } else {
            if (haystack.includes(key)) return rawKey;
        }
    }
    return null;
}

/**
 * Match vault entries against chat messages, with recursive scanning support.
 * @param {object[]} chat - Chat messages array
 * @returns {{ matched: VaultEntry[], matchedKeys: Map<string, string> }} Matched entries sorted by priority, and which key matched each
 */
function matchEntries(chat) {
    const settings = getSettings();
    const globalScanText = buildScanText(chat, settings.scanDepth);
    /** @type {Set<VaultEntry>} */
    const matchedSet = new Set();
    /** @type {Map<string, string>} entry title -> matched key */
    const matchedKeys = new Map();

    // Initial scan pass
    for (const entry of vaultIndex) {
        if (entry.constant) {
            matchedSet.add(entry);
            matchedKeys.set(entry.title, '(constant)');
            continue;
        }

        // Use per-entry scan depth if set, otherwise use global scan text
        const scanText = entry.scanDepth !== null
            ? buildScanText(chat, entry.scanDepth)
            : globalScanText;

        const key = testEntryMatch(entry, scanText, settings);
        if (key) {
            matchedSet.add(entry);
            matchedKeys.set(entry.title, key);
        }
    }

    // Recursive scanning: scan matched entry content for more matches
    if (settings.recursiveScan && settings.maxRecursionSteps > 0) {
        let step = 0;
        /** @type {Set<VaultEntry>} Entries added in the previous step (seed with initial matches) */
        let newlyMatched = new Set(matchedSet);

        while (newlyMatched.size > 0 && step < settings.maxRecursionSteps) {
            step++;

            // Only scan content from entries added in the previous step
            const recursionText = [...newlyMatched]
                .filter(e => !e.excludeRecursion)
                .map(e => e.content)
                .join('\n');

            if (!recursionText.trim()) break;

            newlyMatched = new Set();

            for (const entry of vaultIndex) {
                if (matchedSet.has(entry)) continue;
                if (entry.constant) continue; // Already added

                const key = testEntryMatch(entry, recursionText, settings);
                if (key) {
                    matchedSet.add(entry);
                    newlyMatched.add(entry);
                    matchedKeys.set(entry.title, `${key} (recursion step ${step})`);
                }
            }
        }
    }

    // Sort by priority (ascending - lower number = higher priority)
    const matched = [...matchedSet].sort((a, b) => a.priority - b.priority);

    return { matched, matchedKeys };
}

/**
 * Format matched entries for injection, respecting budget limits.
 * @param {VaultEntry[]} entries - Matched entries sorted by priority
 * @returns {{ text: string, count: number, totalTokens: number }} Injection text and stats
 */
function formatWithBudget(entries) {
    const settings = getSettings();
    const template = settings.injectionTemplate || '<{{title}}>\n{{content}}\n</{{title}}>';
    const parts = [];
    let totalTokens = 0;
    let count = 0;

    for (const entry of entries) {
        if (!settings.unlimitedEntries && count >= settings.maxEntries) break;
        if (!settings.unlimitedBudget && totalTokens + entry.tokenEstimate > settings.maxTokensBudget && count > 0) break;

        const text = template
            .replace(/\{\{title\}\}/g, entry.title)
            .replace(/\{\{content\}\}/g, entry.content);

        parts.push(text);
        totalTokens += entry.tokenEstimate;
        count++;
    }

    return { text: parts.join('\n\n'), count, totalTokens };
}

// ============================================================================
// Generation Interceptor
// ============================================================================

/** Track last warning ratio to avoid spamming toasts */
let lastWarningRatio = 0;

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

    // Clear previous injection
    setExtensionPrompt(PROMPT_TAG, '', settings.injectionPosition, settings.injectionDepth, false, settings.injectionRole);

    try {
        // Ensure index is fresh
        await ensureIndexFresh();

        if (vaultIndex.length === 0) {
            if (settings.debugMode) {
                console.debug('[DeepLore] No entries indexed, skipping');
            }
            return;
        }

        // Check scan text exists
        const scanText = buildScanText(chat, settings.scanDepth);
        if (!scanText.trim()) {
            return;
        }

        // Match entries (now takes chat array for per-entry scan depth)
        const { matched, matchedKeys } = matchEntries(chat);

        if (matched.length === 0) {
            if (settings.debugMode) {
                console.debug('[DeepLore] No entries matched');
            }
            return;
        }

        // Format with budget
        const { text: injectionText, count: injectedCount, totalTokens } = formatWithBudget(matched);

        if (injectionText) {
            setExtensionPrompt(
                PROMPT_TAG,
                injectionText,
                settings.injectionPosition,
                settings.injectionDepth,
                settings.allowWIScan,
                settings.injectionRole,
            );

            // Context usage warning
            if (contextSize > 0) {
                const ratio = totalTokens / contextSize;
                if (ratio > 0.20 && ratio > lastWarningRatio + 0.05) {
                    const pct = Math.round(ratio * 100);
                    toastr.warning(
                        `${injectedCount} entries injected (~${totalTokens} tokens, ${pct}% of context). Consider setting a token budget.`,
                        'DeepLore',
                        { preventDuplicates: true, timeOut: 8000 },
                    );
                    lastWarningRatio = ratio;
                }
            }

            if (settings.debugMode) {
                console.log(`[DeepLore] ${matched.length} matched, ${injectedCount} injected, ~${totalTokens} tokens` +
                    (contextSize > 0 ? ` (${Math.round(totalTokens / contextSize * 100)}% of ${contextSize} context)` : ''));
                console.table(matched.slice(0, injectedCount).map(e => ({
                    title: e.title,
                    matchedKey: matchedKeys.get(e.title) || '?',
                    priority: e.priority,
                    tokens: e.tokenEstimate,
                    constant: e.constant,
                })));
            }
        }
    } catch (err) {
        console.error('[DeepLore] Error during generation:', err);
    }
}

// Register the interceptor on globalThis so SillyTavern can find it
globalThis.deepLore_onGenerate = onGenerate;

// ============================================================================
// UI & Settings Binding
// ============================================================================

function updateIndexStats() {
    const statsEl = document.getElementById('deeplore_index_stats');
    if (statsEl) {
        if (vaultIndex.length > 0) {
            const totalKeys = vaultIndex.reduce((sum, e) => sum + e.keys.length, 0);
            const constants = vaultIndex.filter(e => e.constant).length;
            const totalTokens = vaultIndex.reduce((sum, e) => sum + e.tokenEstimate, 0);
            statsEl.textContent = `${vaultIndex.length} entries (${totalKeys} keywords, ${constants} always-send, ~${totalTokens} total tokens)`;
        } else {
            statsEl.textContent = 'No index loaded.';
        }
    }
}

function loadSettingsUI() {
    const settings = getSettings();

    $('#deeplore_enabled').prop('checked', settings.enabled);
    $('#deeplore_port').val(settings.obsidianPort);
    $('#deeplore_api_key').val(settings.obsidianApiKey);
    $('#deeplore_tag').val(settings.lorebookTag);
    $('#deeplore_constant_tag').val(settings.constantTag);
    $('#deeplore_never_insert_tag').val(settings.neverInsertTag);
    $('#deeplore_scan_depth').val(settings.scanDepth);
    $('#deeplore_max_entries').val(settings.maxEntries);
    $('#deeplore_unlimited_entries').prop('checked', settings.unlimitedEntries);
    $('#deeplore_max_entries').prop('disabled', settings.unlimitedEntries);
    $('#deeplore_token_budget').val(settings.maxTokensBudget);
    $('#deeplore_unlimited_budget').prop('checked', settings.unlimitedBudget);
    $('#deeplore_token_budget').prop('disabled', settings.unlimitedBudget);
    $('#deeplore_template').val(settings.injectionTemplate);
    $(`input[name="deeplore_position"][value="${settings.injectionPosition}"]`).prop('checked', true);
    $('#deeplore_depth').val(settings.injectionDepth);
    $('#deeplore_role').val(settings.injectionRole);
    $('#deeplore_allow_wi_scan').prop('checked', settings.allowWIScan);
    $('#deeplore_recursive_scan').prop('checked', settings.recursiveScan);
    $('#deeplore_max_recursion').val(settings.maxRecursionSteps);
    $('#deeplore_max_recursion').prop('disabled', !settings.recursiveScan);
    $('#deeplore_cache_ttl').val(settings.cacheTTL);
    $('#deeplore_review_tokens').val(settings.reviewResponseTokens);
    $('#deeplore_case_sensitive').prop('checked', settings.caseSensitive);
    $('#deeplore_match_whole_words').prop('checked', settings.matchWholeWords);
    $('#deeplore_debug').prop('checked', settings.debugMode);

    updateIndexStats();
}

function bindSettingsEvents() {
    const settings = getSettings();

    $('#deeplore_enabled').on('change', function () {
        settings.enabled = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#deeplore_port').on('input', function () {
        settings.obsidianPort = Number($(this).val()) || 27123;
        saveSettingsDebounced();
    });

    $('#deeplore_api_key').on('input', function () {
        settings.obsidianApiKey = String($(this).val());
        saveSettingsDebounced();
    });

    $('#deeplore_tag').on('input', function () {
        settings.lorebookTag = String($(this).val()).trim() || 'lorebook';
        saveSettingsDebounced();
    });

    $('#deeplore_constant_tag').on('input', function () {
        settings.constantTag = String($(this).val()).trim();
        saveSettingsDebounced();
    });

    $('#deeplore_never_insert_tag').on('input', function () {
        settings.neverInsertTag = String($(this).val()).trim();
        saveSettingsDebounced();
    });

    $('#deeplore_scan_depth').on('input', function () {
        settings.scanDepth = Number($(this).val()) || 4;
        saveSettingsDebounced();
    });

    $('#deeplore_max_entries').on('input', function () {
        settings.maxEntries = Number($(this).val()) || 10;
        saveSettingsDebounced();
    });

    $('#deeplore_unlimited_entries').on('change', function () {
        settings.unlimitedEntries = $(this).prop('checked');
        $('#deeplore_max_entries').prop('disabled', settings.unlimitedEntries);
        saveSettingsDebounced();
    });

    $('#deeplore_token_budget').on('input', function () {
        settings.maxTokensBudget = Number($(this).val()) || 2048;
        saveSettingsDebounced();
    });

    $('#deeplore_unlimited_budget').on('change', function () {
        settings.unlimitedBudget = $(this).prop('checked');
        $('#deeplore_token_budget').prop('disabled', settings.unlimitedBudget);
        saveSettingsDebounced();
    });

    $('#deeplore_template').on('input', function () {
        settings.injectionTemplate = String($(this).val());
        saveSettingsDebounced();
    });

    $('input[name="deeplore_position"]').on('change', function () {
        settings.injectionPosition = Number($(this).val());
        saveSettingsDebounced();
    });

    $('#deeplore_depth').on('input', function () {
        settings.injectionDepth = Number($(this).val()) || 4;
        saveSettingsDebounced();
    });

    $('#deeplore_role').on('change', function () {
        settings.injectionRole = Number($(this).val());
        saveSettingsDebounced();
    });

    $('#deeplore_allow_wi_scan').on('change', function () {
        settings.allowWIScan = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#deeplore_recursive_scan').on('change', function () {
        settings.recursiveScan = $(this).prop('checked');
        $('#deeplore_max_recursion').prop('disabled', !settings.recursiveScan);
        saveSettingsDebounced();
    });

    $('#deeplore_max_recursion').on('input', function () {
        settings.maxRecursionSteps = Number($(this).val()) || 3;
        saveSettingsDebounced();
    });

    $('#deeplore_cache_ttl').on('input', function () {
        settings.cacheTTL = Number($(this).val()) || 300;
        saveSettingsDebounced();
    });

    $('#deeplore_review_tokens').on('input', function () {
        settings.reviewResponseTokens = Number($(this).val()) || 0;
        saveSettingsDebounced();
    });

    $('#deeplore_case_sensitive').on('change', function () {
        settings.caseSensitive = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#deeplore_match_whole_words').on('change', function () {
        settings.matchWholeWords = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#deeplore_debug').on('change', function () {
        settings.debugMode = $(this).prop('checked');
        saveSettingsDebounced();
    });

    // Test Connection button
    $('#deeplore_test_connection').on('click', async function () {
        const statusEl = $('#deeplore_connection_status');
        statusEl.text('Testing...').removeClass('success failure');

        try {
            const response = await fetch(`${PLUGIN_BASE}/test`, {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    port: settings.obsidianPort,
                    apiKey: settings.obsidianApiKey,
                }),
            });

            const data = await response.json();

            if (data.ok) {
                const authStatus = data.authenticated ? 'authenticated' : 'not authenticated';
                statusEl.text(`Connected (${authStatus})`).addClass('success').removeClass('failure');
            } else {
                statusEl.text(`Failed: ${data.error}`).addClass('failure').removeClass('success');
            }
        } catch (err) {
            statusEl.text(`Error: ${err.message}`).addClass('failure').removeClass('success');
        }
    });

    // Refresh Index button
    $('#deeplore_refresh').on('click', async function () {
        $('#deeplore_index_stats').text('Refreshing...');
        vaultIndex = [];
        indexTimestamp = 0;
        await buildIndex();
    });
}

// ============================================================================
// Slash Commands
// ============================================================================

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'deeplore-refresh',
        callback: async () => {
            vaultIndex = [];
            indexTimestamp = 0;
            await buildIndex();
            const msg = `Indexed ${vaultIndex.length} entries.`;
            toastr.success(msg, 'DeepLore');
            return msg;
        },
        helpString: 'Force refresh the DeepLore vault index cache.',
        returns: 'Status message',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'deeplore-status',
        callback: async () => {
            const settings = getSettings();
            const constants = vaultIndex.filter(e => e.constant).length;
            const totalTokens = vaultIndex.reduce((sum, e) => sum + e.tokenEstimate, 0);
            const lines = [
                `Enabled: ${settings.enabled}`,
                `Port: ${settings.obsidianPort}`,
                `Lorebook Tag: #${settings.lorebookTag}`,
                `Always-Send Tag: ${settings.constantTag ? '#' + settings.constantTag : '(none)'}`,
                `Never-Insert Tag: ${settings.neverInsertTag ? '#' + settings.neverInsertTag : '(none)'}`,
                `Entries: ${vaultIndex.length} (${constants} always-send, ~${totalTokens} tokens)`,
                `Budget: ${settings.unlimitedBudget ? 'unlimited' : settings.maxTokensBudget + ' tokens'}`,
                `Max Entries: ${settings.unlimitedEntries ? 'unlimited' : settings.maxEntries}`,
                `Recursive: ${settings.recursiveScan ? 'on (max ' + settings.maxRecursionSteps + ' steps)' : 'off'}`,
                `Cache: ${indexTimestamp ? Math.round((Date.now() - indexTimestamp) / 1000) + 's old' : 'none'} / TTL ${settings.cacheTTL}s`,
            ];
            const msg = lines.join('\n');
            toastr.info(msg, 'DeepLore', { timeOut: 10000 });
            return msg;
        },
        helpString: 'Show DeepLore connection status and index stats.',
        returns: 'Status information',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'deeplore-review',
        callback: async (_args, userPrompt) => {
            await ensureIndexFresh();

            if (vaultIndex.length === 0) {
                toastr.warning('No entries indexed. Check your connection and lorebook tag settings.', 'DeepLore');
                return '';
            }

            const loreDump = vaultIndex.map(entry => {
                return `## ${entry.title}\n${entry.content}`;
            }).join('\n\n---\n\n');

            const settings = getSettings();
            const totalTokens = vaultIndex.reduce((sum, e) => sum + e.tokenEstimate, 0);
            const responseTokens = settings.reviewResponseTokens > 0
                ? settings.reviewResponseTokens
                : getMaxResponseTokens();
            const budgetHint = `\n\nKeep your response under ${responseTokens} tokens.`;
            const defaultQuestion = 'Review this lorebook/world-building vault. Comment on consistency, gaps, interesting connections between entries, and any suggestions for improvement.';
            const question = (userPrompt && userPrompt.trim()) ? userPrompt.trim() : defaultQuestion;

            const message = `[DeepLore Review — ${vaultIndex.length} entries, ~${totalTokens} tokens]\n\n${loreDump}\n\n---\n\n${question}${budgetHint}`;
            if (settings.debugMode) {
                console.log('[DeepLore] Lore review prompt:', message);
            }

            toastr.info(`Sending ${vaultIndex.length} entries (~${totalTokens} tokens)...`, 'DeepLore', { timeOut: 5000 });

            await sendMessageAsUser(message, '');
            await Generate('normal');

            return '';
        },
        helpString: 'Send the entire Obsidian vault to the AI for review. Optionally provide a custom question, e.g. /deeplore-review What inconsistencies do you see?',
        returns: 'AI review posted to chat',
    }));
}

// ============================================================================
// Initialization
// ============================================================================

jQuery(async function () {
    try {
        const settingsHtml = await renderExtensionTemplateAsync(
            'third-party/sillytavern-DeepLore',
            'settings',
        );
        $('#extensions_settings2').append(settingsHtml);

        loadSettingsUI();
        bindSettingsEvents();
        registerSlashCommands();

        console.log('[DeepLore] Client extension initialized');
    } catch (err) {
        console.error('[DeepLore] Failed to initialize:', err);
    }
});
