/**
 * DeepLore Enhanced — First-Run Setup Wizard
 * Multi-page wizard for new user onboarding.
 */
import { escapeHtml } from '../../../../../utils.js';
import { renderExtensionTemplateAsync } from '../../../../../extensions.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../../popup.js';
import { getSettings, getPrimaryVault, invalidateSettingsCache } from '../../settings.js';
import { setIndexTimestamp } from '../state.js';
import { testConnection, writeNote, writeFieldDefinitions } from '../vault/obsidian-api.js';
import { buildIndex } from '../vault/vault.js';
import { serializeFieldDefinitions, DEFAULT_FIELD_DEFINITIONS } from '../fields.js';

// ════════════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════════════

const TOTAL_PAGES = 7;

const PRESETS = {
    small:  { scanDepth: 4,  maxEntries: 10, budget: 2048 },
    medium: { scanDepth: 6,  maxEntries: 15, budget: 3072 },
    large:  { scanDepth: 8,  maxEntries: 20, budget: 4096 },
};

// ════════════════════════════════════════════════════════════════════════════
// State
// ════════════════════════════════════════════════════════════════════════════

let currentPage = 1;
let connectionVerified = false;
let aiConnectionVerified = false;
let searchMode = 'keywords'; // tracks page 3 radio selection
let $wizard = null;

// ════════════════════════════════════════════════════════════════════════════
// Entry point
// ════════════════════════════════════════════════════════════════════════════

/**
 * Show the setup wizard popup.
 * @param {number} [startPage=1] - Page to start on (1-indexed)
 */
export async function showSetupWizard(startPage = 1) {
    const html = await renderExtensionTemplateAsync('third-party/sillytavern-DeepLore-Enhanced', 'setup-wizard');

    currentPage = 1;
    connectionVerified = false;
    aiConnectionVerified = false;
    searchMode = 'keywords';

    await callGenericPopup(html, POPUP_TYPE.DISPLAY, '', {
        wide: true,
        okButton: false,
        cancelButton: false,
        allowVerticalScrolling: true,
        onOpen: () => {
            $wizard = $('.dle-wizard');
            if (!$wizard.length) return;

            prefillFromSettings();
            wireNavigation();
            wireConnectionTest();
            wireAiSetup();
            wirePresets();
            wireSearchMode();
            wireVaultStructure();
            wireDoneActions();
            wireStepIndicator();

            // Jump to requested start page
            if (startPage > 1 && startPage <= TOTAL_PAGES) {
                for (let i = 1; i < startPage; i++) markStepComplete(i);
                goToPage(startPage);
            }

            updateNavButtons();
        },
    });
}

// ════════════════════════════════════════════════════════════════════════════
// Prefill from existing settings
// ════════════════════════════════════════════════════════════════════════════

function prefillFromSettings() {
    const s = getSettings();
    const v = getPrimaryVault(s);

    // Page 2: Connection
    if (v.name) $wizard.find('#dle-wiz-vault-name').val(v.name);
    if (v.host) $wizard.find('#dle-wiz-host').val(v.host);
    if (v.port) $wizard.find('#dle-wiz-port').val(v.port);
    if (v.apiKey) $wizard.find('#dle-wiz-api-key').val(v.apiKey);

    // Page 3: Tags
    $wizard.find('#dle-wiz-lorebook-tag').val(s.lorebookTag || 'lorebook');
    $wizard.find('#dle-wiz-constant-tag').val(s.constantTag || 'lorebook-always');
    $wizard.find('#dle-wiz-seed-tag').val(s.seedTag || 'lorebook-seed');
    $wizard.find('#dle-wiz-bootstrap-tag').val(s.bootstrapTag || 'lorebook-bootstrap');

    // Search mode
    if (s.aiSearchEnabled) {
        searchMode = s.aiSearchMode || 'two-stage';
        $wizard.find(`input[name="dle-wiz-search-mode"][value="${searchMode}"]`).prop('checked', true);
    }

    // Page 4: Matching
    $wizard.find('#dle-wiz-scan-depth').val(s.scanDepth);
    $wizard.find('#dle-wiz-max-entries').val(s.maxEntries);
    $wizard.find('#dle-wiz-budget').val(s.maxTokensBudget);
    $wizard.find('#dle-wiz-fuzzy').prop('checked', s.fuzzySearchEnabled);
    $wizard.find('#dle-wiz-unlimited-entries').prop('checked', !!s.unlimitedEntries);
    $wizard.find('#dle-wiz-unlimited-budget').prop('checked', !!s.unlimitedBudget);
    if (s.unlimitedEntries) $wizard.find('#dle-wiz-max-entries').prop('disabled', true);
    if (s.unlimitedBudget) $wizard.find('#dle-wiz-budget').prop('disabled', true);

    // Page 5: AI
    if (s.aiSearchConnectionMode === 'proxy') {
        $wizard.find('input[name="dle-wiz-ai-mode"][value="proxy"]').prop('checked', true);
        $wizard.find('#dle-wiz-ai-profile-fields').hide();
        $wizard.find('#dle-wiz-ai-proxy-fields').show();
    }
    if (s.aiSearchProxyUrl) $wizard.find('#dle-wiz-ai-proxy-url').val(s.aiSearchProxyUrl);
    if (s.aiSearchModel) $wizard.find('#dle-wiz-ai-model').val(s.aiSearchModel);
}

// ════════════════════════════════════════════════════════════════════════════
// Navigation
// ════════════════════════════════════════════════════════════════════════════

function wireNavigation() {
    $wizard.find('#dle-wiz-prev').on('click', () => {
        let target = currentPage - 1;
        // Skip AI page if keywords-only
        if (target === 5 && searchMode === 'keywords') target = 4;
        if (target >= 1) goToPage(target);
    });

    $wizard.find('#dle-wiz-next').on('click', () => {
        if (!validateCurrentPage()) return;
        markStepComplete(currentPage);
        let target = currentPage + 1;
        // Skip AI page if keywords-only
        if (target === 5 && searchMode === 'keywords') target = 6;
        if (target <= TOTAL_PAGES) goToPage(target);
    });

    $wizard.find('#dle-wiz-finish').on('click', async () => {
        await applyWizardSettings();
        // Close popup
        const popup = $wizard.closest('.popup');
        if (popup.length) {
            popup.find('.popup_ok, .popup_close').trigger('click');
        }
    });
}

function goToPage(page) {
    currentPage = page;

    // Switch visible page
    $wizard.find('.dle-wizard-page').removeClass('active');
    $wizard.find(`[data-wizard-page="${page}"]`).addClass('active');

    // Update step indicator
    $wizard.find('.dle-wizard-step').removeClass('active');
    $wizard.find(`.dle-wizard-step[data-step="${page}"]`).addClass('active');

    updateNavButtons();

    // Page-specific actions on entry
    if (page === 5) loadAiProfiles();
    if (page === 6) runVaultStructureCreation();
    if (page === 7) buildSummary();
}

function updateNavButtons() {
    const $prev = $wizard.find('#dle-wiz-prev');
    const $next = $wizard.find('#dle-wiz-next');
    const $finish = $wizard.find('#dle-wiz-finish');

    $prev.toggle(currentPage > 1);

    if (currentPage === TOTAL_PAGES) {
        $next.hide();
        $finish.show();
    } else {
        $next.show();
        $finish.hide();
        $next.prop('disabled', !isPageValid(currentPage));
    }
}

function validateCurrentPage() {
    if (!isPageValid(currentPage)) {
        // Pulse the blocking element
        if (currentPage === 2 && !connectionVerified) {
            $wizard.find('#dle-wiz-test-conn').addClass('dle-wizard-pulse');
            setTimeout(() => $wizard.find('#dle-wiz-test-conn').removeClass('dle-wizard-pulse'), 600);
        }
        return false;
    }
    return true;
}

function isPageValid(page) {
    switch (page) {
        case 2: return connectionVerified;
        default: return true;
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Step Indicator
// ════════════════════════════════════════════════════════════════════════════

function wireStepIndicator() {
    $wizard.find('.dle-wizard-step').on('click', function () {
        const step = parseInt($(this).data('step'));
        // Can only click completed steps or current step
        if ($(this).hasClass('completed') || step === currentPage) {
            goToPage(step);
        }
    });
}

function markStepComplete(step) {
    const $step = $wizard.find(`.dle-wizard-step[data-step="${step}"]`);
    $step.addClass('completed');
    $step.find('.dle-wizard-step-dot').html('<i class="fa-solid fa-check"></i>');
}

// ════════════════════════════════════════════════════════════════════════════
// Page 2: Connection Test
// ════════════════════════════════════════════════════════════════════════════

function wireConnectionTest() {
    $wizard.find('#dle-wiz-test-conn').on('click', async () => {
        const $btn = $wizard.find('#dle-wiz-test-conn');
        const $result = $wizard.find('#dle-wiz-conn-result');

        const host = $wizard.find('#dle-wiz-host').val().trim() || '127.0.0.1';
        const port = parseInt($wizard.find('#dle-wiz-port').val()) || 27123;
        const apiKey = $wizard.find('#dle-wiz-api-key').val().trim();

        $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Testing...');
        $result.hide();

        try {
            const result = await testConnection(host, port, apiKey);
            if (result.ok) {
                connectionVerified = true;
                $result
                    .html('<i class="fa-solid fa-circle-check"></i> Connected to Obsidian vault successfully')
                    .removeClass('dle-wizard-result-error')
                    .addClass('dle-wizard-result-success')
                    .show();
                $btn.html('<i class="fa-solid fa-circle-check"></i> Connected').addClass('dle-wizard-btn-verified');
            } else {
                connectionVerified = false;
                $result
                    .html(`<i class="fa-solid fa-circle-xmark"></i> Connection failed: ${escapeHtml(result.error)}`)
                    .removeClass('dle-wizard-result-success')
                    .addClass('dle-wizard-result-error')
                    .show();
                $btn.html('<i class="fa-solid fa-plug"></i> Test Connection');
            }
        } catch (err) {
            connectionVerified = false;
            $result
                .html(`<i class="fa-solid fa-circle-xmark"></i> Error: ${escapeHtml(err.message)}`)
                .removeClass('dle-wizard-result-success')
                .addClass('dle-wizard-result-error')
                .show();
            $btn.html('<i class="fa-solid fa-plug"></i> Test Connection');
        }

        $btn.prop('disabled', false);
        updateNavButtons();
    });

    // Re-enable test if connection fields change
    $wizard.find('#dle-wiz-host, #dle-wiz-port, #dle-wiz-api-key').on('input', () => {
        connectionVerified = false;
        $wizard.find('#dle-wiz-test-conn')
            .html('<i class="fa-solid fa-plug"></i> Test Connection')
            .removeClass('dle-wizard-btn-verified');
        $wizard.find('#dle-wiz-conn-result').hide();
        updateNavButtons();
    });
}

// ════════════════════════════════════════════════════════════════════════════
// Page 3: Search Mode
// ════════════════════════════════════════════════════════════════════════════

function wireSearchMode() {
    $wizard.find('input[name="dle-wiz-search-mode"]').on('change', function () {
        searchMode = $(this).val();
    });
}

// ════════════════════════════════════════════════════════════════════════════
// Page 4: Presets
// ════════════════════════════════════════════════════════════════════════════

function wirePresets() {
    $wizard.find('.dle-wizard-preset').on('click', function () {
        const preset = $(this).data('preset');
        const values = PRESETS[preset];
        if (!values) return;

        $wizard.find('.dle-wizard-preset').removeClass('active');
        $(this).addClass('active');

        $wizard.find('#dle-wiz-scan-depth').val(values.scanDepth);
        $wizard.find('#dle-wiz-max-entries').val(values.maxEntries);
        $wizard.find('#dle-wiz-budget').val(values.budget);

        const label = preset.charAt(0).toUpperCase() + preset.slice(1);
        $wizard.find('#dle-wiz-preset-badge')
            .html(`<i class="fa-solid fa-check"></i> Configured for ${label} vault`)
            .addClass('dle-wizard-badge-visible');

        // Presets always disable unlimited
        $wizard.find('#dle-wiz-unlimited-entries').prop('checked', false);
        $wizard.find('#dle-wiz-unlimited-budget').prop('checked', false);
        $wizard.find('#dle-wiz-max-entries, #dle-wiz-budget').prop('disabled', false);
    });

    // Unlimited toggles
    $wizard.find('#dle-wiz-unlimited-entries').on('change', function () {
        $wizard.find('#dle-wiz-max-entries').prop('disabled', this.checked);
    });
    $wizard.find('#dle-wiz-unlimited-budget').on('change', function () {
        $wizard.find('#dle-wiz-budget').prop('disabled', this.checked);
    });
}

// ════════════════════════════════════════════════════════════════════════════
// Page 5: AI Setup
// ════════════════════════════════════════════════════════════════════════════

function wireAiSetup() {
    // Toggle profile/proxy fields
    $wizard.find('input[name="dle-wiz-ai-mode"]').on('change', function () {
        const mode = $(this).val();
        $wizard.find('#dle-wiz-ai-profile-fields').toggle(mode === 'profile');
        $wizard.find('#dle-wiz-ai-proxy-fields').toggle(mode === 'proxy');
    });

    // Test AI connection
    $wizard.find('#dle-wiz-test-ai').on('click', async () => {
        const $btn = $wizard.find('#dle-wiz-test-ai');
        const $result = $wizard.find('#dle-wiz-ai-result');
        $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Testing...');
        $result.hide();

        try {
            const mode = $wizard.find('input[name="dle-wiz-ai-mode"]:checked').val();
            let ok = false;
            let detail = '';

            if (mode === 'profile') {
                const profileId = $wizard.find('#dle-wiz-ai-profile').val();
                if (!profileId) throw new Error('Select a connection profile first');
                const { ConnectionManagerRequestService } = await import('../../../../shared.js')
                    .catch(() => ({ ConnectionManagerRequestService: null }));
                if (!ConnectionManagerRequestService) throw new Error('Connection Manager not available');
                // Verify profile exists
                const profile = ConnectionManagerRequestService.getProfile(profileId);
                if (!profile) throw new Error('Selected profile not found');
                ok = true;
                detail = `Profile: ${$wizard.find('#dle-wiz-ai-profile option:selected').text()}`;
            } else {
                const proxyUrl = $wizard.find('#dle-wiz-ai-proxy-url').val().trim();
                const model = $wizard.find('#dle-wiz-ai-model').val().trim();
                if (!proxyUrl) throw new Error('Enter a proxy URL first');
                if (!model) throw new Error('Enter a model name first (e.g. claude-haiku-4-5-20251001)');
                const { testProxyConnection } = await import('../ai/proxy-api.js');
                const result = await testProxyConnection(proxyUrl, model);
                ok = result.ok;
                detail = result.ok ? `Model: ${result.model || model}` : result.error;
            }

            if (ok) {
                aiConnectionVerified = true;
                $result
                    .html(`<i class="fa-solid fa-circle-check"></i> AI connection working — ${detail}`)
                    .removeClass('dle-wizard-result-error')
                    .addClass('dle-wizard-result-success')
                    .show();
                $btn.html('<i class="fa-solid fa-circle-check"></i> Connected').addClass('dle-wizard-btn-verified');
            } else {
                aiConnectionVerified = false;
                $result
                    .html(`<i class="fa-solid fa-circle-xmark"></i> ${detail}`)
                    .removeClass('dle-wizard-result-success')
                    .addClass('dle-wizard-result-error')
                    .show();
                $btn.html('<i class="fa-solid fa-brain"></i> Test AI Connection');
            }
        } catch (err) {
            $result
                .html(`<i class="fa-solid fa-circle-xmark"></i> ${escapeHtml(err.message)}`)
                .removeClass('dle-wizard-result-success')
                .addClass('dle-wizard-result-error')
                .show();
            $btn.html('<i class="fa-solid fa-brain"></i> Test AI Connection');
        }

        $btn.prop('disabled', false);
    });
}

async function loadAiProfiles() {
    const $select = $wizard.find('#dle-wiz-ai-profile');
    try {
        const { ConnectionManagerRequestService } = await import('../../../../shared.js')
            .catch(() => ({ ConnectionManagerRequestService: null }));
        if (!ConnectionManagerRequestService) {
            $select.html('<option value="">Connection Manager not available</option>');
            return;
        }
        const profiles = ConnectionManagerRequestService.getSupportedProfiles();
        if (!profiles || profiles.length === 0) {
            $select.html('<option value="">No profiles configured</option>');
            return;
        }
        const s = getSettings();
        let options = '<option value="">— Select a profile —</option>';
        for (const p of profiles) {
            const selected = p.id === s.aiSearchProfileId ? ' selected' : '';
            const label = `${p.name} (${p.api}${p.model ? ' / ' + p.model : ''})`;
            options += `<option value="${p.id}"${selected}>${esc(label)}</option>`;
        }
        $select.html(options);
    } catch {
        $select.html('<option value="">Failed to load profiles</option>');
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Page 6: Vault Structure
// ════════════════════════════════════════════════════════════════════════════

function wireVaultStructure() {
    // Handled on page entry via runVaultStructureCreation
}

async function runVaultStructureCreation() {
    const host = $wizard.find('#dle-wiz-host').val().trim() || '127.0.0.1';
    const port = parseInt($wizard.find('#dle-wiz-port').val()) || 27123;
    const apiKey = $wizard.find('#dle-wiz-api-key').val().trim();

    // Field definitions
    const createFields = $wizard.find('#dle-wiz-create-fields').is(':checked');
    const $fieldsStatus = $wizard.find('#dle-wiz-fields-status');

    if (createFields) {
        $fieldsStatus.html('<i class="fa-solid fa-spinner fa-spin"></i> Creating field-definitions.yaml...').show();
        try {
            const yaml = serializeFieldDefinitions(DEFAULT_FIELD_DEFINITIONS);
            const s = getSettings();
            const path = s.fieldDefinitionsPath || 'DeepLore/field-definitions.yaml';
            await writeFieldDefinitions(host, port, apiKey, path, yaml);
            $fieldsStatus
                .html('<i class="fa-solid fa-circle-check dle-wizard-status-ok"></i> field-definitions.yaml created')
                .addClass('dle-wizard-file-ok');
        } catch (err) {
            $fieldsStatus
                .html(`<i class="fa-solid fa-circle-xmark dle-wizard-status-err"></i> Failed: ${escapeHtml(err.message)}`)
                .addClass('dle-wizard-file-err');
        }
    } else {
        $fieldsStatus.html('<span class="dle-wizard-status-skip">— Skipped</span>').show();
    }

    // Sessions folder
    const createSessions = $wizard.find('#dle-wiz-create-sessions').is(':checked');
    const $sessionsStatus = $wizard.find('#dle-wiz-sessions-status');

    if (createSessions) {
        $sessionsStatus.html('<i class="fa-solid fa-spinner fa-spin"></i> Creating Sessions folder...').show();
        try {
            // Write a placeholder note to create the folder
            await writeNote(host, port, apiKey, 'Sessions/.gitkeep', '# Session Scribe\nThis folder is used by DeepLore Enhanced Session Scribe.\n');
            $sessionsStatus
                .html('<i class="fa-solid fa-circle-check dle-wizard-status-ok"></i> Sessions/ folder created')
                .addClass('dle-wizard-file-ok');
        } catch (err) {
            $sessionsStatus
                .html(`<i class="fa-solid fa-circle-xmark dle-wizard-status-err"></i> Failed: ${escapeHtml(err.message)}`)
                .addClass('dle-wizard-file-err');
        }
    } else {
        $sessionsStatus.html('<span class="dle-wizard-status-skip">— Skipped</span>').show();
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Page 7: Summary
// ════════════════════════════════════════════════════════════════════════════

function buildSummary() {
    const $summary = $wizard.find('#dle-wiz-summary');
    const vaultName = $wizard.find('#dle-wiz-vault-name').val().trim() || 'Primary';
    const host = $wizard.find('#dle-wiz-host').val().trim() || '127.0.0.1';
    const port = $wizard.find('#dle-wiz-port').val() || '27123';

    const modeLabels = { keywords: 'Keywords Only', 'two-stage': 'Two-Stage (keywords + AI)', 'ai-only': 'AI Only' };
    const modeLabel = modeLabels[searchMode] || searchMode;

    const maxEntries = $wizard.find('#dle-wiz-max-entries').val();
    const budget = $wizard.find('#dle-wiz-budget').val();

    // Determine which preset matches (if any)
    const scanDepth = parseInt($wizard.find('#dle-wiz-scan-depth').val());
    let presetLabel = 'Custom';
    for (const [name, vals] of Object.entries(PRESETS)) {
        if (vals.scanDepth === scanDepth && vals.maxEntries === parseInt(maxEntries) && vals.budget === parseInt(budget)) {
            presetLabel = name.charAt(0).toUpperCase() + name.slice(1);
            break;
        }
    }

    const fieldsCreated = $wizard.find('#dle-wiz-create-fields').is(':checked');
    const sessionsCreated = $wizard.find('#dle-wiz-create-sessions').is(':checked');

    const items = [
        `<i class="fa-solid fa-circle-check"></i> Vault connected: <strong>${esc(vaultName)}</strong> on ${esc(host)}:${esc(port)}`,
        `<i class="fa-solid fa-circle-check"></i> Search mode: <strong>${esc(modeLabel)}</strong>`,
        `<i class="fa-solid fa-circle-check"></i> Matching: <strong>${esc(presetLabel)} preset</strong> (${maxEntries} entries, ${budget} token budget)`,
    ];

    if (fieldsCreated) items.push('<i class="fa-solid fa-circle-check"></i> Field definitions created');
    if (sessionsCreated) items.push('<i class="fa-solid fa-circle-check"></i> Sessions folder created');

    $summary.html(items.map((item, i) => `<div class="dle-wizard-summary-item" style="animation-delay: ${i * 120}ms">${item}</div>`).join(''));
}

function wireDoneActions() {
    $wizard.on('click', '.dle-wizard-done-btn', function () {
        const action = $(this).data('action');
        // Close popup first
        const popup = $wizard.closest('.popup');
        if (popup.length) popup.find('.popup_ok, .popup_close').trigger('click');

        setTimeout(() => {
            switch (action) {
                case 'health': executeCommand('/dle-health'); break;
                case 'graph': executeCommand('/dle-graph'); break;
                case 'browse': executeCommand('/dle-browse'); break;
                case 'settings':
                    import('./settings-ui.js').then(m => m.openSettingsPopup?.());
                    break;
            }
        }, 300);
    });
}

// ════════════════════════════════════════════════════════════════════════════
// Apply settings on Finish
// ════════════════════════════════════════════════════════════════════════════

async function applyWizardSettings() {
    const settings = getSettings();

    // Connection
    const vaultName = $wizard.find('#dle-wiz-vault-name').val().trim() || 'Primary';
    const host = $wizard.find('#dle-wiz-host').val().trim() || '127.0.0.1';
    const port = parseInt($wizard.find('#dle-wiz-port').val()) || 27123;
    const apiKey = $wizard.find('#dle-wiz-api-key').val().trim();

    settings.enabled = true;
    settings.vaults = [{ name: vaultName, host, port, apiKey, enabled: true }];

    // Tags
    settings.lorebookTag = $wizard.find('#dle-wiz-lorebook-tag').val().trim() || 'lorebook';
    settings.constantTag = $wizard.find('#dle-wiz-constant-tag').val().trim() || 'lorebook-always';
    settings.seedTag = $wizard.find('#dle-wiz-seed-tag').val().trim() || 'lorebook-seed';
    settings.bootstrapTag = $wizard.find('#dle-wiz-bootstrap-tag').val().trim() || 'lorebook-bootstrap';

    // Search mode
    settings.aiSearchEnabled = searchMode !== 'keywords';
    if (searchMode !== 'keywords') settings.aiSearchMode = searchMode;

    // Matching
    settings.scanDepth = parseInt($wizard.find('#dle-wiz-scan-depth').val()) || 6;
    settings.maxEntries = parseInt($wizard.find('#dle-wiz-max-entries').val()) || 15;
    settings.maxTokensBudget = parseInt($wizard.find('#dle-wiz-budget').val()) || 3072;
    settings.unlimitedEntries = $wizard.find('#dle-wiz-unlimited-entries').is(':checked');
    settings.unlimitedBudget = $wizard.find('#dle-wiz-unlimited-budget').is(':checked');
    settings.fuzzySearchEnabled = $wizard.find('#dle-wiz-fuzzy').is(':checked');

    // AI Search
    if (searchMode !== 'keywords') {
        const aiMode = $wizard.find('input[name="dle-wiz-ai-mode"]:checked').val();
        settings.aiSearchConnectionMode = aiMode || 'profile';
        if (aiMode === 'profile') {
            settings.aiSearchProfileId = $wizard.find('#dle-wiz-ai-profile').val() || '';
        } else {
            settings.aiSearchProxyUrl = $wizard.find('#dle-wiz-ai-proxy-url').val().trim() || 'http://localhost:42069';
            settings.aiSearchModel = $wizard.find('#dle-wiz-ai-model').val().trim() || '';
        }
    }

    // Mark wizard completed
    settings._wizardCompleted = true;

    invalidateSettingsCache();
    SillyTavern.getContext().saveSettingsDebounced();

    // Build index
    setIndexTimestamp(0);
    await buildIndex();
}

// ════════════════════════════════════════════════════════════════════════════
// Utility
// ════════════════════════════════════════════════════════════════════════════

/** Execute a slash command via ST's context API */
function executeCommand(cmd) {
    const ctx = typeof SillyTavern !== 'undefined' && SillyTavern.getContext ? SillyTavern.getContext() : null;
    if (ctx?.executeSlashCommands) {
        ctx.executeSlashCommands(cmd).catch(err => console.error('[DLE] Wizard command error:', cmd, err));
    }
}

function esc(str) {
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}
