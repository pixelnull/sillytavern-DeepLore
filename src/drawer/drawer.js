/**
 * DeepLore Enhanced — Drawer Panel (Orchestrator)
 * Creates the drawer, wires observers, and delegates to render/events modules.
 *
 * Module split:
 *   drawer-state.js  — Shared mutable state, constants, utility functions
 *   drawer-render.js — All render/DOM-update functions
 *   drawer-events.js — All event wiring and interaction handlers
 *   drawer.js        — This file: creation, lifecycle, observer subscriptions
 */
import { doNavbarIconClick, saveSettingsDebounced } from '../../../../../../script.js';
import { renderExtensionTemplateAsync, extension_settings } from '../../../../../extensions.js';
import { escapeHtml } from '../../../../../utils.js';
import {
    vaultIndex,
    lastInjectionSources,
    onIndexUpdated, onAiStatsUpdated, onCircuitStateChanged,
    onPipelineComplete, onGatingChanged, onPinBlockChanged, onGenerationLockChanged,
    onIndexingChanged,
} from '../state.js';

// ─── Drawer sub-modules ───
import {
    ds, DRAWER_ID, MODULE_NAME, OVERLAY_CHAT_WIDTH_THRESHOLD,
    scheduleRender, announceToScreenReader, loadSTInternals, dragElement, isMobile, power_user,
    invalidateTemperatureCache,
} from './drawer-state.js';
import {
    renderStatusZone, renderInjectionTab, renderBrowseTab, renderBrowseWindow,
    renderGatingTab, renderTimers, renderFooter,
} from './drawer-render.js';
import {
    switchTab,
    wireToolsTab, wireTabExpand, wireStatusActions, wireInjectionTab, wireBrowseTab, wireGatingTab, wireHealthIcons,
} from './drawer-events.js';

// ════════════════════════════════════════════════════════════════════════════
// Public API (consumed by index.js)
// ════════════════════════════════════════════════════════════════════════════

/** Reset ephemeral drawer state on chat change */
export function resetDrawerState() {
    ds.browseQuery = '';
    ds.browseStatusFilter = 'all';
    ds.browseTagFilter = '';
    ds.browseSort = 'priority_asc';
    ds.browseFilteredEntries = [];
    ds.browseLastRangeStart = -1;
    ds.browseLastRangeEnd = -1;
    ds.browseExpandedEntry = null;
    ds.browseNavigateTarget = null;
    ds.browseCustomFieldFilters = {}; // BUG-AUDIT-11: Reset custom field filters on chat change
    ds.contextTokens = 0;
    // Note: ds.stGenerating is NOT reset here — it tracks ST's generation state
    // which persists across chat switches. GENERATION_ENDED clears it.
    if (ds.browseSearchTimeout) { clearTimeout(ds.browseSearchTimeout); ds.browseSearchTimeout = null; }
    // Clear the search input and filter selects if drawer exists
    const $input = $(`#${DRAWER_ID} .dle-browse-input`);
    if ($input.length) $input.val('');
    const $status = $(`#${DRAWER_ID} [data-filter="status"]`);
    if ($status.length) $status.val('all');
    const $tag = $(`#${DRAWER_ID} [data-filter="tag"]`);
    if ($tag.length) $tag.val('');
    const $sort = $(`#${DRAWER_ID} [data-sort]`);
    if ($sort.length) $sort.val('priority_asc');
}

// ════════════════════════════════════════════════════════════════════════════
// Tag Cache
// ════════════════════════════════════════════════════════════════════════════

/** Rebuild the pre-computed tag cache from the current vault index */
function rebuildTagCache() {
    ds.cachedTagSet = new Set();
    for (const e of vaultIndex) {
        if (e.tags) for (const t of e.tags) ds.cachedTagSet.add(t);
    }
    ds.cachedTagOptions = '<option value="">Tags</option>' +
        [...ds.cachedTagSet].sort().map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
}

// ════════════════════════════════════════════════════════════════════════════
// Drawer Creation
// ════════════════════════════════════════════════════════════════════════════

/**
 * Create the drawer panel in #top-settings-holder.
 * Mirrors ST's native drawer structure exactly (see #rightNavHolder pattern).
 */
export async function createDrawerPanel() {
    if ($(`#${DRAWER_ID}`).length) return;

    // Load ST internals (Moving UI, mobile detection)
    await loadSTInternals();

    // Load the drawer HTML template
    const drawerContent = await renderExtensionTemplateAsync(
        'third-party/sillytavern-DeepLore-Enhanced-Cheesedozer-Edition',
        'drawer',
    );

    // Build the full drawer structure — mirrors ST's native pattern exactly
    const $drawer = ds.$drawer = $(`
        <div id="${DRAWER_ID}" class="drawer">
            <div class="drawer-toggle drawer-header">
                <div id="deeploreDrawerIcon"
                     class="drawer-icon interactable closedIcon dle-drawer-icon-svg"
                     title="DeepLore Enhanced"
                     tabindex="0"
                     role="button"
                     aria-expanded="false"
                     aria-label="DeepLore Enhanced drawer"><i class="fa-solid fa-book-open fa-fw" aria-hidden="true"></i></div>
            </div>
            <div id="deeplore-panel" class="drawer-content closedDrawer fillRight" role="region" aria-label="DeepLore Enhanced panel">
                <div id="deeplore-panelheader" class="fa-solid fa-grip drag-grabber" aria-hidden="true"></div>
                <div class="dle-drawer-controls">
                    <div class="dle-drawer-pin" title="Pin drawer open">
                        <input type="checkbox" id="dle-drawer-pin" aria-label="Pin drawer open">
                        <label for="dle-drawer-pin">
                            <div class="fa-solid unchecked fa-unlock right_menu_button" aria-hidden="true"></div>
                            <div class="fa-solid checked fa-lock right_menu_button" aria-hidden="true"></div>
                        </label>
                    </div>
                    <!-- NOTE: Do NOT use right_menu_button class on <button> elements — ST applies
                         background-color: rgb(240,240,240) which creates a white square. The lock avoids
                         this because it's a checkbox+label, not a button. Style manually instead. -->
                    <button class="dle-drawer-help" title="Show available commands (/dle-help)" aria-label="Show help">
                        <i class="fa-solid fa-circle-question" aria-hidden="true"></i>
                    </button>
                    <button id="dle-drawer-close" class="dle-drawer-close" title="Close drawer" aria-label="Close drawer">
                        <i class="fa-solid fa-chevron-up" aria-hidden="true"></i>
                    </button>
                </div>
                <div class="scrollableInner dle-drawer-inner">
                </div>
            </div>
        </div>
    `);

    // Inject content into the scrollable area, then move footer outside so it stays pinned
    $drawer.find('.dle-drawer-inner').append(drawerContent);
    const $footerZone = $drawer.find('#dle-drawer-footer');
    if ($footerZone.length) $footerZone.insertAfter($drawer.find('.dle-drawer-inner'));

    // Add to top-settings-holder (after native drawers)
    $('#top-settings-holder').append($drawer);

    // Load custom SVG icon (async, non-blocking — FA fallback already in place)
    fetch('/scripts/extensions/third-party/sillytavern-DeepLore-Enhanced-Cheesedozer-Edition/icon.svg')
        .then(r => r.ok ? r.text() : null)
        .then(svg => {
            if (!svg) return;
            const $icon = $drawer.find('#deeploreDrawerIcon');
            $icon.empty().append($(svg).attr('aria-hidden', 'true'));
        })
        .catch(() => { /* FA fallback stays */ });

    // ═══════════════════════════════════════════════════════════════════════
    // Drawer toggle binding
    // ═══════════════════════════════════════════════════════════════════════

    // CRITICAL: Bind the drawer toggle — ST's initial binding already ran at page load,
    // so dynamically-added drawers need explicit binding to doNavbarIconClick
    $drawer.find('.drawer-toggle').on('click', function (e) {
        doNavbarIconClick.call(this, e);
        // Update aria-expanded after ST processes the toggle
        requestAnimationFrame(() => {
            const isOpen = $drawer.find('#deeplore-panel').hasClass('openDrawer');
            $drawer.find('#deeploreDrawerIcon').attr('aria-expanded', String(isOpen));
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Overlay mode
    // ═══════════════════════════════════════════════════════════════════════

    // When chat_width is set too high for the drawer to fit comfortably,
    // switch to fixed overlay (mirrors ST's mobile pattern).
    const $panel = $drawer.find('#deeplore-panel');

    function updateOverlayMode() {
        const chatWidth = power_user?.chat_width || 50;
        if (chatWidth >= OVERLAY_CHAT_WIDTH_THRESHOLD) {
            $panel.addClass('dle-overlay-mode');
        } else {
            $panel.removeClass('dle-overlay-mode');
        }
    }

    // Check on drawer toggle
    $drawer.find('.drawer-toggle').on('click', () => requestAnimationFrame(updateOverlayMode));
    // Check now (in case drawer is pinned open at init)
    updateOverlayMode();

    // ═══════════════════════════════════════════════════════════════════════
    // Pin / Close / Mobile
    // ═══════════════════════════════════════════════════════════════════════

    // Hide pin on mobile (ST convention — native drawers gate behind !isMobile())
    if (isMobile && isMobile()) {
        $drawer.find('.dle-drawer-pin').hide();
    }

    // Restore persisted pin state
    const settings = extension_settings[MODULE_NAME] || {};
    if (settings.drawerPinned && !(isMobile && isMobile())) {
        $drawer.find('#dle-drawer-pin').prop('checked', true);
        $drawer.find('#deeplore-panel').addClass('pinnedOpen');
        $drawer.find('#deeploreDrawerIcon').addClass('drawerPinnedOpen');
    }

    // Wire up pin toggle — matches ST's native drawer pin pattern
    $drawer.find('#dle-drawer-pin').on('click', function () {
        const pinned = $(this).prop('checked');
        if (pinned) {
            $drawer.find('#deeplore-panel').addClass('pinnedOpen');
            $drawer.find('#deeploreDrawerIcon').addClass('drawerPinnedOpen');
        } else {
            $drawer.find('#deeplore-panel').removeClass('pinnedOpen');
            $drawer.find('#deeploreDrawerIcon').removeClass('drawerPinnedOpen');
            // ST convention: close drawer on unpin if another drawer is also open
            if ($drawer.find('#deeplore-panel').hasClass('openDrawer') && $('.openDrawer').length > 1) {
                doNavbarIconClick.call($drawer.find('.drawer-toggle')[0]);
            }
        }

        // Persist pin state
        if (!extension_settings[MODULE_NAME]) extension_settings[MODULE_NAME] = {};
        extension_settings[MODULE_NAME].drawerPinned = pinned;
        saveSettingsDebounced();
    });

    // Wire up close button — triggers the same toggle as clicking the drawer icon
    $drawer.find('#dle-drawer-close').on('click', function () {
        // Only close if drawer is actually open (prevent toggle-reopen)
        if ($panel.hasClass('openDrawer')) {
            doNavbarIconClick.call($drawer.find('.drawer-toggle')[0]);
        }
    });

    // Help button — opens /dle-help command
    $drawer.find('.dle-drawer-help').on('click', function () {
        const ctx = typeof SillyTavern !== 'undefined' && SillyTavern.getContext ? SillyTavern.getContext() : null;
        if (ctx?.executeSlashCommands) {
            ctx.executeSlashCommands('/dle-help');
        }
    });

    // Moving UI support — let ST's drag system handle our panel
    if (power_user?.movingUI && dragElement) {
        dragElement($('#deeplore-panel'));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Tab switching
    // ═══════════════════════════════════════════════════════════════════════

    $drawer.find('.dle-tab').on('click', function () {
        switchTab($drawer, $(this).data('tab'));
    });

    // Keyboard (arrow keys, Home/End per ARIA tabs pattern)
    $drawer.find('.dle-tab').on('keydown', function (e) {
        const $tabs = $drawer.find('.dle-tab');
        const idx = $tabs.index(this);
        let newIdx = idx;

        switch (e.key) {
            case 'ArrowRight': newIdx = (idx + 1) % $tabs.length; break;
            case 'ArrowLeft': newIdx = (idx - 1 + $tabs.length) % $tabs.length; break;
            case 'Home': newIdx = 0; break;
            case 'End': newIdx = $tabs.length - 1; break;
            default: return;
        }

        e.preventDefault();
        const $newTab = $tabs.eq(newIdx);
        switchTab($drawer, $newTab.data('tab'));
        $newTab.trigger('focus');
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Wire event handlers (one-time, delegated to sub-module)
    // ═══════════════════════════════════════════════════════════════════════
    wireToolsTab($drawer);
    wireTabExpand($drawer);
    wireStatusActions($drawer);
    wireInjectionTab($drawer);
    wireBrowseTab($drawer);
    wireGatingTab($drawer);
    wireHealthIcons($drawer);

    // Wire browse navigation buttons (Why? tab → Browse tab)
    // Delegated here to avoid circular imports (drawer-events.js ← drawer.js)
    $drawer.on('click', '.dle-browse-nav-btn', function (e) {
        e.stopPropagation();
        const title = $(this).data('browse-title');
        if (title) navigateToBrowseEntry(title);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Context window event — track total prompt tokens after assembly
    // ═══════════════════════════════════════════════════════════════════════
    try {
        const stCtx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (stCtx?.eventSource && stCtx?.eventTypes?.CHAT_COMPLETION_PROMPT_READY) {
            // Lazy-load promptManager to avoid breaking module graph for non-OAI backends
            if (!ds.promptManagerRef) {
                try {
                    const oai = await import('../../../../openai.js');
                    ds.promptManagerRef = oai.promptManager;
                } catch { /* non-OAI backend, context bar stays at 0 */ }
            }
            stCtx.eventSource.on(stCtx.eventTypes.CHAT_COMPLETION_PROMPT_READY, () => {
                ds.contextTokens = ds.promptManagerRef?.tokenUsage || 0;
                scheduleRender(renderFooter);
            });
        }
    } catch (err) {
        console.warn('[DLE] Could not wire context token tracking:', err.message);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Generation lifecycle — track "Writing..." state
    // ═══════════════════════════════════════════════════════════════════════
    try {
        const stCtx2 = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (stCtx2?.eventSource && stCtx2?.eventTypes?.GENERATION_STARTED) {
            stCtx2.eventSource.on(stCtx2.eventTypes.GENERATION_STARTED, (_type, _opts, dryRun) => {
                if (dryRun) return; // Ignore dry runs (token counting) — they never end
                ds.stGenerating = true;
                scheduleRender(renderStatusZone);
            });
            stCtx2.eventSource.on(stCtx2.eventTypes.GENERATION_ENDED, (...args) => {
                // GENERATION_ENDED may not pass dryRun, but skip if stGenerating is already false
                // (avoids dry-run END clearing a real generation's state)
                if (!ds.stGenerating) return;
                ds.stGenerating = false;
                scheduleRender(renderStatusZone);
            });
            // GENERATION_STOPPED fires when user clicks Stop — clear generating state
            // as a safety net (GENERATION_ENDED may or may not fire depending on timing)
            if (stCtx2.eventTypes.GENERATION_STOPPED) {
                stCtx2.eventSource.on(stCtx2.eventTypes.GENERATION_STOPPED, () => {
                    ds.stGenerating = false;
                    scheduleRender(renderStatusZone);
                });
            }
        }
    } catch (err) {
        console.warn('[DLE] Could not wire generation lifecycle tracking:', err.message);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // E10: Restore last viewed drawer tab
    // ═══════════════════════════════════════════════════════════════════════
    try {
        const lastTab = localStorage.getItem('dle-last-drawer-tab');
        if (lastTab) switchTab($drawer, lastTab);
    } catch { /* noop */ }

    // ═══════════════════════════════════════════════════════════════════════
    // Initial render
    // ═══════════════════════════════════════════════════════════════════════

    // Build tag cache if index is already loaded
    if (vaultIndex?.length) rebuildTagCache();

    renderStatusZone();
    renderInjectionTab();
    renderBrowseTab();
    renderGatingTab();
    renderTimers();
    renderFooter();

    // ═══════════════════════════════════════════════════════════════════════
    // Observer subscriptions — live data updates
    // ═══════════════════════════════════════════════════════════════════════
    onIndexUpdated(() => {
        rebuildTagCache();
        scheduleRender(renderStatusZone);
        scheduleRender(renderBrowseTab);
        scheduleRender(renderTimers);
        scheduleRender(renderFooter);
        announceToScreenReader(`Vault index refreshed: ${vaultIndex.length} entries loaded.`);
    });

    onAiStatsUpdated(() => {
        scheduleRender(renderStatusZone);
        scheduleRender(renderFooter);
    });

    onCircuitStateChanged(() => {
        scheduleRender(renderStatusZone);
        scheduleRender(renderFooter);
    });

    onPipelineComplete(() => {
        invalidateTemperatureCache();
        scheduleRender(renderStatusZone);
        scheduleRender(renderInjectionTab);
        scheduleRender(renderBrowseTab);
        scheduleRender(renderTimers);
        scheduleRender(renderFooter);
        if (lastInjectionSources !== null) {
            announceToScreenReader(`Pipeline complete: ${lastInjectionSources.length} entries injected.`);
        }
    });

    onGatingChanged(() => {
        scheduleRender(renderStatusZone);
        scheduleRender(renderGatingTab);
    });

    onPinBlockChanged(() => {
        scheduleRender(renderBrowseTab);
    });

    onGenerationLockChanged(() => {
        scheduleRender(renderStatusZone);
        scheduleRender(renderInjectionTab);
    });

    onIndexingChanged(() => {
        scheduleRender(renderStatusZone);
        scheduleRender(renderBrowseTab);
    });
}

/**
 * Navigate the drawer Browse tab to a specific entry.
 * Opens the drawer if closed, switches to Browse, filters to the entry, and auto-expands it.
 * @param {string} title - Entry title to navigate to
 */
export function navigateToBrowseEntry(title) {
    if (!ds.$drawer) return;

    // Open drawer if closed — openDrawer class is on #deeplore-panel, not the wrapper
    const toggle = ds.$drawer.find('.drawer-toggle')[0];
    if (toggle && !ds.$drawer.find('#deeplore-panel').hasClass('openDrawer')) {
        doNavbarIconClick.call(toggle);
    }

    // Switch to Browse tab
    switchTab(ds.$drawer, 'browse');

    // Set search to exact title, clear other filters
    ds.browseQuery = title;
    ds.browseStatusFilter = 'all';
    ds.browseTagFilter = '';
    ds.browseNavigateTarget = title; // renderBrowseTab will use this for auto-expand

    // Update the search input UI to reflect the query
    ds.$drawer.find('.dle-browse-input').val(title);
    ds.$drawer.find('[data-filter="status"]').val('all');
    ds.$drawer.find('[data-filter="tag"]').val('');

    // Render
    renderBrowseTab();
}
