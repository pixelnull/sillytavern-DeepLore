/**
 * DeepLore Enhanced — Settings UI: load, bind, stats
 */
import {
    saveSettingsDebounced,
    chat,
} from '../../../../../../script.js';
import { ConnectionManagerRequestService } from '../../../../shared.js';
import { escapeHtml } from '../../../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../../popup.js';
import { renderExtensionTemplateAsync } from '../../../../../extensions.js';
import { buildAiChatContext } from '../../core/utils.js';
import { getSettings, getPrimaryVault, DEFAULT_AI_SYSTEM_PROMPT, PROMPT_TAG_PREFIX, settingsConstraints, invalidateSettingsCache, defaultSettings } from '../../settings.js';
import { promptManager } from '../../../../../openai.js';
import { testConnection } from '../vault/obsidian-api.js';
import { testProxyConnection } from '../ai/proxy-api.js';
import {
    vaultIndex,
    computeOverallStatus,
    setVaultIndex, setIndexTimestamp, setLastHealthResult,
    onIndexUpdated, onAiStatsUpdated, onCircuitStateChanged,
} from '../state.js';
import { ensureIndexFresh } from '../vault/vault.js';
import {
    callViaProfile, getProfileModelHint,
    buildCandidateManifest,
} from '../ai/ai.js';
import { matchEntries } from '../pipeline/pipeline.js';
import { setupSyncPolling } from '../vault/sync.js';
import { buildIndex, buildIndexWithReuse } from '../vault/vault.js';
import { showNotebookPopup, showBrowsePopup, showAiNotepadPopup } from './popups.js';
import { runHealthCheck } from './diagnostics.js';

// ============================================================================
// Vault List UI
// ============================================================================

/**
 * Render the dynamic vault list in the settings panel.
 * @param {object} settings
 */
function renderVaultList(settings, container = null) {
    container = container || document.getElementById('dle-vault-list');
    if (!container) return;

    const vaults = settings.vaults || [];
    let html = '';

    for (let i = 0; i < vaults.length; i++) {
        const v = vaults[i];
        html += `<div class="dle-vault-row" data-index="${i}">
            <div class="flex-container" style="gap: 6px; align-items: center;">
                <label class="checkbox_label" style="flex: 0 0 auto;" title="Enable/disable this vault">
                    <input type="checkbox" class="dle-vault-enabled checkbox" ${v.enabled ? 'checked' : ''} />
                </label>
                <input type="text" class="dle-vault-name text_pole" placeholder="Obsidian vault name" value="${escapeHtml(v.name)}" title="Must match your Obsidian vault name exactly (used for deep links)" style="flex: 1; min-width: 80px;" aria-label="Vault name" />
                <input type="text" class="dle-vault-host text_pole" placeholder="Host" value="${escapeHtml(v.host || '127.0.0.1')}" style="flex: 0 0 100px;" aria-label="Vault host" />
                <input type="number" class="dle-vault-port text_pole" placeholder="Port" value="${v.port}" min="1" max="65535" style="flex: 0 0 80px;" aria-label="Vault port" />
                <input type="password" class="dle-vault-key text_pole" placeholder="API Key" value="${escapeHtml(v.apiKey)}" style="flex: 2; min-width: 100px;" aria-label="API key" />
                <div class="dle-vault-test menu_button menu_button_icon" title="Test this vault" style="flex: 0 0 auto;" tabindex="0" aria-label="Test vault connection">
                    <i class="fa-solid fa-plug" aria-hidden="true"></i>
                </div>
                <div class="dle-vault-remove menu_button menu_button_icon" title="Remove this vault" style="flex: 0 0 auto;" tabindex="0" aria-label="Remove vault">
                    <i class="fa-solid fa-trash" aria-hidden="true"></i>
                </div>
            </div>
            <span class="dle-vault-status dle-status dle-text-sm"></span>
        </div>`;
    }

    container.innerHTML = html;
}

/**
 * Bind event handlers for the vault list UI (delegated events).
 * @param {object} settings
 */
function bindVaultListEvents(settings, $scope = null, $addBtn = null) {
    const container = $scope || $('#dle-vault-list');

    // Input changes on vault fields
    container.on('input', '.dle-vault-name, .dle-vault-host, .dle-vault-port, .dle-vault-key', function () {
        const row = $(this).closest('.dle-vault-row');
        const idx = parseInt(row.data('index'), 10);
        if (isNaN(idx) || !settings.vaults[idx]) return;

        if ($(this).hasClass('dle-vault-name')) {
            let newName = String($(this).val()).trim() || 'Vault';
            // Validate unique vault names — prevent duplicates
            const otherNames = settings.vaults
                .filter((_, vi) => vi !== idx)
                .map(v => v.name.toLowerCase());
            if (otherNames.includes(newName.toLowerCase())) {
                // Append incrementing number to make it unique
                let counter = 2;
                while (otherNames.includes(`${newName} ${counter}`.toLowerCase())) {
                    counter++;
                }
                newName = `${newName} ${counter}`;
                $(this).val(newName);
                toastr.warning(`Vault name already in use. Renamed to "${newName}".`, 'DeepLore Enhanced', { timeOut: 4000 });
            }
            settings.vaults[idx].name = newName;
        } else if ($(this).hasClass('dle-vault-host')) {
            let hostVal = String($(this).val()).trim();
            hostVal = hostVal.replace(/^https?:\/\//, ''); // Strip protocol prefix
            hostVal = hostVal.replace(/:\d+$/, ''); // Strip port suffix if user pasted host:port
            settings.vaults[idx].host = hostVal || '127.0.0.1';
        } else if ($(this).hasClass('dle-vault-port')) {
            settings.vaults[idx].port = Math.max(1, Math.min(65535, numVal($(this).val(), 27123)));
        } else if ($(this).hasClass('dle-vault-key')) {
            settings.vaults[idx].apiKey = String($(this).val());
        }
        // Keep legacy fields in sync with primary vault
        const primary = getPrimaryVault(settings);
        settings.obsidianPort = primary.port;
        settings.obsidianApiKey = primary.apiKey;
        saveSettingsDebounced();
    });

    // Enable/disable toggle
    container.on('change', '.dle-vault-enabled', function () {
        const row = $(this).closest('.dle-vault-row');
        const idx = parseInt(row.data('index'), 10);
        if (isNaN(idx) || !settings.vaults[idx]) return;
        settings.vaults[idx].enabled = $(this).prop('checked');
        const primary = getPrimaryVault(settings);
        settings.obsidianPort = primary.port;
        settings.obsidianApiKey = primary.apiKey;
        saveSettingsDebounced();
    });

    // Test individual vault
    container.on('click', '.dle-vault-test', async function () {
        const $btn = $(this);
        if ($btn.hasClass('disabled')) return;
        $btn.addClass('disabled');
        const row = $btn.closest('.dle-vault-row');
        const idx = parseInt(row.data('index'), 10);
        if (isNaN(idx) || !settings.vaults[idx]) { $btn.removeClass('disabled'); return; }
        const vault = settings.vaults[idx];
        const statusEl = row.find('.dle-vault-status');
        statusEl.text('Testing...').removeClass('success failure');
        try {
            const data = await testConnection(vault.host, vault.port, vault.apiKey);
            if (data.ok) {
                statusEl.text(`Connected${data.authenticated ? '' : ' (no auth)'}`).addClass('success').removeClass('failure');
                announceToSR(`Vault ${vault.name} connected successfully.`);
            } else {
                statusEl.text(`Failed: ${data.error}`).addClass('failure').removeClass('success');
                announceToSR(`Vault ${vault.name} connection failed: ${data.error}`);
            }
        } catch (err) {
            statusEl.text(`Error: ${err.message}`).addClass('failure').removeClass('success');
            announceToSR(`Vault ${vault.name} test error: ${err.message}`);
        } finally { $btn.removeClass('disabled'); }
    });

    // Remove vault (with confirmation)
    container.on('click', '.dle-vault-remove', async function () {
        const row = $(this).closest('.dle-vault-row');
        const idx = parseInt(row.data('index'), 10);
        if (isNaN(idx) || !settings.vaults[idx]) return;
        if (settings.vaults.length <= 1) {
            toastr.warning('At least one vault connection is required. Add another vault before removing this one.', 'DeepLore Enhanced');
            return;
        }
        const vaultName = settings.vaults[idx].name || `Vault ${idx + 1}`;
        const confirmed = await callGenericPopup(
            `Remove vault "${escapeHtml(vaultName)}"? This cannot be undone.`,
            POPUP_TYPE.CONFIRM, '', { okButton: 'Remove', cancelButton: 'Cancel' },
        );
        if (!confirmed) return;
        settings.vaults.splice(idx, 1);
        const primary = getPrimaryVault(settings);
        settings.obsidianPort = primary.port;
        settings.obsidianApiKey = primary.apiKey;
        saveSettingsDebounced();
        renderVaultList(settings, container[0]);
    });

    // Add vault button
    const $addButton = $addBtn || $('#dle-add-vault');
    $addButton.on('click', function () {
        settings.vaults.push({ name: `Vault ${settings.vaults.length + 1}`, host: '127.0.0.1', port: 27123, apiKey: '', enabled: true });
        saveSettingsDebounced();
        renderVaultList(settings, container[0]);
    });
}

// ============================================================================
// Stats Display
// ============================================================================

/**
 * Announce a status message to screen readers via ARIA live region.
 * @param {string} message
 */
function announceToSR(message) {
    const el = document.getElementById('dle-drawer-live');
    if (el) el.textContent = message;
}

/** Status dot characters and labels for each overall status level. */
const STATUS_DISPLAY = {
    ok:       { dot: '\u{1F7E2}', label: 'OK',       title: 'All systems operational' },
    degraded: { dot: '\u{1F7E1}', label: 'Degraded',  title: 'Some vaults unreachable or health issues detected' },
    limited:  { dot: '\u{1F7E0}', label: 'Limited',   title: 'AI search temporarily paused or using stale cache' },
    offline:  { dot: '\u{1F534}', label: 'Offline',    title: 'No vaults reachable and no cached data' },
};

/** Update the header badge with entry count and overall status indicator. */
function updateHeaderBadge() {
    const headerBadge = document.getElementById('dle-header-badge');
    if (!headerBadge) return;

    if (vaultIndex.length > 0) {
        const status = computeOverallStatus();
        const info = STATUS_DISPLAY[status];
        headerBadge.textContent = `(${vaultIndex.length} entries | ${info.dot} ${info.label})`;
        headerBadge.title = info.title;
    } else {
        const status = computeOverallStatus();
        if (status === 'offline') {
            const info = STATUS_DISPLAY.offline;
            headerBadge.textContent = `(${info.dot} ${info.label})`;
            headerBadge.title = info.title;
        } else {
            headerBadge.textContent = '';
            headerBadge.title = '';
        }
    }
}

// ============================================================================
// Settings Popup
// ============================================================================

/**
 * Populate a profile dropdown within a specific container (works on detached DOM).
 */
function populateProfileDropdownIn($container, selectId, settingsKey) {
    const select = $container.find('#' + selectId)[0];
    if (!select) return;
    const settings = getSettings();
    const currentId = settings[settingsKey];
    select.innerHTML = '<option value="">— Select a profile —</option>';
    try {
        const profiles = ConnectionManagerRequestService.getSupportedProfiles();
        for (const p of profiles) {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = `${p.name} (${p.api}${p.model ? ' / ' + p.model : ''})`;
            if (p.id === currentId) opt.selected = true;
            select.appendChild(opt);
        }
    } catch {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'Connection Manager not available';
        opt.disabled = true;
        select.appendChild(opt);
    }
}

/**
 * Update visibility of connection fields within a container (works on detached DOM).
 */
function updateConnectionVisibilityIn($container, config) {
    const settings = getSettings();
    const mode = settings[config.modeSettingsKey] || (config.hasStMode ? 'st' : 'profile');
    const isProfile = mode === 'profile';
    const isProxy = mode === 'proxy';
    $container.find(config.profileRowSelector).toggle(isProfile);
    $container.find(config.proxyRowSelector).toggle(isProxy);
    if (config.externalOnlySelectors) {
        const isExternal = isProfile || isProxy;
        for (const sel of config.externalOnlySelectors) $container.find(sel).toggle(isExternal);
    }
    if (config.modelInputSelector) {
        const modelInput = $container.find(config.modelInputSelector);
        if (isProfile) {
            let hint = '';
            if (config.profileIdSettingsKey) {
                try {
                    const profileId = settings[config.profileIdSettingsKey];
                    if (profileId) hint = ConnectionManagerRequestService.getProfile(profileId).model || '';
                } catch { /* noop */ }
            }
            modelInput.attr('placeholder', hint ? `Profile: ${hint}` : 'Leave empty to use profile model');
        } else if (isProxy) {
            modelInput.attr('placeholder', 'claude-haiku-4-5-20251001');
        }
    }
}

function updatePopupModeVisibility($container, settings) {
    const aiEnabled = settings.aiSearchEnabled;
    const isProxy = settings.aiSearchConnectionMode === 'proxy';
    const isAiOnly = aiEnabled && settings.aiSearchMode === 'ai-only';
    $container.find('#dle-sp-scan-depth').closest('.flex-container').toggle(!isAiOnly);
    $container.find('#dle-sp-optimize-keys-mode').closest('.flex-container').toggleClass('dle-disabled', isAiOnly);
    $container.find('#dle-sp-ai-claude-prefix').closest('.checkbox_label').toggle(aiEnabled && isProxy);
    // Blur/overlay AI tab content when AI search is off
    const $aiPanel = $container.find('#dle-sp-ai');
    $container.find('#dle-sp-ai-disabled-notice').toggle(!aiEnabled);
    $aiPanel.find('.dle-ai-content-wrap').toggleClass('dle-blurred', !aiEnabled);
    $aiPanel.find('.dle-ai-content-wrap input, .dle-ai-content-wrap select, .dle-ai-content-wrap textarea, .dle-ai-content-wrap .menu_button').prop('disabled', !aiEnabled);
    // Source Tracking + Decay are always available (not AI-dependent)
    if (!aiEnabled) {
        $container.find('#dle-sp-show-sources, #dle-sp-decay-enabled').prop('disabled', false);
        $container.find('#dle-sp-decay-controls input').prop('disabled', !settings.decayEnabled);
    }
}

function updatePopupInjectionModeVisibility($container, settings) {
    const isPromptList = settings.injectionMode === 'prompt_list';
    // Toggle extension-mode controls vs PM name labels for all injection rows
    $container.find('.dle-injection-ext-controls').toggle(!isPromptList);
    $container.find('.dle-injection-pm-name').toggle(isPromptList);
    $container.find('#dle-sp-injection-pm-info').toggle(isPromptList);
    // Disable all injection controls when in PM mode
    $container.find('.dle-injection-ext-controls').find('input, select').prop('disabled', isPromptList);
}

function updatePopupIndexStats() {
    const statsEl = document.getElementById('dle-sp-index-stats');
    if (!statsEl) return;
    if (vaultIndex.length > 0) {
        const totalKeys = vaultIndex.reduce((sum, e) => sum + e.keys.length, 0);
        const constants = vaultIndex.filter(e => e.constant).length;
        const totalTokens = vaultIndex.reduce((sum, e) => sum + e.tokenEstimate, 0);
        statsEl.textContent = `${vaultIndex.length} entries (${totalKeys} keywords, ${constants} always-send, ~${totalTokens} total tokens)`;
    } else {
        statsEl.textContent = 'No index loaded.';
    }
}

/**
 * Open the settings popup with tabbed layout and live data binding.
 */
export async function openSettingsPopup() {
    const html = await renderExtensionTemplateAsync(
        'third-party/sillytavern-DeepLore-Enhanced',
        'settings-popup',
    );
    const $container = $(html);

    // Tab switching helper
    function switchSettingsTab($tab) {
        const tab = $tab.data('settings-tab');
        $container.find('.dle-settings-tab').removeClass('active')
            .attr('aria-selected', 'false').attr('tabindex', '-1');
        $tab.addClass('active').attr('aria-selected', 'true').attr('tabindex', '0');
        $container.find('.dle-settings-panel').removeClass('active').attr('hidden', '');
        $container.find(`[data-settings-panel="${tab}"]`).addClass('active').removeAttr('hidden');
        // Clear features subtab highlighting when leaving Features
        if (tab !== 'features') {
            $container.find('.dle-features-subtab').removeClass('active');
        }
        localStorage.setItem('dle-last-settings-tab', tab);
    }

    // Restore last viewed tab
    const lastTab = localStorage.getItem('dle-last-settings-tab');
    if (lastTab) {
        const $lastTab = $container.find(`.dle-settings-tab[data-settings-tab="${lastTab}"]`);
        if ($lastTab.length) switchSettingsTab($lastTab);
    }

    // ── Features sidebar expand/collapse + sub-tab switching ──────
    const $featuresTab = $container.find('#dle-sp-tab-features');
    const $featuresChildren = $container.find('.dle-features-children');

    // Features children are always visible — no collapse toggle
    $featuresChildren.removeAttr('hidden');
    $featuresTab.attr('aria-expanded', 'true');

    function switchFeaturesSubtab($subtab) {
        const subtab = $subtab.data('features-subtab');
        $container.find('.dle-features-subtab').removeClass('active');
        $subtab.addClass('active');
        $container.find('.dle-features-subpanel').removeClass('active').attr('hidden', '');
        $container.find(`[data-features-subpanel="${subtab}"]`).addClass('active').removeAttr('hidden');
        localStorage.setItem('dle-last-features-subtab', subtab);
        // Ensure features main panel is active
        if (!$featuresTab.hasClass('active')) {
            switchSettingsTab($featuresTab);
        }
    }

    // Main tab click handler — Features header is not clickable (sub-tabs handle it)
    $container.on('click', '.dle-settings-tab:not(.dle-settings-tab--header)', function () {
        switchSettingsTab($(this));
    });

    // Feature sub-tab click
    $container.on('click', '.dle-features-subtab', function () {
        switchFeaturesSubtab($(this));
    });

    // Keyboard navigation for main sidebar tabs (skip non-interactive Features header)
    $container.on('keydown', '.dle-settings-tab:not(.dle-settings-tab--header)', function (e) {
        const $tabs = $container.find('.dle-settings-tab:not(.dle-settings-tab--header)');
        const idx = $tabs.index(this);
        let newIdx = idx;
        switch (e.key) {
            case 'ArrowDown': newIdx = (idx + 1) % $tabs.length; break;
            case 'ArrowUp': newIdx = (idx - 1 + $tabs.length) % $tabs.length; break;
            case 'Home': newIdx = 0; break;
            case 'End': newIdx = $tabs.length - 1; break;
            default: return;
        }
        e.preventDefault();
        const $newTab = $tabs.eq(newIdx);
        switchSettingsTab($newTab);
        $newTab.trigger('focus');
    });

    // Keyboard navigation for feature sub-tabs (Up/Down in sidebar)
    $container.on('keydown', '.dle-features-subtab', function (e) {
        const $subtabs = $container.find('.dle-features-subtab');
        const idx = $subtabs.index(this);
        let newIdx = idx;
        switch (e.key) {
            case 'ArrowDown': newIdx = (idx + 1) % $subtabs.length; break;
            case 'ArrowUp': newIdx = (idx - 1 + $subtabs.length) % $subtabs.length; break;
            case 'Home': newIdx = 0; break;
            case 'End': newIdx = $subtabs.length - 1; break;
            default: return;
        }
        e.preventDefault();
        const $newSubtab = $subtabs.eq(newIdx);
        switchFeaturesSubtab($newSubtab);
        $newSubtab.trigger('focus');
    });

    $container.find('.dle-settings-tab').attr('tabindex', '-1');
    $container.find('.dle-settings-tab.active').attr('tabindex', '0');
    $container.find('.dle-settings-panel').not('.active').attr('hidden', '');
    $container.find('.dle-features-subpanel').not('.active').attr('hidden', '');

    // Restore last viewed features sub-tab on init
    const lastSubtab = localStorage.getItem('dle-last-features-subtab');
    if (lastSubtab && lastTab === 'features') {
        const $lastSubtab = $container.find(`.dle-features-subtab[data-features-subtab="${lastSubtab}"]`);
        if ($lastSubtab.length) switchFeaturesSubtab($lastSubtab);
    }

    // "Go to Matching tab" link in AI disabled notice
    $container.on('click', '#dle-sp-goto-matching', function (e) {
        e.preventDefault();
        const $matchingTab = $container.find('[data-settings-tab="matching"]');
        switchSettingsTab($matchingTab);
        const $modeSelect = $container.find('#dle-sp-search-mode');
        $modeSelect.addClass('dle-pulse');
        setTimeout(() => $modeSelect.removeClass('dle-pulse'), 2000);
    });

    // Keyboard support for all role="button" elements (Enter/Space fires click)
    $container.on('keydown', '[role="button"][tabindex="0"]', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            $(this).trigger('click');
        }
    });

    // Advanced section toggles
    $container.on('click', '.dle-advanced-toggle', function () {
        const section = $(this).data('section');
        const $section = $container.find(`.dle-advanced-section[data-section="${section}"]`);
        const isOpen = $section.is(':visible');
        $section.slideToggle(200);
        $(this).attr('aria-expanded', String(!isOpen));
        $(this).find('.dle-advanced-icon')
            .toggleClass('fa-chevron-right', isOpen)
            .toggleClass('fa-chevron-down', !isOpen);
        const s = getSettings();
        if (!s.advancedVisible) s.advancedVisible = {};
        s.advancedVisible[section] = !isOpen;
        saveSettingsDebounced();
    });

    loadPopupSettings($container);
    bindPopupEvents($container);

    await callGenericPopup($container, POPUP_TYPE.DISPLAY, '', {
        large: true,
        wide: true,
        allowVerticalScrolling: true,
        onOpen: () => {
            updatePopupIndexStats();
            // Click-outside-to-dismiss: clicking the ::backdrop area of the <dialog>
            // fires a click on the dialog element itself with target === dialog.
            const dlg = $container[0]?.closest('dialog');
            if (dlg) {
                dlg.addEventListener('click', (e) => {
                    if (e.target === dlg) {
                        saveSettingsDebounced();
                        dlg.querySelector('.popup-button-close')?.click();
                    }
                });
            }
        },
    });
}

// ============================================================================
// Popup: Load Settings
// ============================================================================

function loadPopupSettings($container) {
    const settings = getSettings();
    const $c = (sel) => $container.find(sel);

    // ── Connection ──
    $c('#dle-sp-enabled').prop('checked', settings.enabled);
    renderVaultList(settings, $c('#dle-sp-vault-list')[0]);
    $c('#dle-sp-multi-vault-conflict').val(settings.multiVaultConflictResolution);
    $c('#dle-sp-field-definitions-path').val(settings.fieldDefinitionsPath || 'DeepLore/field-definitions.yaml');
    $c('#dle-sp-tag').val(settings.lorebookTag);
    $c('#dle-sp-constant-tag').val(settings.constantTag);
    $c('#dle-sp-never-insert-tag').val(settings.neverInsertTag);
    $c('#dle-sp-seed-tag').val(settings.seedTag);
    $c('#dle-sp-bootstrap-tag').val(settings.bootstrapTag);
    $c('#dle-sp-new-chat-threshold').val(settings.newChatThreshold);

    // ── Matching ──
    const searchMode = !settings.aiSearchEnabled ? 'keyword-only'
        : (settings.aiSearchMode === 'ai-only' ? 'ai-only' : 'two-stage');
    $c('#dle-sp-search-mode').val(searchMode);
    $c('#dle-sp-scan-depth').val(settings.scanDepth);
    $c('#dle-sp-char-context-scan').prop('checked', settings.characterContextScan);
    $c('#dle-sp-fuzzy-search').prop('checked', settings.fuzzySearchEnabled);
    $c('#dle-sp-fuzzy-min-score').val(settings.fuzzySearchMinScore);
    $c('#dle-sp-fuzzy-min-score-value').text((settings.fuzzySearchMinScore || 0.5).toFixed(1));
    $c('#dle-sp-fuzzy-min-score-row').toggle(settings.fuzzySearchEnabled);
    if (settings.fuzzySearchEnabled) runFuzzyPreview();
    $c('#dle-sp-unlimited-entries').prop('checked', settings.unlimitedEntries);
    $c('#dle-sp-max-entries').val(settings.maxEntries).prop('disabled', settings.unlimitedEntries);
    $c('#dle-sp-unlimited-budget').prop('checked', settings.unlimitedBudget);
    $c('#dle-sp-token-budget').val(settings.maxTokensBudget).prop('disabled', settings.unlimitedBudget);
    $c('#dle-sp-optimize-keys-mode').val(settings.optimizeKeysMode);
    $c('#dle-sp-case-sensitive').prop('checked', settings.caseSensitive);
    $c('#dle-sp-match-whole-words').prop('checked', settings.matchWholeWords);
    $c('#dle-sp-recursive-scan').prop('checked', settings.recursiveScan);
    $c('#dle-sp-max-recursion').val(settings.maxRecursionSteps).prop('disabled', !settings.recursiveScan);
    $c('#dle-sp-reinjection-cooldown').val(settings.reinjectionCooldown);
    $c('#dle-sp-strip-dedup').prop('checked', settings.stripDuplicateInjections);
    $c('#dle-sp-strip-lookback').val(settings.stripLookbackDepth).prop('disabled', !settings.stripDuplicateInjections);
    $c('#dle-sp-keyword-occurrence-weighting').prop('checked', settings.keywordOccurrenceWeighting);
    $c('#dle-sp-contextual-gating-tolerance').val(settings.contextualGatingTolerance);

    // ── Injection tab ──
    $c(`input[name="dle-sp-injection-mode"][value="${settings.injectionMode || 'extension'}"]`).prop('checked', true);
    updatePopupInjectionModeVisibility($container, settings);
    // Lore position (now a select dropdown)
    $c('#dle-sp-position').val(String(settings.injectionPosition));
    $c('#dle-sp-depth').val(settings.injectionDepth);
    $c('#dle-sp-role').val(settings.injectionRole);
    $c('#dle-sp-position').closest('.dle-injection-row').find('.dle-injection-inchat-controls').toggle(settings.injectionPosition === 1);
    // Author Notebook position (now a select dropdown)
    $c('#dle-sp-notebook-position').val(String(settings.notebookPosition));
    $c('#dle-sp-notebook-depth').val(settings.notebookDepth);
    $c('#dle-sp-notebook-role').val(settings.notebookRole);
    $c('#dle-sp-notebook-position').closest('.dle-injection-row').find('.dle-injection-inchat-controls').toggle(settings.notebookPosition === 1);
    // AI Notebook position (now a select dropdown)
    $c('#dle-sp-ai-notepad-position').val(String(settings.aiNotepadPosition));
    $c('#dle-sp-ai-notepad-depth').val(settings.aiNotepadDepth);
    $c('#dle-sp-ai-notepad-role').val(settings.aiNotepadRole);
    $c('#dle-sp-ai-notepad-position').closest('.dle-injection-row').find('.dle-injection-inchat-controls').toggle(settings.aiNotepadPosition === 1);
    // Advanced injection settings
    $c('#dle-sp-template').val(settings.injectionTemplate);
    $c('#dle-sp-allow-wi-scan').prop('checked', settings.allowWIScan);

    // ── AI Search ──
    $c(`input[name="dle-sp-ai-connection-mode"][value="${settings.aiSearchConnectionMode}"]`).prop('checked', true);
    populateProfileDropdownIn($container, 'dle-sp-ai-profile-select', 'aiSearchProfileId');
    updateConnectionVisibilityIn($container, {
        modeSettingsKey: 'aiSearchConnectionMode',
        profileRowSelector: '#dle-sp-ai-profile-row',
        proxyRowSelector: '#dle-sp-ai-proxy-row',
        modelInputSelector: '#dle-sp-ai-model',
        profileIdSettingsKey: 'aiSearchProfileId',
    });
    $c('#dle-sp-ai-proxy-url').val(settings.aiSearchProxyUrl);
    $c('#dle-sp-ai-model').val(settings.aiSearchModel);
    $c('#dle-sp-ai-max-tokens').val(settings.aiSearchMaxTokens);
    $c('#dle-sp-ai-timeout').val(settings.aiSearchTimeout);
    $c('#dle-sp-ai-scan-depth').val(settings.aiSearchScanDepth);
    $c('#dle-sp-ai-system-prompt').val(settings.aiSearchSystemPrompt);
    $c('#dle-sp-ai-summary-length').val(settings.aiSearchManifestSummaryLength);
    $c('#dle-sp-ai-claude-prefix').prop('checked', settings.aiSearchClaudeCodePrefix);
    $c('#dle-sp-scribe-informed-retrieval').prop('checked', settings.scribeInformedRetrieval);
    $c('#dle-sp-ai-confidence-threshold').val(settings.aiConfidenceThreshold);
    $c('#dle-sp-hierarchical-aggressiveness').val(settings.hierarchicalAggressiveness);
    $c('#dle-sp-hierarchical-value').text(settings.hierarchicalAggressiveness);
    $c('#dle-sp-manifest-summary-mode').val(settings.manifestSummaryMode);
    $c('#dle-sp-ai-error-fallback').val(settings.aiErrorFallback);
    $c('#dle-sp-ai-empty-fallback').val(settings.aiEmptyFallback);
    $c('#dle-sp-show-sources').prop('checked', settings.showLoreSources);
    $c('#dle-sp-decay-enabled').prop('checked', settings.decayEnabled);
    $c('#dle-sp-decay-boost-threshold').val(settings.decayBoostThreshold);
    $c('#dle-sp-decay-penalty-threshold').val(settings.decayPenaltyThreshold);
    $c('#dle-sp-decay-controls').toggleClass('dle-dimmed', !settings.decayEnabled);
    $c('#dle-sp-decay-controls input').prop('disabled', !settings.decayEnabled);

    // ── Features — Graph ──
    $c('#dle-sp-graph-color-mode').val(settings.graphDefaultColorMode);
    $c('#dle-sp-graph-hover-dim-distance').val(settings.graphHoverDimDistance);
    $c('#dle-sp-graph-focus-tree-depth').val(settings.graphFocusTreeDepth);
    $c('#dle-sp-graph-show-labels').prop('checked', settings.graphShowLabels);
    $c('#dle-sp-graph-repulsion').val(settings.graphRepulsion);
    $c('#dle-sp-graph-spring-length').val(settings.graphSpringLength);
    $c('#dle-sp-graph-gravity').val(settings.graphGravity);
    $c('#dle-sp-graph-damping').val(settings.graphDamping);
    $c('#dle-sp-graph-hover-dim-opacity').val(settings.graphHoverDimOpacity);
    $c('#dle-sp-graph-edge-filter-alpha').val(settings.graphEdgeFilterAlpha);

    // ── Features — Notebook ──
    $c('#dle-sp-notebook-enabled').prop('checked', settings.notebookEnabled);

    // ── Features — AI Notebook ──
    $c('#dle-sp-ai-notepad-enabled').prop('checked', settings.aiNotepadEnabled);
    const aiNbMode = settings.aiNotepadMode || 'tag';
    $c(`input[name="dle-sp-ai-notepad-mode"][value="${aiNbMode}"]`).prop('checked', true);
    $c('#dle-sp-ai-notepad-prompt').val(settings.aiNotepadPrompt || '');
    $c('#dle-sp-ai-notepad-extract-prompt').val(settings.aiNotepadExtractPrompt || '');
    // Extract mode connection settings
    $c(`input[name="dle-sp-ai-notepad-connection-mode"][value="${settings.aiNotepadConnectionMode || 'profile'}"]`).prop('checked', true);
    populateProfileDropdownIn($container, 'dle-sp-ai-notepad-profile-select', 'aiNotepadProfileId');
    $c('#dle-sp-ai-notepad-proxy-url').val(settings.aiNotepadProxyUrl || '');
    $c('#dle-sp-ai-notepad-model').val(settings.aiNotepadModel || '');
    $c('#dle-sp-ai-notepad-max-tokens').val(settings.aiNotepadMaxTokens || 1024);
    $c('#dle-sp-ai-notepad-timeout').val(settings.aiNotepadTimeout || 30000);
    updateConnectionVisibilityIn($container, { modeSettingsKey: 'aiNotepadConnectionMode', profileRowSelector: '#dle-sp-ai-notepad-profile-row', proxyRowSelector: '#dle-sp-ai-notepad-proxy-row', modelInputSelector: '#dle-sp-ai-notepad-model', profileIdSettingsKey: 'aiNotepadProfileId', externalOnlySelectors: ['#dle-sp-ai-notepad-model-row'] });
    // Show/hide mode-specific options
    $c('#dle-sp-ai-notepad-mode-tag-desc').toggle(aiNbMode === 'tag');
    $c('#dle-sp-ai-notepad-mode-extract-desc').toggle(aiNbMode === 'extract');
    $c('#dle-sp-ai-notepad-tag-options').toggle(aiNbMode === 'tag');
    $c('#dle-sp-ai-notepad-extract-options').toggle(aiNbMode === 'extract');

    // ── Features — Scribe ──
    $c('#dle-sp-scribe-enabled').prop('checked', settings.scribeEnabled);
    $c('#dle-sp-scribe-controls').find('input, textarea, select').prop('disabled', !settings.scribeEnabled);
    $c('#dle-sp-scribe-controls').find('.menu_button').toggleClass('disabled', !settings.scribeEnabled);
    $c('#dle-sp-scribe-interval').val(settings.scribeInterval);
    $c('#dle-sp-scribe-folder').val(settings.scribeFolder);
    $c(`input[name="dle-sp-scribe-connection-mode"][value="${settings.scribeConnectionMode}"]`).prop('checked', true);
    populateProfileDropdownIn($container, 'dle-sp-scribe-profile-select', 'scribeProfileId');
    updateConnectionVisibilityIn($container, {
        modeSettingsKey: 'scribeConnectionMode',
        profileRowSelector: '#dle-sp-scribe-profile-row',
        proxyRowSelector: '#dle-sp-scribe-proxy-row',
        modelInputSelector: '#dle-sp-scribe-model',
        profileIdSettingsKey: 'scribeProfileId',
        externalOnlySelectors: ['#dle-sp-scribe-model-row'],
        hasStMode: true,
    });
    $c('#dle-sp-scribe-proxy-url').val(settings.scribeProxyUrl);
    $c('#dle-sp-scribe-model').val(settings.scribeModel);
    $c('#dle-sp-scribe-max-tokens').val(settings.scribeMaxTokens);
    $c('#dle-sp-scribe-timeout').val(settings.scribeTimeout);
    $c('#dle-sp-scribe-scan-depth').val(settings.scribeScanDepth);
    $c('#dle-sp-scribe-prompt').val(settings.scribePrompt);

    // ── Features — Auto Lorebook ──
    $c('#dle-sp-autosuggest-enabled').prop('checked', settings.autoSuggestEnabled);
    $c('#dle-sp-autosuggest-controls').find('input, select').prop('disabled', !settings.autoSuggestEnabled);
    $c('#dle-sp-autosuggest-interval').val(settings.autoSuggestInterval);
    $c('#dle-sp-autosuggest-folder').val(settings.autoSuggestFolder);
    $c(`input[name="dle-sp-autosuggest-connection-mode"][value="${settings.autoSuggestConnectionMode}"]`).prop('checked', true);
    populateProfileDropdownIn($container, 'dle-sp-autosuggest-profile', 'autoSuggestProfileId');
    updateConnectionVisibilityIn($container, {
        modeSettingsKey: 'autoSuggestConnectionMode',
        profileRowSelector: '#dle-sp-autosuggest-profile-container',
        proxyRowSelector: '#dle-sp-autosuggest-proxy-container',
    });
    $c('#dle-sp-autosuggest-proxy-url').val(settings.autoSuggestProxyUrl);
    $c('#dle-sp-autosuggest-model').val(settings.autoSuggestModel);
    $c('#dle-sp-autosuggest-max-tokens').val(settings.autoSuggestMaxTokens);
    $c('#dle-sp-autosuggest-timeout').val(settings.autoSuggestTimeout);

    // ── System ── (index stats updated in onOpen, after DOM is live)
    $c('#dle-sp-cache-ttl').val(settings.cacheTTL);
    $c('#dle-sp-sync-interval').val(settings.syncPollingInterval);
    $c('#dle-sp-index-rebuild-trigger').val(settings.indexRebuildTrigger);
    $c('#dle-sp-rebuild-gen-interval').val(settings.indexRebuildGenerationInterval);
    // Show/hide rebuild trigger descriptions
    const showTrigger = (t) => {
        $c('#dle-sp-rebuild-trigger-ttl-desc').toggle(t === 'ttl');
        $c('#dle-sp-rebuild-trigger-gen-desc').toggle(t === 'generation');
        $c('#dle-sp-rebuild-trigger-manual-desc').toggle(t === 'manual');
        $c('#dle-sp-rebuild-gen-interval-row').toggle(t === 'generation');
    };
    showTrigger(settings.indexRebuildTrigger);
    $c('#dle-sp-show-sync-toasts').prop('checked', settings.showSyncToasts);
    $c('#dle-sp-review-tokens').val(settings.reviewResponseTokens);
    $c('#dle-sp-debug').prop('checked', settings.debugMode);

    // Migrate renamed data-section keys (D4 consistency fix)
    if (settings.advancedVisible) {
        const renames = { sp_vaultTags: 'sp_vault_tags', sp_aiSearch: 'sp_ai_search' };
        for (const [old, nw] of Object.entries(renames)) {
            if (old in settings.advancedVisible) {
                settings.advancedVisible[nw] = settings.advancedVisible[old];
                delete settings.advancedVisible[old];
            }
        }
    }

    // Restore advanced toggles
    const advVisible = settings.advancedVisible || {};
    $container.find('.dle-advanced-section').each(function () {
        const section = jQuery(this).data('section');
        if (advVisible[section]) {
            jQuery(this).show();
            jQuery(this).prev('.dle-advanced-toggle')
                .find('.dle-advanced-icon').removeClass('fa-chevron-right').addClass('fa-chevron-down');
            jQuery(this).prev('.dle-advanced-toggle').attr('aria-expanded', 'true');
        }
    });

    updatePopupModeVisibility($container, settings);
}

// ============================================================================
// Popup: Bind Events
// ============================================================================

/** Parse a numeric input value, returning fallback only when the value is truly non-numeric (not when it's 0). */
function numVal(raw, fallback) {
    const n = Number(raw);
    return Number.isNaN(n) ? fallback : n;
}

/**
 * Pure toy demo for the fuzzy strictness slider — no vault connection needed.
 * Uses real BM25 scoring (same k1/b/tokenizer as bm25.js) against a hardcoded
 * mini-corpus so users can see how the threshold controls which entries pass.
 * Also shows which specific words matched, so the user understands the mechanism.
 */
const FUZZY_TOY_CORPUS = [
    { title: 'Velmira the Blade',    content: 'A retired assassin who once served the shadow court. Now sells guild secrets to the highest bidder from a hidden safehouse.' },
    { title: 'The Hollow Fang',      content: 'A secretive assassin guild operating from the sewers beneath the capital. Members use shadow magic to vanish after completing a contract.' },
    { title: 'Nightveil District',   content: 'The shadow quarter of the capital where thieves and smugglers gather. Home to several guild halls and black market dealers.' },
    { title: 'Merchant Guild Prices', content: 'The official guild price list for trade across the realm. Establishes taxation and merchant protections for all five kingdoms.' },
    { title: 'Sunforge Cathedral',   content: 'A grand cathedral of golden spires dedicated to the sun goddess. Priests perform healing rituals. A shadow falls across the altar each equinox.' },
    { title: 'Starfall Academy',     content: 'A prestigious school for young mages perched on a cliffside. Students study elemental magic and arcane theory in ancient towers.' },
];
const FUZZY_TOY_QUERY = 'shadow assassin guild';
let _fuzzyToyScores = null;

/** Compute BM25 scores + matched words for the toy corpus once, reuse on slider changes. */
function getFuzzyToyScores() {
    if (_fuzzyToyScores) return _fuzzyToyScores;
    const k1 = 1.5, b = 0.75;
    const tokenize = t => t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 2);
    const docs = FUZZY_TOY_CORPUS.map(e => {
        const tokens = tokenize(`${e.title} ${e.content}`);
        const tf = new Map();
        for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
        return { title: e.title, tf, len: tokens.length };
    });
    const N = docs.length;
    const avgDl = docs.reduce((s, d) => s + d.len, 0) / N;
    const df = new Map();
    for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    const idf = new Map();
    for (const [t, f] of df) idf.set(t, Math.log((N - f + 0.5) / (f + 0.5) + 1));
    const queryTerms = new Set(tokenize(FUZZY_TOY_QUERY));
    _fuzzyToyScores = docs.map(d => {
        let score = 0;
        const matchedWords = [];
        for (const term of queryTerms) {
            const termIdf = idf.get(term);
            if (!termIdf) continue;
            const tf = d.tf.get(term) || 0;
            if (tf === 0) continue;
            score += termIdf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * d.len / avgDl));
            matchedWords.push(term);
        }
        return { title: d.title, score, matchedWords };
    }).sort((a, b) => b.score - a.score);
    return _fuzzyToyScores;
}

function runFuzzyPreview() {
    const $results = $('#dle-sp-fuzzy-preview-results');
    if (!$results.length) return;

    const minScore = getSettings().fuzzySearchMinScore || 0.5;
    const scores = getFuzzyToyScores();

    let html = '<div style="margin-bottom:4px;">';
    html += '<span class="dle-text-xs"><i class="fa-solid fa-flask" style="color:var(--dle-info,#2196f3);"></i> <strong>How this works</strong>';
    html += ' <span class="dle-muted">— sample data, not your vault</span></span></div>';
    html += `<div style="margin-bottom:6px;"><span class="dle-text-xs dle-muted">If a chat message said </span><span class="dle-text-xs"><strong>"${FUZZY_TOY_QUERY}"</strong></span><span class="dle-text-xs dle-muted">, these entries would be checked:</span></div>`;

    html += '<table style="width:100%;border-collapse:collapse;">';
    html += '<tr style="border-bottom:1px solid var(--dle-border,#444);"><th style="text-align:left;padding:2px 4px;"><span class="dle-text-xs">Entry</span></th><th style="text-align:left;padding:2px 4px;"><span class="dle-text-xs">Words matched</span></th><th style="text-align:right;padding:2px 4px;"><span class="dle-text-xs">Score</span></th><th style="text-align:center;padding:2px 4px;"></th></tr>';
    for (const e of scores) {
        const passes = e.score >= minScore;
        const icon = passes ? '✓' : '✗';
        const iconColor = passes ? 'var(--dle-success,#4caf50)' : 'var(--dle-error,#f44336)';
        const wordsHtml = e.matchedWords.length > 0
            ? e.matchedWords.map(w => `<span style="color:var(--dle-info,#2196f3);">${escapeHtml(w)}</span>`).join(', ')
            : '<span class="dle-muted">—</span>';
        html += `<tr style="opacity:${passes ? 1 : 0.5};">`;
        html += `<td style="padding:2px 4px;"><span class="dle-text-xs">${escapeHtml(e.title)}</span></td>`;
        html += `<td style="padding:2px 4px;"><span class="dle-text-xs">${wordsHtml}</span></td>`;
        html += `<td style="text-align:right;padding:2px 4px;"><span class="dle-text-xs dle-muted">${e.score.toFixed(2)}</span></td>`;
        html += `<td style="text-align:center;padding:2px 4px;color:${iconColor};font-weight:bold;"><span class="dle-text-xs">${icon}</span></td>`;
        html += '</tr>';
    }
    html += '</table>';
    $results.html(html);
}

function bindPopupEvents($container) {
    const settings = getSettings();
    const $c = (sel) => $container.find(sel);

    // Debounced index rebuild for tag inputs — avoids rebuilding on every keystroke
    let _rebuildTimer = null;
    const debouncedRebuild = () => { clearTimeout(_rebuildTimer); _rebuildTimer = setTimeout(() => buildIndexWithReuse(), 500); };

    $container.on('change input', 'input, select, textarea', () => invalidateSettingsCache());

    // ── Connection ──
    $c('#dle-sp-enabled').on('change', function () {
        settings.enabled = $(this).prop('checked');
        saveSettingsDebounced();
        setupSyncPolling(buildIndexWithReuse, buildIndexWithReuse);
        $('#dle-enabled').prop('checked', settings.enabled);
    });

    bindVaultListEvents(settings, $c('#dle-sp-vault-list'), $c('#dle-sp-add-vault'));
    $c('#dle-sp-multi-vault-conflict').on('change', function () { settings.multiVaultConflictResolution = String($(this).val()); saveSettingsDebounced(); });
    $c('#dle-sp-field-definitions-path').on('change', function () { settings.fieldDefinitionsPath = String($(this).val()).trim() || 'DeepLore/field-definitions.yaml'; saveSettingsDebounced(); });
    $c('#dle-sp-edit-fields-btn').on('click', async () => {
        const { openRuleBuilder } = await import('./rule-builder.js');
        openRuleBuilder();
    });

    $c('#dle-sp-test-connection').on('click', async function () {
        const $btn = $(this);
        if ($btn.prop('disabled')) return;
        $btn.prop('disabled', true).addClass('disabled');
        const statusEl = $c('#dle-sp-connection-status');
        statusEl.text('Testing...').removeClass('success failure');
        try {
            const enabledVaults = (settings.vaults || []).filter(v => v.enabled);
            if (enabledVaults.length === 0) throw new Error('No enabled vaults configured.');
            const results = [];
            for (const vault of enabledVaults) {
                try {
                    const data = await testConnection(vault.host, vault.port, vault.apiKey);
                    results.push({ name: vault.name, ok: data.ok, auth: data.authenticated, error: data.error });
                } catch (err) { results.push({ name: vault.name, ok: false, error: err.message }); }
            }
            const allOk = results.every(r => r.ok);
            const summary = results.map(r => `${r.name}: ${r.ok ? (r.auth ? 'OK' : 'OK (no auth)') : 'FAIL'}`).join(', ');
            statusEl.text(summary).toggleClass('success', allOk).toggleClass('failure', !allOk);
        } catch (err) { statusEl.text(`Error: ${err.message}`).addClass('failure').removeClass('success'); }
        finally { $btn.prop('disabled', false).removeClass('disabled'); }
    });

    $c('#dle-sp-tag').on('input', function () { settings.lorebookTag = String($(this).val()).trim() || 'lorebook'; saveSettingsDebounced(); debouncedRebuild(); });
    $c('#dle-sp-constant-tag').on('input', function () { settings.constantTag = String($(this).val()).trim() || 'lorebook-always'; saveSettingsDebounced(); debouncedRebuild(); });
    $c('#dle-sp-never-insert-tag').on('input', function () { settings.neverInsertTag = String($(this).val()).trim() || 'lorebook-never'; saveSettingsDebounced(); debouncedRebuild(); });
    $c('#dle-sp-seed-tag').on('input', function () { settings.seedTag = String($(this).val()).trim() || 'lorebook-seed'; saveSettingsDebounced(); debouncedRebuild(); });
    $c('#dle-sp-bootstrap-tag').on('input', function () { settings.bootstrapTag = String($(this).val()).trim() || 'lorebook-bootstrap'; saveSettingsDebounced(); debouncedRebuild(); });
    $c('#dle-sp-new-chat-threshold').on('input', function () { settings.newChatThreshold = numVal($(this).val(), 3); saveSettingsDebounced(); });

    // ── Matching ──
    $c('#dle-sp-search-mode').on('change', function () { const mode = $(this).val(); settings.aiSearchEnabled = mode !== 'keyword-only'; settings.aiSearchMode = mode === 'ai-only' ? 'ai-only' : 'two-stage'; saveSettingsDebounced(); updatePopupModeVisibility($container, settings); });
    $c('#dle-sp-scan-depth').on('input', function () { settings.scanDepth = numVal($(this).val(), 4); saveSettingsDebounced(); });
    $c('#dle-sp-char-context-scan').on('change', function () { settings.characterContextScan = $(this).is(':checked'); saveSettingsDebounced(); });
    $c('#dle-sp-fuzzy-search').on('change', function () { settings.fuzzySearchEnabled = $(this).is(':checked'); $c('#dle-sp-fuzzy-min-score-row').toggle(settings.fuzzySearchEnabled); saveSettingsDebounced(); buildIndexWithReuse(); });
    $c('#dle-sp-fuzzy-min-score').on('input', function () {
        const v = parseFloat($(this).val());
        settings.fuzzySearchMinScore = v;
        $c('#dle-sp-fuzzy-min-score-value').text(v.toFixed(1));
        saveSettingsDebounced();
        runFuzzyPreview();
    });
    $c('#dle-sp-unlimited-entries').on('change', function () { settings.unlimitedEntries = $(this).prop('checked'); $c('#dle-sp-max-entries').prop('disabled', settings.unlimitedEntries); saveSettingsDebounced(); });
    $c('#dle-sp-max-entries').on('input', function () { settings.maxEntries = numVal($(this).val(), 10); saveSettingsDebounced(); });
    $c('#dle-sp-unlimited-budget').on('change', function () { settings.unlimitedBudget = $(this).prop('checked'); $c('#dle-sp-token-budget').prop('disabled', settings.unlimitedBudget); saveSettingsDebounced(); });
    $c('#dle-sp-token-budget').on('input', function () { settings.maxTokensBudget = numVal($(this).val(), 3072); saveSettingsDebounced(); });
    $c('#dle-sp-optimize-keys-mode').on('change', function () { settings.optimizeKeysMode = String($(this).val()); saveSettingsDebounced(); });
    $c('#dle-sp-case-sensitive').on('change', function () { settings.caseSensitive = $(this).prop('checked'); saveSettingsDebounced(); });
    $c('#dle-sp-match-whole-words').on('change', function () { settings.matchWholeWords = $(this).prop('checked'); saveSettingsDebounced(); });
    $c('#dle-sp-recursive-scan').on('change', function () { settings.recursiveScan = $(this).prop('checked'); $c('#dle-sp-max-recursion').prop('disabled', !settings.recursiveScan); saveSettingsDebounced(); });
    $c('#dle-sp-max-recursion').on('input', function () { settings.maxRecursionSteps = numVal($(this).val(), 3); saveSettingsDebounced(); });
    $c('#dle-sp-reinjection-cooldown').on('input', function () { settings.reinjectionCooldown = numVal($(this).val(), 0); saveSettingsDebounced(); });
    $c('#dle-sp-strip-dedup').on('change', function () { settings.stripDuplicateInjections = $(this).prop('checked'); $c('#dle-sp-strip-lookback').prop('disabled', !settings.stripDuplicateInjections); saveSettingsDebounced(); });
    $c('#dle-sp-strip-lookback').on('input', function () { settings.stripLookbackDepth = numVal($(this).val(), 2); saveSettingsDebounced(); });
    $c('#dle-sp-keyword-occurrence-weighting').on('change', function () { settings.keywordOccurrenceWeighting = $(this).prop('checked'); saveSettingsDebounced(); });
    $c('#dle-sp-contextual-gating-tolerance').on('change', function () { settings.contextualGatingTolerance = String($(this).val()); saveSettingsDebounced(); });

    // ── Injection tab ──
    $c('input[name="dle-sp-injection-mode"]').on('change', function () {
        const oldMode = settings.injectionMode;
        settings.injectionMode = String($(this).val());
        // H16: Clean up stale PM entries when switching away from prompt_list mode
        if (oldMode === 'prompt_list' && settings.injectionMode !== 'prompt_list' && promptManager) {
            for (const id of [`${PROMPT_TAG_PREFIX}constants`, `${PROMPT_TAG_PREFIX}lore`, 'deeplore_notebook', 'deeplore_ai_notepad']) {
                const pmEntry = promptManager.getPromptById(id);
                if (pmEntry) pmEntry.content = '';
            }
        }
        updatePopupInjectionModeVisibility($container, settings);
        saveSettingsDebounced();
    });

    // Helper: wire a position select + in-chat controls for an injection row
    function wirePositionSelect(selectId, depthId, roleId, posKey, depthKey, roleKey) {
        $c(selectId).on('change', function () {
            settings[posKey] = Number($(this).val());
            $(this).closest('.dle-injection-row').find('.dle-injection-inchat-controls').toggle(settings[posKey] === 1);
            saveSettingsDebounced();
        });
        $c(depthId).on('input', function () { settings[depthKey] = numVal($(this).val(), 4); saveSettingsDebounced(); });
        $c(roleId).on('change', function () { settings[roleKey] = numVal($(this).val(), 0); saveSettingsDebounced(); });
    }
    wirePositionSelect('#dle-sp-position', '#dle-sp-depth', '#dle-sp-role', 'injectionPosition', 'injectionDepth', 'injectionRole');
    wirePositionSelect('#dle-sp-notebook-position', '#dle-sp-notebook-depth', '#dle-sp-notebook-role', 'notebookPosition', 'notebookDepth', 'notebookRole');
    wirePositionSelect('#dle-sp-ai-notepad-position', '#dle-sp-ai-notepad-depth', '#dle-sp-ai-notepad-role', 'aiNotepadPosition', 'aiNotepadDepth', 'aiNotepadRole');

    $c('#dle-sp-template').on('input', function () { settings.injectionTemplate = String($(this).val()); saveSettingsDebounced(); });
    $c('#dle-sp-allow-wi-scan').on('change', function () { settings.allowWIScan = $(this).prop('checked'); saveSettingsDebounced(); });

    // Cross-tab links (e.g., "Injection tab" links in Features subtabs)
    $container.on('click', '.dle-goto-tab-link', function (e) {
        e.preventDefault();
        const targetTab = $(this).data('goto-tab');
        const $targetTab = $container.find(`[data-settings-tab="${targetTab}"]`);
        if ($targetTab.length) switchSettingsTab($targetTab);
    });

    // ── AI Search ──
    $c('input[name="dle-sp-ai-connection-mode"]').on('change', function () {
        settings.aiSearchConnectionMode = $c('input[name="dle-sp-ai-connection-mode"]:checked').val();
        saveSettingsDebounced();
        updateConnectionVisibilityIn($container, { modeSettingsKey: 'aiSearchConnectionMode', profileRowSelector: '#dle-sp-ai-profile-row', proxyRowSelector: '#dle-sp-ai-proxy-row', modelInputSelector: '#dle-sp-ai-model', profileIdSettingsKey: 'aiSearchProfileId' });
        updatePopupModeVisibility($container, settings);
    });
    $c('#dle-sp-ai-profile-select').on('change', function () { settings.aiSearchProfileId = String($(this).val()); saveSettingsDebounced(); });
    $c('#dle-sp-ai-proxy-url').on('input', function () { settings.aiSearchProxyUrl = String($(this).val()).trim() || 'http://localhost:42069'; saveSettingsDebounced(); });
    $c('#dle-sp-ai-model').on('input', function () { settings.aiSearchModel = String($(this).val()).trim(); saveSettingsDebounced(); });
    $c('#dle-sp-ai-max-tokens').on('input', function () { settings.aiSearchMaxTokens = numVal($(this).val(), 1024); saveSettingsDebounced(); });
    $c('#dle-sp-ai-timeout').on('input', function () { settings.aiSearchTimeout = numVal($(this).val(), 10000); saveSettingsDebounced(); });
    $c('#dle-sp-ai-scan-depth').on('input', function () { settings.aiSearchScanDepth = numVal($(this).val(), 4); saveSettingsDebounced(); });
    $c('#dle-sp-ai-system-prompt').on('input', function () { settings.aiSearchSystemPrompt = String($(this).val()); saveSettingsDebounced(); });
    $c('#dle-sp-ai-summary-length').on('input', function () { settings.aiSearchManifestSummaryLength = numVal($(this).val(), 600); saveSettingsDebounced(); });
    $c('#dle-sp-ai-claude-prefix').on('change', function () { settings.aiSearchClaudeCodePrefix = $(this).prop('checked'); saveSettingsDebounced(); });
    $c('#dle-sp-scribe-informed-retrieval').on('change', function () { settings.scribeInformedRetrieval = $(this).prop('checked'); saveSettingsDebounced(); });
    $c('#dle-sp-ai-confidence-threshold').on('change', function () { settings.aiConfidenceThreshold = String($(this).val()); saveSettingsDebounced(); });
    $c('#dle-sp-hierarchical-aggressiveness').on('input', function () { const v = parseFloat($(this).val()); settings.hierarchicalAggressiveness = v; $c('#dle-sp-hierarchical-value').text(v.toFixed(1)); saveSettingsDebounced(); });
    $c('#dle-sp-manifest-summary-mode').on('change', function () { settings.manifestSummaryMode = String($(this).val()); saveSettingsDebounced(); });
    $c('#dle-sp-ai-error-fallback').on('change', function () { settings.aiErrorFallback = String($(this).val()); saveSettingsDebounced(); });
    $c('#dle-sp-ai-empty-fallback').on('change', function () { settings.aiEmptyFallback = String($(this).val()); saveSettingsDebounced(); });
    $c('#dle-sp-show-sources').on('change', function () { settings.showLoreSources = $(this).prop('checked'); saveSettingsDebounced(); });
    $c('#dle-sp-decay-enabled').on('change', function () { settings.decayEnabled = $(this).prop('checked'); saveSettingsDebounced(); $c('#dle-sp-decay-controls').toggleClass('dle-dimmed', !settings.decayEnabled); $c('#dle-sp-decay-controls input').prop('disabled', !settings.decayEnabled); });
    $c('#dle-sp-decay-boost-threshold').on('input', function () { settings.decayBoostThreshold = numVal($(this).val(), 5); saveSettingsDebounced(); });
    $c('#dle-sp-decay-penalty-threshold').on('input', function () { settings.decayPenaltyThreshold = numVal($(this).val(), 2); saveSettingsDebounced(); });

    // ── Graph settings ──
    $c('#dle-sp-graph-color-mode').on('change', function () { settings.graphDefaultColorMode = String($(this).val()); saveSettingsDebounced(); });
    $c('#dle-sp-graph-hover-dim-distance').on('input', function () { settings.graphHoverDimDistance = numVal($(this).val(), 2); saveSettingsDebounced(); });
    $c('#dle-sp-graph-focus-tree-depth').on('input', function () { settings.graphFocusTreeDepth = numVal($(this).val(), 2); saveSettingsDebounced(); }); // BUG-L4: fallback matches default (2)
    $c('#dle-sp-graph-show-labels').on('change', function () { settings.graphShowLabels = $(this).prop('checked'); saveSettingsDebounced(); });
    $c('#dle-sp-graph-repulsion').on('input', function () { const v = parseFloat($(this).val()); settings.graphRepulsion = isNaN(v) ? 0.3 : v; saveSettingsDebounced(); });
    $c('#dle-sp-graph-spring-length').on('input', function () { settings.graphSpringLength = numVal($(this).val(), 80); saveSettingsDebounced(); });
    $c('#dle-sp-graph-gravity').on('input', function () { const v = parseFloat($(this).val()); settings.graphGravity = isNaN(v) ? 11.0 : v; saveSettingsDebounced(); });
    $c('#dle-sp-graph-damping').on('input', function () { const v = parseFloat($(this).val()); settings.graphDamping = isNaN(v) ? 0.50 : v; saveSettingsDebounced(); });
    // BUG-AUDIT-14: Use isNaN check instead of || fallback so 0 is a valid value
    $c('#dle-sp-graph-hover-dim-opacity').on('input', function () { const v = parseFloat($(this).val()); settings.graphHoverDimOpacity = isNaN(v) ? 0.1 : v; saveSettingsDebounced(); });
    $c('#dle-sp-graph-edge-filter-alpha').on('input', function () { settings.graphEdgeFilterAlpha = parseFloat($(this).val()) || 0.05; saveSettingsDebounced(); });

    // Test AI / Preview
    $c('#dle-sp-test-ai').on('click', async function () {
        const $btn = $(this);
        if ($btn.prop('disabled')) return;
        $btn.prop('disabled', true).addClass('disabled');
        const statusEl = $c('#dle-sp-ai-status');
        statusEl.text('Testing...').removeClass('success failure');
        try {
            if (settings.aiSearchConnectionMode === 'profile') {
                if (!settings.aiSearchProfileId) throw new Error('No connection profile selected');
                await callViaProfile('You are a test assistant. Respond with exactly: {"ok": true}', 'Test. Respond: {"ok": true}', 64, settings.aiSearchTimeout);
                const m = getProfileModelHint(); statusEl.text(`Connected${m ? ' (' + m + ')' : ''}`).addClass('success').removeClass('failure');
            } else {
                const data = await testProxyConnection(settings.aiSearchProxyUrl, settings.aiSearchModel || 'claude-haiku-4-5-20251001');
                statusEl.text(data.ok ? 'Connected' : `Failed: ${data.error}`).toggleClass('success', data.ok).toggleClass('failure', !data.ok);
            }
        } catch (err) { statusEl.text(`Error: ${err.message}`).addClass('failure').removeClass('success'); }
        finally { $btn.prop('disabled', false).removeClass('disabled'); }
    });

    $c('#dle-sp-preview-ai').on('click', async function () {
        if (!chat || chat.length === 0) { toastr.info('No active chat.', 'DeepLore Enhanced'); return; }
        await ensureIndexFresh();
        if (vaultIndex.length === 0) { toastr.info('No entries indexed.', 'DeepLore Enhanced'); return; }
        let candidateManifest, candidateHeader, modeLabel;
        if (settings.aiSearchMode === 'ai-only') { const r = buildCandidateManifest(vaultIndex); candidateManifest = r.manifest; candidateHeader = r.header; modeLabel = 'AI-only (full vault)'; }
        else { const kr = matchEntries(chat); const nc = kr.matched.filter(e => !e.constant); if (nc.length === 0) { toastr.warning('No entries matched the current chat. Try /dle-simulate for details.', 'DeepLore Enhanced'); return; } const r = buildCandidateManifest(kr.matched); candidateManifest = r.manifest; candidateHeader = r.header; modeLabel = `Two-stage (${nc.length} candidates)`; }
        const chatContext = buildAiChatContext(chat, settings.aiSearchScanDepth);
        const maxE = settings.unlimitedEntries ? 'as many as are relevant' : String(settings.maxEntries);
        let sp = (settings.aiSearchSystemPrompt && settings.aiSearchSystemPrompt.trim()) || DEFAULT_AI_SYSTEM_PROMPT;
        if (settings.aiSearchClaudeCodePrefix && settings.aiSearchConnectionMode === 'proxy' && !sp.startsWith('You are Claude Code')) sp = 'You are Claude Code. ' + sp;
        sp = sp.replace(/\{\{maxEntries\}\}/g, maxE);
        const hdr = candidateHeader ? `## Manifest Info\n${candidateHeader}\n\n` : '';
        const um = `${hdr}## Recent Chat\n${chatContext}\n\n## Candidate Lore Entries\n${candidateManifest}\n\nSelect the relevant entries as a JSON array.`;
        callGenericPopup(`<div class="dle-popup"><h3>Mode: ${escapeHtml(modeLabel)}</h3><h3>System Prompt</h3><div class="dle-preview dle-preview--short" style="margin-bottom:15px">${escapeHtml(sp)}</div><h3>User Message</h3><div class="dle-preview dle-preview--tall">${escapeHtml(um)}</div></div>`, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
    });

    // ── Features — Notebook ──
    $c('#dle-sp-notebook-enabled').on('change', function () {
        settings.notebookEnabled = $(this).prop('checked'); saveSettingsDebounced();
    });
    $c('#dle-sp-open-notebook').on('click', function () { if (!settings.notebookEnabled) { toastr.warning('Enable the Author Notebook checkbox above to use this feature.', 'DeepLore Enhanced'); return; } showNotebookPopup(); });

    // ── Features — AI Notebook ──
    $c('#dle-sp-ai-notepad-enabled').on('change', function () {
        settings.aiNotepadEnabled = $(this).prop('checked'); saveSettingsDebounced();
    });
    $c('#dle-sp-ai-notepad-prompt').on('input', function () { settings.aiNotepadPrompt = $(this).val(); saveSettingsDebounced(); });
    $c('#dle-sp-ai-notepad-extract-prompt').on('input', function () { settings.aiNotepadExtractPrompt = $(this).val(); saveSettingsDebounced(); });
    $c('input[name="dle-sp-ai-notepad-mode"]').on('change', function () {
        settings.aiNotepadMode = $(this).val(); saveSettingsDebounced();
        const isTag = settings.aiNotepadMode === 'tag';
        $c('#dle-sp-ai-notepad-mode-tag-desc').toggle(isTag);
        $c('#dle-sp-ai-notepad-mode-extract-desc').toggle(!isTag);
        $c('#dle-sp-ai-notepad-tag-options').toggle(isTag);
        $c('#dle-sp-ai-notepad-extract-options').toggle(!isTag);
    });
    // AI Notebook extract mode connection handlers
    $c('input[name="dle-sp-ai-notepad-connection-mode"]').on('change', function () {
        settings.aiNotepadConnectionMode = $(this).val(); saveSettingsDebounced();
        updateConnectionVisibilityIn($container, { modeSettingsKey: 'aiNotepadConnectionMode', profileRowSelector: '#dle-sp-ai-notepad-profile-row', proxyRowSelector: '#dle-sp-ai-notepad-proxy-row', modelInputSelector: '#dle-sp-ai-notepad-model', profileIdSettingsKey: 'aiNotepadProfileId', externalOnlySelectors: ['#dle-sp-ai-notepad-model-row'] });
    });
    $c('#dle-sp-ai-notepad-profile-select').on('change', function () { settings.aiNotepadProfileId = String($(this).val()); saveSettingsDebounced(); });
    $c('#dle-sp-ai-notepad-proxy-url').on('input', function () { settings.aiNotepadProxyUrl = String($(this).val()).trim() || 'http://localhost:42069'; saveSettingsDebounced(); });
    $c('#dle-sp-ai-notepad-model').on('input', function () { settings.aiNotepadModel = String($(this).val()).trim(); saveSettingsDebounced(); });
    $c('#dle-sp-ai-notepad-max-tokens').on('input', function () { settings.aiNotepadMaxTokens = numVal($(this).val(), 1024); saveSettingsDebounced(); });
    $c('#dle-sp-ai-notepad-timeout').on('input', function () { settings.aiNotepadTimeout = numVal($(this).val(), 30000); saveSettingsDebounced(); });
    $c('#dle-sp-open-ai-notepad').on('click', function () { if (!settings.aiNotepadEnabled) { toastr.warning('Enable the AI Notebook checkbox above to use this feature.', 'DeepLore Enhanced'); return; } showAiNotepadPopup(); });

    // ── Features — Scribe ──
    $c('#dle-sp-scribe-enabled').on('change', function () {
        settings.scribeEnabled = $(this).prop('checked'); saveSettingsDebounced();
        $c('#dle-sp-scribe-controls').find('input, textarea, select').prop('disabled', !settings.scribeEnabled);
        $c('#dle-sp-scribe-controls').find('.menu_button').toggleClass('disabled', !settings.scribeEnabled);
        if (settings.scribeEnabled) updateConnectionVisibilityIn($container, { modeSettingsKey: 'scribeConnectionMode', profileRowSelector: '#dle-sp-scribe-profile-row', proxyRowSelector: '#dle-sp-scribe-proxy-row', modelInputSelector: '#dle-sp-scribe-model', profileIdSettingsKey: 'scribeProfileId', externalOnlySelectors: ['#dle-sp-scribe-model-row'], hasStMode: true });
    });
    $c('#dle-sp-scribe-interval').on('input', function () { settings.scribeInterval = numVal($(this).val(), 5); saveSettingsDebounced(); });
    $c('#dle-sp-scribe-folder').on('input', function () { settings.scribeFolder = String($(this).val()).trim() || 'Sessions'; saveSettingsDebounced(); });
    $c('#dle-sp-scribe-prompt').on('input', function () { settings.scribePrompt = String($(this).val()); saveSettingsDebounced(); });
    $c('input[name="dle-sp-scribe-connection-mode"]').on('change', function () { settings.scribeConnectionMode = $c('input[name="dle-sp-scribe-connection-mode"]:checked').val(); saveSettingsDebounced(); updateConnectionVisibilityIn($container, { modeSettingsKey: 'scribeConnectionMode', profileRowSelector: '#dle-sp-scribe-profile-row', proxyRowSelector: '#dle-sp-scribe-proxy-row', modelInputSelector: '#dle-sp-scribe-model', profileIdSettingsKey: 'scribeProfileId', externalOnlySelectors: ['#dle-sp-scribe-model-row'], hasStMode: true }); });
    $c('#dle-sp-scribe-profile-select').on('change', function () { settings.scribeProfileId = String($(this).val()); saveSettingsDebounced(); });
    $c('#dle-sp-scribe-proxy-url').on('input', function () { settings.scribeProxyUrl = String($(this).val()).trim() || 'http://localhost:42069'; saveSettingsDebounced(); });
    $c('#dle-sp-scribe-model').on('input', function () { settings.scribeModel = String($(this).val()).trim(); saveSettingsDebounced(); });
    $c('#dle-sp-scribe-max-tokens').on('input', function () { settings.scribeMaxTokens = numVal($(this).val(), 1024); saveSettingsDebounced(); });
    $c('#dle-sp-scribe-timeout').on('input', function () { settings.scribeTimeout = numVal($(this).val(), 30000); saveSettingsDebounced(); });
    $c('#dle-sp-scribe-scan-depth').on('input', function () { settings.scribeScanDepth = numVal($(this).val(), 20); saveSettingsDebounced(); });

    // ── Features — Auto Lorebook ──
    $c('#dle-sp-autosuggest-enabled').on('change', function () {
        settings.autoSuggestEnabled = $(this).prop('checked'); saveSettingsDebounced();
        $c('#dle-sp-autosuggest-controls').find('input, select').prop('disabled', !settings.autoSuggestEnabled);
        if (settings.autoSuggestEnabled) updateConnectionVisibilityIn($container, { modeSettingsKey: 'autoSuggestConnectionMode', profileRowSelector: '#dle-sp-autosuggest-profile-container', proxyRowSelector: '#dle-sp-autosuggest-proxy-container' });
    });
    $c('#dle-sp-autosuggest-interval').on('input', function () { settings.autoSuggestInterval = numVal($(this).val(), 10); saveSettingsDebounced(); });
    $c('#dle-sp-autosuggest-folder').on('input', function () { settings.autoSuggestFolder = String($(this).val()).trim(); saveSettingsDebounced(); });
    $c('input[name="dle-sp-autosuggest-connection-mode"]').on('change', function () { settings.autoSuggestConnectionMode = $(this).val(); saveSettingsDebounced(); updateConnectionVisibilityIn($container, { modeSettingsKey: 'autoSuggestConnectionMode', profileRowSelector: '#dle-sp-autosuggest-profile-container', proxyRowSelector: '#dle-sp-autosuggest-proxy-container' }); });
    $c('#dle-sp-autosuggest-profile').on('change', function () { settings.autoSuggestProfileId = $(this).val(); saveSettingsDebounced(); });
    $c('#dle-sp-autosuggest-proxy-url').on('input', function () { settings.autoSuggestProxyUrl = String($(this).val()).trim(); saveSettingsDebounced(); });
    $c('#dle-sp-autosuggest-model').on('input', function () { settings.autoSuggestModel = String($(this).val()).trim(); saveSettingsDebounced(); });
    $c('#dle-sp-autosuggest-max-tokens').on('input', function () { settings.autoSuggestMaxTokens = numVal($(this).val(), 2048); saveSettingsDebounced(); });
    $c('#dle-sp-autosuggest-timeout').on('input', function () { settings.autoSuggestTimeout = numVal($(this).val(), 30000); saveSettingsDebounced(); });

    // Copy from AI Search buttons
    $container.on('click', '.dle-copy-ai-btn', function () {
        const target = $(this).data('copy-target');
        const mode = settings.aiSearchConnectionMode;

        // Helper: copy AI Search connection settings to a target subsystem
        const copyToTarget = (keys, uiUpdater) => {
            settings[keys.mode] = mode;
            settings[keys.profileId] = settings.aiSearchProfileId;
            settings[keys.proxyUrl] = settings.aiSearchProxyUrl;
            settings[keys.model] = settings.aiSearchModel;
            uiUpdater();
        };

        if (target === 'scribe') {
            copyToTarget(
                { mode: 'scribeConnectionMode', profileId: 'scribeProfileId', proxyUrl: 'scribeProxyUrl', model: 'scribeModel' },
                () => {
                    $c(`input[name="dle-sp-scribe-connection-mode"][value="${mode}"]`).prop('checked', true);
                    $c('#dle-sp-scribe-proxy-url').val(settings.scribeProxyUrl);
                    $c('#dle-sp-scribe-model').val(settings.scribeModel);
                    populateProfileDropdownIn($container, 'dle-sp-scribe-profile-select', 'scribeProfileId');
                    updateConnectionVisibilityIn($container, {
                        modeSettingsKey: 'scribeConnectionMode', profileRowSelector: '#dle-sp-scribe-profile-row',
                        proxyRowSelector: '#dle-sp-scribe-proxy-row', modelInputSelector: '#dle-sp-scribe-model',
                        profileIdSettingsKey: 'scribeProfileId', externalOnlySelectors: ['#dle-sp-scribe-model-row'], hasStMode: true,
                    });
                },
            );
        } else if (target === 'ai_notepad') {
            copyToTarget(
                { mode: 'aiNotepadConnectionMode', profileId: 'aiNotepadProfileId', proxyUrl: 'aiNotepadProxyUrl', model: 'aiNotepadModel' },
                () => {
                    $c(`input[name="dle-sp-ai-notepad-connection-mode"][value="${mode}"]`).prop('checked', true);
                    $c('#dle-sp-ai-notepad-proxy-url').val(settings.aiNotepadProxyUrl);
                    $c('#dle-sp-ai-notepad-model').val(settings.aiNotepadModel);
                    populateProfileDropdownIn($container, 'dle-sp-ai-notepad-profile-select', 'aiNotepadProfileId');
                    updateConnectionVisibilityIn($container, {
                        modeSettingsKey: 'aiNotepadConnectionMode', profileRowSelector: '#dle-sp-ai-notepad-profile-row',
                        proxyRowSelector: '#dle-sp-ai-notepad-proxy-row', modelInputSelector: '#dle-sp-ai-notepad-model',
                        profileIdSettingsKey: 'aiNotepadProfileId', externalOnlySelectors: ['#dle-sp-ai-notepad-model-row'],
                    });
                },
            );
        } else if (target === 'autosuggest') {
            copyToTarget(
                { mode: 'autoSuggestConnectionMode', profileId: 'autoSuggestProfileId', proxyUrl: 'autoSuggestProxyUrl', model: 'autoSuggestModel' },
                () => {
                    $c(`input[name="dle-sp-autosuggest-connection-mode"][value="${mode}"]`).prop('checked', true);
                    $c('#dle-sp-autosuggest-proxy-url').val(settings.autoSuggestProxyUrl);
                    $c('#dle-sp-autosuggest-model').val(settings.autoSuggestModel);
                    populateProfileDropdownIn($container, 'dle-sp-autosuggest-profile', 'autoSuggestProfileId');
                    updateConnectionVisibilityIn($container, {
                        modeSettingsKey: 'autoSuggestConnectionMode', profileRowSelector: '#dle-sp-autosuggest-profile-container',
                        proxyRowSelector: '#dle-sp-autosuggest-proxy-container',
                    });
                },
            );
        }

        invalidateSettingsCache();
        saveSettingsDebounced();
        toastr.success('Connection settings copied from AI Search.', 'DeepLore Enhanced');
    });

    // ── System ──
    $c('#dle-sp-refresh').on('click', async function () {
        const $btn = $(this), $icon = $btn.find('i');
        $btn.prop('disabled', true); $icon.removeClass('fa-rotate').addClass('fa-spinner fa-spin');
        try { setVaultIndex([]); setIndexTimestamp(0); await buildIndex(); toastr.success(`Indexed ${vaultIndex.length} entries.`, 'DeepLore Enhanced'); updatePopupIndexStats(); }
        catch (err) { toastr.error(String(err), 'DeepLore Enhanced'); }
        finally { $btn.prop('disabled', false); $icon.removeClass('fa-spinner fa-spin').addClass('fa-rotate'); }
    });
    $c('#dle-sp-browse-entries').on('click', () => showBrowsePopup());
    $c('#dle-sp-test-match').on('click', () => toastr.info('Use /dle-simulate in chat for a full match test.', 'DeepLore Enhanced'));
    $c('#dle-sp-cache-ttl').on('input', function () { settings.cacheTTL = numVal($(this).val(), 300); saveSettingsDebounced(); });
    $c('#dle-sp-sync-interval').on('input', function () { settings.syncPollingInterval = numVal($(this).val(), 0); saveSettingsDebounced(); setupSyncPolling(buildIndexWithReuse, buildIndexWithReuse); });
    $c('#dle-sp-index-rebuild-trigger').on('change', function () {
        settings.indexRebuildTrigger = String($(this).val());
        $c('#dle-sp-rebuild-trigger-ttl-desc').toggle(settings.indexRebuildTrigger === 'ttl');
        $c('#dle-sp-rebuild-trigger-gen-desc').toggle(settings.indexRebuildTrigger === 'generation');
        $c('#dle-sp-rebuild-trigger-manual-desc').toggle(settings.indexRebuildTrigger === 'manual');
        $c('#dle-sp-rebuild-gen-interval-row').toggle(settings.indexRebuildTrigger === 'generation');
        saveSettingsDebounced();
    });
    $c('#dle-sp-rebuild-gen-interval').on('input', function () { settings.indexRebuildGenerationInterval = numVal($(this).val(), 10); saveSettingsDebounced(); });
    $c('#dle-sp-show-sync-toasts').on('change', function () { settings.showSyncToasts = $(this).prop('checked'); saveSettingsDebounced(); });
    $c('#dle-sp-review-tokens').on('input', function () { settings.reviewResponseTokens = numVal($(this).val(), 0); saveSettingsDebounced(); });
    $c('#dle-sp-debug').on('change', function () { settings.debugMode = $(this).prop('checked'); saveSettingsDebounced(); });

    // ── Reset All Settings ──
    $c('#dle-sp-reset-defaults').on('click', async function () {
        const confirmed = await callGenericPopup(
            '<div style="text-align:center;"><p><strong>Reset all DeepLore Enhanced settings to defaults?</strong></p><p>This cannot be undone. Your vault connections and AI connection profiles will be preserved.</p></div>',
            POPUP_TYPE.CONFIRM, '', { okButton: 'Reset', cancelButton: 'Cancel' },
        );
        if (!confirmed) return;

        // Preserve all connection settings (vault + AI profiles/proxies)
        const savedVaults = JSON.parse(JSON.stringify(settings.vaults || []));
        const savedPort = settings.obsidianPort;
        const savedKey = settings.obsidianApiKey;
        const savedConnections = {
            aiSearchConnectionMode: settings.aiSearchConnectionMode,
            aiSearchProfileId: settings.aiSearchProfileId,
            aiSearchProxyUrl: settings.aiSearchProxyUrl,
            aiSearchModel: settings.aiSearchModel,
            scribeConnectionMode: settings.scribeConnectionMode,
            scribeProfileId: settings.scribeProfileId,
            scribeProxyUrl: settings.scribeProxyUrl,
            scribeModel: settings.scribeModel,
            autoSuggestConnectionMode: settings.autoSuggestConnectionMode,
            autoSuggestProfileId: settings.autoSuggestProfileId,
            autoSuggestProxyUrl: settings.autoSuggestProxyUrl,
            autoSuggestModel: settings.autoSuggestModel,
        };

        // Reset all settings to defaults
        for (const [key, value] of Object.entries(defaultSettings)) {
            settings[key] = (typeof value === 'object' && value !== null)
                ? JSON.parse(JSON.stringify(value))
                : value;
        }

        // Restore all connection settings
        settings.vaults = savedVaults;
        settings.obsidianPort = savedPort;
        settings.obsidianApiKey = savedKey;
        settings._vaultsMigrated = true;
        Object.assign(settings, savedConnections);

        invalidateSettingsCache();
        saveSettingsDebounced();

        // Reload the popup contents
        loadPopupSettings($container);
        toastr.success('All settings reset to defaults. Connections preserved.', 'DeepLore Enhanced');
    });

    // Visual clamping
    const clampMap = {
        'dle-sp-scan-depth': 'scanDepth', 'dle-sp-max-entries': 'maxEntries', 'dle-sp-token-budget': 'maxTokensBudget',
        'dle-sp-depth': 'injectionDepth', 'dle-sp-notebook-depth': 'notebookDepth', 'dle-sp-max-recursion': 'maxRecursionSteps',
        'dle-sp-cache-ttl': 'cacheTTL', 'dle-sp-review-tokens': 'reviewResponseTokens',
        'dle-sp-ai-max-tokens': 'aiSearchMaxTokens', 'dle-sp-ai-timeout': 'aiSearchTimeout',
        'dle-sp-ai-scan-depth': 'aiSearchScanDepth', 'dle-sp-ai-summary-length': 'aiSearchManifestSummaryLength',
        'dle-sp-scribe-interval': 'scribeInterval', 'dle-sp-scribe-max-tokens': 'scribeMaxTokens',
        'dle-sp-scribe-timeout': 'scribeTimeout', 'dle-sp-scribe-scan-depth': 'scribeScanDepth',
        'dle-sp-new-chat-threshold': 'newChatThreshold', 'dle-sp-sync-interval': 'syncPollingInterval',
        'dle-sp-reinjection-cooldown': 'reinjectionCooldown', 'dle-sp-strip-lookback': 'stripLookbackDepth',
        'dle-sp-autosuggest-interval': 'autoSuggestInterval', 'dle-sp-autosuggest-max-tokens': 'autoSuggestMaxTokens', 'dle-sp-autosuggest-timeout': 'autoSuggestTimeout',
        'dle-sp-decay-boost-threshold': 'decayBoostThreshold', 'dle-sp-decay-penalty-threshold': 'decayPenaltyThreshold',
        'dle-sp-graph-repulsion': 'graphRepulsion', 'dle-sp-graph-spring-length': 'graphSpringLength',
        'dle-sp-graph-gravity': 'graphGravity', 'dle-sp-graph-damping': 'graphDamping',
        'dle-sp-graph-hover-dim-distance': 'graphHoverDimDistance', 'dle-sp-graph-hover-dim-opacity': 'graphHoverDimOpacity',
        'dle-sp-graph-focus-tree-depth': 'graphFocusTreeDepth', 'dle-sp-graph-edge-filter-alpha': 'graphEdgeFilterAlpha',
        'dle-sp-fuzzy-min-score': 'fuzzySearchMinScore', 'dle-sp-rebuild-gen-interval': 'indexRebuildGenerationInterval',
    };
    for (const [inputId, settingName] of Object.entries(clampMap)) {
        $c(`#${inputId}`).on('blur', function () {
            const constraints = settingsConstraints[settingName];
            if (!constraints) return;
            const val = Number($(this).val());
            if (Number.isNaN(val)) {
                $(this).val(constraints.min);
                settings[settingName] = constraints.min;
                saveSettingsDebounced();
                return;
            }
            const clamped = Math.max(constraints.min, Math.min(constraints.max, val));
            if (val !== clamped) { $(this).val(clamped); settings[settingName] = clamped; saveSettingsDebounced(); }
        });
    }
}

// ============================================================================
// Load Settings UI (stub — extension panel is gutted)
// ============================================================================

export function loadSettingsUI() {
    const settings = getSettings();
    $('#dle-enabled').prop('checked', settings.enabled);
    updateStubStatus();

    onIndexUpdated(() => {
        updateStubStatus();
        setTimeout(() => {
            try {
                const health = runHealthCheck();
                setLastHealthResult(health);
            } catch { /* noop */ }
        }, 0);
    });
    onAiStatsUpdated(() => updateStubStatus());
    onCircuitStateChanged(() => { updateStubStatus(); updateHeaderBadge(); });
}

function updateStubStatus() {
    const count = vaultIndex.length;
    const status = computeOverallStatus();
    const info = STATUS_DISPLAY[status];
    const el = document.getElementById('dle-stub-status');
    if (el) {
        el.textContent = count > 0
            ? `${count} entries | ${info.dot} ${info.label}`
            : (status === 'offline' ? `${info.dot} ${info.label}` : '');
    }
    updateHeaderBadge();
}

// ============================================================================
// Bind Settings Events (stub — extension panel is gutted)
// ============================================================================

export function bindSettingsEvents(buildIndexFn) {
    const settings = getSettings();

    $('#dle-enabled').on('change', function () {
        settings.enabled = $(this).prop('checked');
        saveSettingsDebounced();
        setupSyncPolling(buildIndexFn, buildIndexWithReuse);
    });

    $('#dle-open-settings').on('click', () => openSettingsPopup());
    $('#dle-open-settings').on('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSettingsPopup(); }
    });
}
