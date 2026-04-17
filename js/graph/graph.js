/**
 * DeepLore Enhanced — Graph visualization orchestrator.
 * Builds node/edge data, creates popup DOM, initializes sub-modules,
 * runs the animation loop. Sub-modules handle physics, rendering,
 * events, settings, and focus tree.
 */
import { callGenericPopup, POPUP_TYPE } from './shims/popup.js';
import { NO_ENTRIES_MSG } from './shims/utils.js';
import { getSettings, invalidateSettingsCache } from './shims/settings.js';
import { vaultIndex, chatInjectionCounts, trackerKey, mentionWeights, fieldDefinitions } from './shims/state.js';
import { DEFAULT_FIELD_DEFINITIONS } from './shims/fields.js';
import { ensureIndexFresh } from './shims/vault.js';
import { saveSettingsDebounced } from './shims/script.js';

import { initPhysics } from './graph-physics.js';
import { initRender } from './graph-render.js';
import { initFocus } from './graph-focus.js';
import { initEvents } from './graph-events.js';
import { initGraphSettings } from './graph-settings.js';
import { computeDisparityFilter, computeLouvainCommunities, updateCommunityCentroids, convexHull, COMMUNITY_PALETTE, computeGapAnalysis } from './graph-analysis.js';

const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ============================================================================
// Debug logging
// ============================================================================
const TAG = '[DLE Graph]';
function dbg(...args) {
    const s = getSettings();
    if (s?.debugMode) console.debug(TAG, ...args);
}

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Show an interactive force-directed graph of entry relationships.
 */
export async function showGraphPopup() {
    await ensureIndexFresh();
    if (vaultIndex.length === 0) {
        toastr.info(NO_ENTRIES_MSG, 'DeepLore Enhanced');
        return;
    }

    const settings = getSettings();
    const multiVault = (settings.vaults || []).length > 1;

    // ========================================================================
    // Build node and edge data — filter out entries with graph: false
    // ========================================================================
    const graphEntries = vaultIndex.filter(e => e.graph !== false);
    dbg(`showGraphPopup: ${vaultIndex.length} vault entries, ${graphEntries.length} graphable, multiVault=${multiVault}`);

    if (graphEntries.length > 500) {
        toastr.warning(
            `Large graph (${graphEntries.length} entries). The graph may be slow to render. Consider filtering by tag first.`,
            'DeepLore Enhanced',
            { timeOut: 8000, preventDuplicates: true },
        );
    }
    const nodes = graphEntries.map((e, i) => ({
        id: i,
        title: e.title,
        type: e.constant ? 'constant' : e.seed ? 'seed' : e.bootstrap ? 'bootstrap' : 'regular',
        tokens: e.tokenEstimate,
        priority: e.priority,
        vaultSource: e.vaultSource || '',
        tags: Array.isArray(e.tags) ? e.tags : [],
        x: 0, y: 0, vx: 0, vy: 0,
        hidden: false,
        filtered: false,
        cluster: 0,
        _revealScale: 0,
    }));

    // Detect title collisions (case-insensitive)
    const titleToIdx = new Map();
    const titleCollisions = [];
    for (let i = 0; i < graphEntries.length; i++) {
        const key = graphEntries[i].title.toLowerCase();
        if (titleToIdx.has(key)) {
            titleCollisions.push({ existing: titleToIdx.get(key), duplicate: i, title: graphEntries[i].title });
        } else {
            titleToIdx.set(key, i);
        }
    }
    if (titleCollisions.length > 0) {
        dbg('Title collisions detected:', titleCollisions.map(c => `"${c.title}" (idx ${c.existing} vs ${c.duplicate})`));
        toastr.warning(
            `${titleCollisions.length} title collision(s) detected (case-insensitive). Duplicate entries may not display correctly in the graph.`,
            'DeepLore Enhanced',
            { timeOut: 8000, preventDuplicates: true },
        );
    }

    // Deduplicate edges
    const edgeSet = new Set();
    const edges = [];
    function addEdge(from, to, type) {
        const key = `${Math.min(from, to)},${Math.max(from, to)},${type}`;
        if (!edgeSet.has(key)) {
            edgeSet.add(key);
            const srcTitle = graphEntries[from]?.title || '';
            const tgtTitle = graphEntries[to]?.title || '';
            const mw = (mentionWeights.get(`${srcTitle}\0${tgtTitle}`) || 0)
                      + (mentionWeights.get(`${tgtTitle}\0${srcTitle}`) || 0);
            edges.push({ from, to, type, _idx: edges.length, weight: Math.max(1, mw), _revealAlpha: 0 });
        }
    }

    for (let i = 0; i < graphEntries.length; i++) {
        const entry = graphEntries[i];
        for (const link of entry.resolvedLinks) {
            const j = titleToIdx.get(link.toLowerCase());
            if (j !== undefined && j !== i) addEdge(i, j, 'link');
        }
        for (const req of entry.requires) {
            const j = titleToIdx.get(req.toLowerCase());
            if (j !== undefined && j !== i) addEdge(i, j, 'requires');
        }
        for (const ex of entry.excludes) {
            const j = titleToIdx.get(ex.toLowerCase());
            if (j !== undefined && j !== i) addEdge(i, j, 'excludes');
        }
        for (const cl of (entry.cascadeLinks || [])) {
            const j = titleToIdx.get(cl.toLowerCase());
            if (j !== undefined && j !== i) addEdge(i, j, 'cascade');
        }
    }

    // Detect circular requires
    const circularPairs = [];
    const requiresSet = new Set();
    for (const edge of edges) {
        if (edge.type === 'requires') requiresSet.add(`${edge.from},${edge.to}`);
    }
    const seenCircular = new Set();
    for (const edge of edges) {
        if (edge.type === 'requires' && requiresSet.has(`${edge.to},${edge.from}`)) {
            const key = `${Math.min(edge.from, edge.to)},${Math.max(edge.from, edge.to)}`;
            if (!seenCircular.has(key)) { seenCircular.add(key); circularPairs.push(key); }
        }
    }

    // Count edges per node pair (ignoring type)
    const pairEdgeCount = new Map();
    for (const e of edges) {
        const key = `${Math.min(e.from, e.to)},${Math.max(e.from, e.to)}`;
        pairEdgeCount.set(key, (pairEdgeCount.get(key) || 0) + 1);
    }
    const multiEdgePairs = [...pairEdgeCount.entries()].filter(([, c]) => c > 1);
    dbg(`Edge pairs: ${pairEdgeCount.size} unique pairs, ${multiEdgePairs.length} with multiple edge types`);
    if (multiEdgePairs.length > 0) {
        dbg(`Multi-edge pairs (top 10):`, multiEdgePairs.slice(0, 10).map(([k, c]) => {
            const [a, b] = k.split(',').map(Number);
            return `${nodes[a].title} ↔ ${nodes[b].title}: ${c} edges`;
        }));
    }
    const edgeCountDist = new Map();
    for (const [, c] of pairEdgeCount) edgeCountDist.set(c, (edgeCountDist.get(c) || 0) + 1);
    dbg(`Edge count distribution:`, Object.fromEntries([...edgeCountDist.entries()].sort()));

    dbg(`Built ${edges.length} edges (${edgeSet.size} unique), ${circularPairs.length} circular pairs`);
    const edgeTypeCounts = { link: 0, requires: 0, excludes: 0, cascade: 0 };
    for (const e of edges) edgeTypeCounts[e.type] = (edgeTypeCounts[e.type] || 0) + 1;
    dbg(`Edge breakdown: link=${edgeTypeCounts.link}, requires=${edgeTypeCounts.requires}, excludes=${edgeTypeCounts.excludes}, cascade=${edgeTypeCounts.cascade}`);

    // Edge visibility state
    const edgeVisibility = { link: true, requires: true, excludes: true, cascade: true };

    // Build adjacency for hover-dim BFS
    let adjacency = new Map();
    // edgeCountByNode is rebuilt alongside adjacency so both share the same
    // edgeVisibility filter — previously it was computed once at init over
    // ALL edges and never rebuilt when the user toggled edge types, leaving
    // hub damping / centrality coloring / top-connected list / disconnected
    // detection out of sync with what's actually drawn on screen.
    const edgeCountByNode = new Map();
    let maxEdgeCount = 1;
    function buildAdjacency() {
        adjacency = new Map();
        for (const n of nodes) adjacency.set(n.id, []);
        edgeCountByNode.clear();
        for (const edge of edges) {
            if (!edgeVisibility[edge.type]) continue;
            adjacency.get(edge.from).push(edge.to);
            adjacency.get(edge.to).push(edge.from);
            edgeCountByNode.set(edge.from, (edgeCountByNode.get(edge.from) || 0) + 1);
            edgeCountByNode.set(edge.to, (edgeCountByNode.get(edge.to) || 0) + 1);
        }
        maxEdgeCount = Math.max(1, ...edgeCountByNode.values());
        dbg('Adjacency rebuilt, visible edge types:', Object.entries(edgeVisibility).filter(([, v]) => v).map(([k]) => k).join(', '));
    }
    buildAdjacency();

    const nodeDegree = new Float64Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
        nodeDegree[i] = edgeCountByNode.get(i) || 0;
    }
    dbg(`ForceAtlas2 model: ${nodes.length} nodes, ${edges.length} edges`);

    // Injection frequency
    let maxInjectionCount = 0;
    const injectionCounts = new Map();
    for (const n of nodes) {
        const entry = graphEntries[n.id];
        const count = chatInjectionCounts.get(trackerKey(entry)) || 0;
        injectionCounts.set(n.id, count);
        if (count > maxInjectionCount) maxInjectionCount = count;
    }

    // Collect unique tags for filter dropdown
    const allTags = new Set();
    for (const n of nodes) {
        for (const t of n.tags) allTags.add(t);
    }
    const tagList = [...allTags].sort();

    // ========================================================================
    // Build text summary for screen readers
    // ========================================================================
    const typeCounts = { regular: 0, constant: 0, seed: 0, bootstrap: 0 };
    for (const n of nodes) typeCounts[n.type] = (typeCounts[n.type] || 0) + 1;

    const topConnected = [...edgeCountByNode.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([idx, count]) => `${escapeHtml(nodes[idx].title)} (${count} connections)`);

    const circularNames = circularPairs.map(key => {
        const [a, b] = key.split(',').map(Number);
        return `${escapeHtml(nodes[a].title)} &lt;-&gt; ${escapeHtml(nodes[b].title)}`;
    });

    let summaryHtml = `<p><strong>Totals:</strong> ${nodes.length} nodes, ${edges.length} edges</p>`;
    summaryHtml += `<p><strong>By type:</strong> ${typeCounts.regular} regular, ${typeCounts.constant} constant, ${typeCounts.seed} seed, ${typeCounts.bootstrap} bootstrap</p>`;
    if (topConnected.length > 0) {
        summaryHtml += `<p><strong>Most connected:</strong></p><ul>${topConnected.map(t => `<li>${t}</li>`).join('')}</ul>`;
    }
    if (circularNames.length > 0) {
        summaryHtml += `<p><strong>Circular requires:</strong></p><ul>${circularNames.map(t => `<li>${t}</li>`).join('')}</ul>`;
    } else {
        summaryHtml += `<p>No circular requires detected.</p>`;
    }

    // ========================================================================
    // Build popup DOM
    // ========================================================================
    const container = document.createElement('div');
    container.classList.add('dle-popup', 'dle-graph-popup');
    const circularWarning = circularPairs.length > 0
        ? `<p class="dle-error dle-text-sm">⚠ ${circularPairs.length} circular require pair(s) detected</p>`
        : '';

    const tagOptions = tagList.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');

    container.innerHTML = `
        <h3 class="dle-graph-title">Entry Relationship Graph (${nodes.length} nodes, ${edges.length} edges)</h3>
        ${circularWarning}
        <div class="dle-graph-toolbar">
            <div class="dle-graph-search-wrap">
                <input type="text" id="dle-graph-search" class="text_pole dle-graph-toolbar-input" placeholder="Search entries..." />
                <button id="dle-graph-search-clear" class="dle-graph-search-clear" title="Clear search" style="display:none;"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <select id="dle-graph-type-filter" class="text_pole dle-graph-toolbar-select">
                <option value="">All Types</option>
                <option value="regular">Regular</option>
                <option value="constant">Constant</option>
                <option value="seed">Seed</option>
                <option value="bootstrap">Bootstrap</option>
            </select>
            <select id="dle-graph-tag-filter" class="text_pole dle-graph-toolbar-select">
                <option value="">All Tags</option>
                ${tagOptions}
            </select>
            <span class="dle-graph-toolbar-sep"></span>
            <select id="dle-graph-color-mode" class="text_pole dle-graph-toolbar-select" title="Node color mode">
                <option value="type">Color: Type</option>
                <option value="priority">Color: Priority</option>
                <option value="centrality">Color: Connections</option>
                <option value="frequency">Color: Frequency</option>
                <option value="community">Color: Community</option>
                ${(() => {
                    const fds = (fieldDefinitions.length > 0 ? fieldDefinitions : DEFAULT_FIELD_DEFINITIONS).filter(fd => fd.gating?.enabled);
                    if (fds.length === 0) return '';
                    return `<optgroup label="Custom Fields">${fds.map(fd => `<option value="field:${fd.name}">${fd.label}</option>`).join('')}</optgroup>`;
                })()}
            </select>
            <span class="dle-graph-toolbar-sep"></span>
            <button id="dle-graph-settings-btn" class="menu_button dle-graph-toolbar-btn" title="Graph settings"><i class="fa-solid fa-gear"></i></button>
        </div>
        <div class="dle-graph-toolbar dle-gap-1 dle-graph-toolbar--secondary">
            <button id="dle-graph-back" class="menu_button dle-graph-toolbar-btn-wide dle-hidden dle-graph-back-btn" title="Exit Focus Tree (Esc)">← Back</button>
            <button id="dle-graph-hop-minus" class="menu_button dle-graph-toolbar-btn-wide dle-hidden dle-graph-hop-btn" title="Decrease hop depth">−</button>
            <span id="dle-graph-depth-display" class="dle-graph-depth-display dle-hidden"></span>
            <button id="dle-graph-hop-plus" class="menu_button dle-graph-toolbar-btn-wide dle-hidden dle-graph-hop-btn" title="Increase hop depth">+</button>
            <button id="dle-graph-fit" class="menu_button dle-graph-toolbar-btn" title="Fit to view (0)">Fit</button>
            <button id="dle-graph-unpin-all" class="menu_button dle-graph-toolbar-btn-wide" title="Unpin all nodes">Unpin All</button>
            <button id="dle-graph-reset" class="menu_button dle-graph-toolbar-btn" title="Reset simulation — re-randomize positions and restart physics">Reset</button>
            <span class="dle-graph-toolbar-sep"></span>
            <button id="dle-graph-export-png" class="menu_button dle-graph-toolbar-btn" title="Export as PNG">PNG</button>
            <button id="dle-graph-export-json" class="menu_button dle-graph-toolbar-btn" title="Export as JSON">JSON</button>
            <span class="dle-graph-toolbar-sep"></span>
            <button id="dle-graph-analyze" class="menu_button dle-graph-toolbar-btn" title="Find gaps in your vault — highlights orphans, weak bridges, and missing connections"><i class="fa-solid fa-magnifying-glass-chart"></i> Find Gaps</button>
        </div>
        <div class="dle-graph-legend" id="dle-graph-legend">
            <span class="dle-graph-legend-item" data-edge-type="link" role="button" tabindex="0" aria-label="Toggle link edges"><span style="color: #aac8ff;">—</span> Link</span>
            <span class="dle-graph-legend-item" data-edge-type="requires" role="button" tabindex="0" aria-label="Toggle requires edges"><span class="dle-success">—</span> Requires</span>
            <span class="dle-graph-legend-item" data-edge-type="excludes" role="button" tabindex="0" aria-label="Toggle excludes edges"><span class="dle-error">—</span> Excludes</span>
            <span class="dle-graph-legend-item" data-edge-type="cascade" role="button" tabindex="0" aria-label="Toggle cascade edges"><span class="dle-warning">—</span> Cascade</span>
        </div>
        <div class="dle-graph-canvas-wrap">
            <canvas id="dle-graph-canvas" class="dle-graph-canvas" tabindex="-1" width="900" height="550" aria-label="Force-directed graph showing ${nodes.length} vault entries and ${edges.length} relationships between them."></canvas>
            <div id="dle-graph-tooltip" class="dle-graph-tooltip"></div>
            <div id="dle-graph-context-menu" class="dle-graph-context-menu dle-hidden"></div>
            <div class="dle-graph-detail-panel" style="display:none;"></div>
            <div id="dle-graph-settings-panel" class="dle-graph-settings-panel dle-hidden">
                <div class="dle-graph-settings-titlebar" id="dle-graph-settings-titlebar">
                    <span><i class="fa-solid fa-gear"></i> Graph Settings</span>
                    <span class="dle-graph-settings-close" id="dle-graph-settings-panel-close" role="button" tabindex="0" aria-label="Close graph settings">&times;</span>
                </div>
                <div class="dle-graph-settings-body">
                    <div class="dle-graph-settings-row dle-gap-1">
                        <button class="menu_button dle-gs-preset" data-preset="compact" title="Dense cluster — high damping, tight repulsion. Good for 200+ entry vaults.">Compact</button>
                        <button class="menu_button dle-gs-preset" data-preset="balanced" title="General-purpose layout for most vaults.">Balanced</button>
                        <button class="menu_button dle-gs-preset" data-preset="spacious" title="Loose spread — easier to read individual nodes.">Spacious</button>
                        <button class="menu_button dle-gs-preset" data-preset="ginormous" title="Maximum spread — best for very large displays.">Ginormous</button>
                    </div>
                    <div class="dle-graph-settings-sep"></div>
                    <div class="dle-graph-settings-section-label">Display</div>
                    <div class="dle-graph-settings-row">
                        <label>Color By</label>
                        <select id="dle-gs-color-mode" class="text_pole dle-gs-compact-select">
                            <option value="type">Type</option>
                            <option value="priority">Priority</option>
                            <option value="centrality">Connections</option>
                            <option value="frequency">Frequency</option>
                            <option value="community">Community</option>
                            ${(() => {
                                const fds = (fieldDefinitions.length > 0 ? fieldDefinitions : DEFAULT_FIELD_DEFINITIONS).filter(fd => fd.gating?.enabled);
                                if (fds.length === 0) return '';
                                return `<optgroup label="Fields">${fds.map(fd => `<option value="field:${fd.name}">${fd.label}</option>`).join('')}</optgroup>`;
                            })()}
                        </select>
                    </div>
                    <div class="dle-graph-settings-row">
                        <label title="How node radius is computed">Node Size</label>
                        <select id="dle-gs-node-size-mode" class="text_pole dle-gs-compact-select">
                            <option value="centrality">Centrality</option>
                            <option value="priority">Priority</option>
                            <option value="uniform">Uniform</option>
                        </select>
                    </div>
                    <div class="dle-graph-settings-row">
                        <label>Show Labels</label>
                        <input type="checkbox" id="dle-gs-labels" />
                    </div>
                    <div class="dle-graph-settings-sep"></div>
                    <div class="dle-graph-settings-section-label">Hover</div>
                    <div class="dle-graph-settings-row">
                        <label title="How many connection hops from the hovered node remain visible">Reach</label>
                        <input type="range" id="dle-gs-hover-dim" min="-100" max="100" step="1" />
                        <span class="dle-gs-value" id="dle-gs-hover-dim-val"></span>
                    </div>
                    <div class="dle-graph-settings-row">
                        <label title="Exponential alpha falloff per hop — higher = sharper drop">Falloff</label>
                        <input type="range" id="dle-gs-hover-falloff" min="-100" max="100" step="1" />
                        <span class="dle-gs-value" id="dle-gs-hover-falloff-val"></span>
                    </div>
                    <div class="dle-graph-settings-sep"></div>
                    <div class="dle-graph-settings-section-label">Focus Mode</div>
                    <div class="dle-graph-settings-row">
                        <label title="Hops shown in Focus Tree mode — also adjustable with +/− while in focus mode">Tree Depth</label>
                        <input type="range" id="dle-gs-tree-depth" min="-100" max="100" step="1" />
                        <span class="dle-gs-value" id="dle-gs-tree-depth-val"></span>
                    </div>
                    <div class="dle-graph-settings-sep"></div>
                    <div class="dle-graph-settings-section-label">Edge Filtering</div>
                    <div class="dle-graph-settings-row">
                        <label title="Statistical significance threshold — lower hides weak connections">Pruning</label>
                        <input type="range" id="dle-gs-edge-filter" min="-100" max="100" step="1" />
                        <span class="dle-gs-value" id="dle-gs-edge-filter-val"></span>
                        <small id="dle-gs-edge-count" class="dle-dimmed dle-gs-edge-count"></small>
                    </div>
                    <div class="dle-graph-settings-sep"></div>
                    <details class="dle-graph-settings-advanced">
                        <summary>Advanced Physics</summary>
                        <div class="dle-graph-settings-row">
                            <label title="Push force between unconnected nodes">Repulsion</label>
                            <input type="range" id="dle-gs-repulsion" min="-100" max="100" step="1" />
                            <span class="dle-gs-value" id="dle-gs-repulsion-val"></span>
                        </div>
                        <div class="dle-graph-settings-row">
                            <label title="Pull toward canvas center">Gravity</label>
                            <input type="range" id="dle-gs-gravity" min="-100" max="100" step="1" />
                            <span class="dle-gs-value" id="dle-gs-gravity-val"></span>
                        </div>
                        <div class="dle-graph-settings-row">
                            <label title="Friction — higher = settle faster">Damping</label>
                            <input type="range" id="dle-gs-damping" min="-100" max="100" step="1" />
                            <span class="dle-gs-value" id="dle-gs-damping-val"></span>
                        </div>
                    </details>
                    <div class="dle-graph-settings-sep"></div>
                    <div class="dle-graph-settings-row dle-gap-1">
                        <button id="dle-gs-redraw" class="menu_button dle-gs-compact-btn" title="Clear saved positions and replay the BFS rollout animation">Redraw</button>
                        <button id="dle-gs-reset" class="menu_button dle-gs-compact-btn">Reset to Defaults</button>
                    </div>
                </div>
            </div>
        </div>
        <div class="dle-graph-footer">
            <small id="dle-graph-hints" class="dle-dimmed">Drag to move · Right-click for menu · Scroll to zoom · Click+drag to pan · Double-click to focus · 0 to fit</small>
            <details class="dle-text-sm dle-graph-sr-details">
                <summary class="dle-graph-sr-summary">Screen reader summary</summary>
                <div class="dle-graph-sr-content">${summaryHtml}</div>
            </details>
        </div>
    `;

    callGenericPopup(container, POPUP_TYPE.DISPLAY, '', { wide: true, large: true, allowVerticalScrolling: false });

    // Poll for canvas with layout wait
    let canvas = null;
    for (let attempt = 0; attempt < 20; attempt++) {
        canvas = document.getElementById('dle-graph-canvas');
        if (canvas && canvas.getBoundingClientRect().height > 0) break;
        canvas = null;
        await new Promise(r => setTimeout(r, 50));
    }
    if (!canvas) {
        dbg('ERROR: Canvas not found after polling — popup may have closed');
        return;
    }
    const ctx = canvas.getContext('2d');

    // Cache rect, initialize canvas
    let cachedRect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = cachedRect.width * dpr;
    canvas.height = cachedRect.height * dpr;
    ctx.scale(dpr, dpr);
    const W = cachedRect.width;
    const H = cachedRect.height;
    dbg(`Canvas initialized: ${W}x${H} CSS px, DPR=${dpr}, buffer=${canvas.width}x${canvas.height}`);

    // ========================================================================
    // Initial node positions (Weighted BFS + progressive reveal)
    // ========================================================================
    const springLen = 200;

    const disconnected = nodes.filter(n => (edgeCountByNode.get(n.id) || 0) === 0);
    const orphanCols = Math.ceil(Math.sqrt(disconnected.length));
    const orphanSpacing = 35;
    const orphanOriginX = W * 0.3 - orphanCols * orphanSpacing * 0.5;
    const orphanOriginY = H * 0.3 - Math.ceil(disconnected.length / orphanCols) * orphanSpacing * 0.5;
    for (let i = 0; i < disconnected.length; i++) {
        const n = disconnected[i];
        n.x = orphanOriginX + (i % orphanCols) * orphanSpacing;
        n.y = orphanOriginY + Math.floor(i / orphanCols) * orphanSpacing;
        n.vx = 0; n.vy = 0;
        n.orphan = true;
        n.hidden = true;
    }

    // Weighted adjacency for BFS placement
    const weightedAdj = new Map();
    for (const n of nodes) weightedAdj.set(n.id, []);
    for (const edge of edges) {
        const w = edge.weight || 1;
        weightedAdj.get(edge.from).push({ id: edge.to, weight: w });
        weightedAdj.get(edge.to).push({ id: edge.from, weight: w });
    }
    for (const [, neighbors] of weightedAdj) {
        neighbors.sort((a, b) => b.weight - a.weight);
    }

    // Find hub
    let hubId = 0, hubEdges = 0;
    for (const [id, count] of edgeCountByNode) {
        if (count > hubEdges) { hubId = id; hubEdges = count; }
    }

    // Weighted BFS from hub
    const placed = new Set();
    const revealOrder = [];
    const placeDist = springLen * 1.2;

    // BUG-AUDIT-H11: Pre-compute neighbor sets ONCE — reused for both placement and physics.
    // Was duplicated O(N²) as neighborSetsForPlace + neighborSets.
    const neighborSets = new Map();
    for (const n of nodes) {
        if (n.orphan) continue;
        neighborSets.set(n.id, new Set((adjacency.get(n.id) || [])));
    }

    // Pre-compute shared neighbors for placement
    const sharedWith = new Map();
    for (const n of nodes) sharedWith.set(n.id, []);
    for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].orphan) continue;
        const setI = neighborSets.get(i);
        if (!setI || setI.size === 0) continue;
        for (let j = i + 1; j < nodes.length; j++) {
            if (nodes[j].orphan) continue;
            if (setI.has(j)) continue;
            const setJ = neighborSets.get(j);
            if (!setJ || setJ.size === 0) continue;
            let shared = 0;
            for (const nb of setI) { if (setJ.has(nb)) shared++; }
            if (shared > 0) {
                sharedWith.get(i).push({ id: j, shared });
                sharedWith.get(j).push({ id: i, shared });
            }
        }
    }

    // Place hub at center
    nodes[hubId].x = 0; nodes[hubId].y = 0;
    nodes[hubId].vx = 0; nodes[hubId].vy = 0;
    nodes[hubId].hidden = true;
    placed.add(hubId);
    revealOrder.push(hubId);

    // BFS queue
    const bfsQueue = [hubId];
    let bfsHead = 0;
    let angleCounter = 0;

    while (bfsHead < bfsQueue.length) {
        const cur = bfsQueue[bfsHead++];
        const neighbors = weightedAdj.get(cur) || [];

        for (const nb of neighbors) {
            if (placed.has(nb.id) || nodes[nb.id].orphan) continue;

            let cx = 0, cy = 0, totalW = 0;

            // Direct placed neighbors
            for (const adj of (weightedAdj.get(nb.id) || [])) {
                if (!placed.has(adj.id)) continue;
                const w = adj.weight || 1;
                cx += nodes[adj.id].x * w;
                cy += nodes[adj.id].y * w;
                totalW += w;
            }

            // Shared-neighbor placed nodes
            for (const sn of (sharedWith.get(nb.id) || [])) {
                if (!placed.has(sn.id)) continue;
                const w = sn.shared * 0.5;
                cx += nodes[sn.id].x * w;
                cy += nodes[sn.id].y * w;
                totalW += w;
            }

            if (totalW > 0) {
                cx /= totalW;
                cy /= totalW;
            } else {
                cx = nodes[cur].x;
                cy = nodes[cur].y;
            }

            const angle = angleCounter * 2.399;
            const jitter = placeDist * 0.5 + (Math.random() - 0.5) * placeDist * 0.3;
            nodes[nb.id].x = cx + Math.cos(angle) * jitter;
            nodes[nb.id].y = cy + Math.sin(angle) * jitter;
            nodes[nb.id].vx = 0; nodes[nb.id].vy = 0;
            nodes[nb.id].hidden = true;

            placed.add(nb.id);
            revealOrder.push(nb.id);
            bfsQueue.push(nb.id);
            angleCounter++;
        }
    }

    // Any connected nodes not reached by BFS
    for (const n of nodes) {
        if (!placed.has(n.id) && !n.orphan) {
            const angle = angleCounter * 2.399;
            n.x = Math.cos(angle) * placeDist * 3;
            n.y = Math.sin(angle) * placeDist * 3;
            n.vx = 0; n.vy = 0;
            n.hidden = true;
            revealOrder.push(n.id);
            angleCounter++;
        }
    }

    // Build reveal batches
    const REVEAL_INTERVAL = 4;
    const MAX_BATCH_SIZE = 3;
    const revealBatches = [];
    for (let i = 0; i < revealOrder.length; i += MAX_BATCH_SIZE) {
        revealBatches.push(revealOrder.slice(i, i + MAX_BATCH_SIZE));
    }
    for (let b = 0; b < revealBatches.length; b++) {
        for (const id of revealBatches[b]) {
            nodes[id].revealBatchIdx = b;
            nodes[id].bfsDepth = b;
        }
    }
    if (disconnected.length > 0) {
        const orphanBatchIdx = revealBatches.length;
        for (const n of disconnected) { n.revealBatchIdx = orphanBatchIdx; n.bfsDepth = orphanBatchIdx; }
        revealBatches.push(disconnected.map(n => n.id));
    }

    // ========================================================================
    // Restore saved layout (skip progressive reveal if positions match)
    // ========================================================================
    let restoredLayout = false;
    const originalRevealBatches = revealBatches.map(b => [...b]); // Keep a copy for replay
    const saved = settings.graphSavedLayout;
    if (saved?.positions) {
        const pos = saved.positions;
        let matched = 0;
        for (const n of nodes) {
            const p = pos[n.title];
            if (p) { n.x = p.x; n.y = p.y; matched++; }
        }
        // Restore if ≥80% of nodes match saved positions
        if (matched >= nodes.length * 0.8) {
            restoredLayout = true;
            for (const n of nodes) {
                n.hidden = false;
                n._revealScale = 1;
                n.vx = 0; n.vy = 0;
                n.revealBatchIdx = null; // Mark as fully revealed so exitFocusTree doesn't re-hide
            }
            for (const e of edges) e._revealAlpha = 1;
            // Skip progressive reveal entirely
            revealBatches.length = 0;
            dbg(`Restored saved layout (${matched}/${nodes.length} nodes matched)`);
        } else {
            dbg(`Saved layout stale — only ${matched}/${nodes.length} matched, doing fresh reveal`);
        }
    }

    // Pre-compute link strength
    const linkStrengths = new Float64Array(edges.length);
    for (let e = 0; e < edges.length; e++) {
        const srcDeg = nodeDegree[edges[e].from] || 1;
        const tgtDeg = nodeDegree[edges[e].to] || 1;
        linkStrengths[e] = 1 / Math.min(srcDeg, tgtDeg);
    }

    // Pre-compute shared neighbors (virtual springs)
    // BUG-AUDIT-H11: neighborSets already computed above for placement — reuse here.
    const MAX_SHARED_PAIRS = 2000;
    const sharedNeighborPairs = [];
    outerLoop:
    for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].orphan) continue;
        const setI = neighborSets.get(i);
        if (!setI || setI.size === 0) continue;
        for (let j = i + 1; j < nodes.length; j++) {
            if (nodes[j].orphan) continue;
            if (setI.has(j)) continue;
            const setJ = neighborSets.get(j);
            if (!setJ || setJ.size === 0) continue;
            let shared = 0;
            for (const nb of setI) { if (setJ.has(nb)) shared++; }
            if (shared > 0) {
                sharedNeighborPairs.push({ a: i, b: j, shared });
                if (sharedNeighborPairs.length >= MAX_SHARED_PAIRS) break outerLoop;
            }
        }
    }
    dbg(`Shared-neighbor pairs: ${sharedNeighborPairs.length} (n+2 virtual springs)`);

    // BUG-AUDIT-H16: Pre-compute same-tag pairs with cap (same as sharedNeighborPairs)
    const tagPairs = [];
    const MAX_TAG_PAIRS = 2000;
    const lorebookTag = (settings.lorebookTag || 'lorebook').toLowerCase();
    outerTagLoop:
    for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].orphan) continue;
        const tagsI = nodes[i].tags.filter(t => t.toLowerCase() !== lorebookTag);
        if (tagsI.length === 0) continue;
        for (let j = i + 1; j < nodes.length; j++) {
            if (nodes[j].orphan) continue;
            const tagsJ = nodes[j].tags.filter(t => t.toLowerCase() !== lorebookTag);
            if (tagsJ.length === 0) continue;
            let shared = 0;
            for (const t of tagsI) { if (tagsJ.includes(t)) shared++; }
            if (shared > 0) {
                tagPairs.push({ a: i, b: j, shared });
                if (tagPairs.length >= MAX_TAG_PAIRS) break outerTagLoop;
            }
        }
    }
    dbg(`Tag pairs: ${tagPairs.length} (same-tag clustering springs)`);
    dbg(`Weighted BFS from "${nodes[hubId].title}" (${hubEdges} edges), ${revealBatches.length} batches, ${disconnected.length} orphans`);

    // ========================================================================
    // CSS-var-aware colors
    // ========================================================================
    const computedStyle = getComputedStyle(document.documentElement);
    const nodeColors = {
        constant: '#ff9800',
        seed: '#2196f3',
        bootstrap: '#9c27b0',
        regular: '#4caf50',
    };
    // BUG-361: edgeColors is rebuilt each frame inside readEdgeColors() so theme
    // swaps propagate to canvas-drawn edges without any theme-change event wiring.
    function readEdgeColors() {
        const cs = getComputedStyle(document.documentElement);
        return {
            link: '#aac8ff',
            requires: cs.getPropertyValue('--dle-success').trim() || '#4caf50',
            excludes: cs.getPropertyValue('--dle-error').trim() || '#f44336',
            cascade: cs.getPropertyValue('--dle-warning').trim() || '#ff9800',
        };
    }
    const edgeColors = readEdgeColors();

    // ========================================================================
    // Cleanup on popup close
    // ========================================================================
    const listenerAC = new AbortController();
    // BUG-351: Resolve the observe target unconditionally — fall back to document.body
    // so the MutationObserver (and its cleanup) always fires even when the .popup
    // ancestor lookup races/fails.
    // BUG-364: Prefer the closest .popup child-list observer over subtree on body.
    const popupContainer = canvas.closest('.popup') || container.parentElement;
    const observeTarget = popupContainer || document.body;
    // BUG-364: Only use subtree when we had to fall back to body; the .popup container
    // only needs childList (its direct children are tab panels / the canvas wrapper).
    const observeOptions = popupContainer
        ? { childList: true }
        : { childList: true, subtree: true };
    const observer = new MutationObserver(() => {
        if (!canvas.isConnected) {
            dbg('Canvas removed from DOM — cleaning up graph');
            gs.isRunning = false;
            if (gs.animationFrameId) { cancelAnimationFrame(gs.animationFrameId); gs.animationFrameId = null; }
            // Cancel pending fit timers to prevent stale callbacks
            for (const id of gs._fitTimers || []) clearTimeout(id);
            gs._fitTimers = [];
            if (layoutTimerInterval) { clearInterval(layoutTimerInterval); layoutTimerInterval = null; }
            listenerAC.abort();
            observer.disconnect();
        }
    });
    observer.observe(observeTarget, observeOptions);

    // Focus tree exit: press 'e' (handled in graph-events.js). ESC closes the popup
    // (ST default) and is no longer captured here.

    // ========================================================================
    // Shared graph state — passed to all sub-modules
    // ========================================================================
    const gs = {
        // Data
        nodes, edges, adjacency, edgeVisibility,
        edgeCountByNode, nodeDegree, maxEdgeCount,
        injectionCounts, maxInjectionCount,
        linkStrengths, tagPairs, sharedNeighborPairs,
        titleToIdx, circularPairs, typeCounts,
        multiVault,
        // Reveal
        revealBatches, revealedBatch: 0, revealFrameCounter: 0,
        REVEAL_INTERVAL, MAX_BATCH_SIZE,
        // Canvas
        canvas, ctx, W, H, dpr, cachedRect,
        // View
        panX: W / 2, panY: H / 2, zoom: 1,
        // Interaction
        dragNode: null, hoverNode: null,
        isPanning: false, panStartX: 0, panStartY: 0, panOriginX: 0, panOriginY: 0,
        // BUG-358: Set to true when user manually pans/zooms; suppresses replayReveal _fitTimers.
        _userPanned: false,
        hoverDistances: null,
        contextMenuNode: null, tempPinnedNode: null,
        settlingUntil: 0, // Set dynamically when layout overlay is shown
        releaseStabilizeFrames: 0, // G6: extra damping frames after drag release
        layoutSaved: restoredLayout, // Whether positions have been saved this session
        restoredLayout, // Whether we skipped reveal due to saved positions
        layoutNotice: restoredLayout ? '' : 'Laying out entries\u2026',
        simulationStartTime: restoredLayout ? 0 : Date.now(), // For 90s hard clamp
        onSettleComplete: null, // Set below after overlay is created
        // Simulation
        // BUG-352: Restored layouts get alpha=0 / hasSpringEnergy=false so physics
        // doesn't jiggle a perfectly-restored set of node positions. Fresh layouts
        // keep alpha=1.0 / hasSpringEnergy=true for normal force-directed settling.
        isRunning: true, alpha: restoredLayout ? 0 : 1.0,
        hasSpringEnergy: !restoredLayout, maxDelta: 0, simFrame: 0,
        // Graph state
        colorMode: settings.graphDefaultColorMode || 'type',
        searchQuery: '', typeFilter: '', tagFilter: '',
        showLabels: settings.graphShowLabels !== false,
        // Focus Tree
        focusTreeRoot: null, focusTreePhysics: false,
        // Rendering
        needsDraw: true, prevHoverNode: null,
        debugMouseX: 0, debugMouseY: 0,
        cachedVisibleCount: nodes.length,
        animationFrameId: null,
        // Colors
        nodeColors, edgeColors, computedStyle,
        // References
        settings, springLen,
        tooltipEl: document.getElementById('dle-graph-tooltip'),
        listenerAC,
        // Cross-module functions (set by init calls below)
        buildAdjacency: null, applyFilters: null, fitToView: null,
        getNodeColor: null, getNodeRadius: null,
        toScreen: null, toWorld: null,
        findNearest: null, hitRadius: null,
        computeHoverDistances: null,
        enterFocusTree: null, exitFocusTree: null,
        updateTooltip: null,
        // Accessibility
        reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        // Gap analysis
        _vaultIndex: graphEntries,
        gapAnalysis: null,
        gapAnalysisActive: false,
    };

    // Wire buildAdjacency as a gs method (updates gs.adjacency + degree-derived state)
    gs.buildAdjacency = () => {
        buildAdjacency();
        gs.adjacency = adjacency;
        gs.maxEdgeCount = maxEdgeCount;
        for (let i = 0; i < nodes.length; i++) {
            nodeDegree[i] = edgeCountByNode.get(i) || 0;
        }
    };

    // ========================================================================
    // Disparity filter — compute initial backbone
    // ========================================================================
    computeDisparityFilter(gs, settings.graphEdgeFilterAlpha ?? 0.05);
    gs.recomputeBackbone = (alpha) => {
        computeDisparityFilter(gs, alpha);
        gs.needsDraw = true;
    };
    dbg(`Disparity filter: ${gs._backboneCount}/${edges.length} backbone edges at alpha=${gs._disparityAlpha}`);

    // Louvain community detection
    computeLouvainCommunities(gs);
    const communityCount = gs.communities ? gs.communities.size : 0;
    dbg(`Louvain: ${communityCount} communities detected`);

    // ========================================================================
    // Initialize sub-modules
    // ========================================================================
    const render = initRender(gs);
    const focus = initFocus(gs, dbg);
    const physics = initPhysics(gs);
    const events = initEvents(gs, dbg);
    const graphSettings = initGraphSettings(gs, dbg);

    // Wire replayReveal — clears saved layout and replays the BFS rollout animation
    gs.replayReveal = () => {
        // Clear saved layout
        settings.graphSavedLayout = null;
        gs.layoutSaved = false;
        invalidateSettingsCache();
        saveSettingsDebounced();
        // Reset all nodes
        if (gs.focusTreeRoot) gs.exitFocusTree();
        for (const n of nodes) {
            n.pinned = false;
            n._treePinned = false;
            n.hidden = true;
            n._revealScale = 0;
            n.vx = 0; n.vy = 0;
        }
        for (const e of edges) e._revealAlpha = 0;
        // Restore reveal batches from original
        revealBatches.length = 0;
        for (const batch of originalRevealBatches) revealBatches.push([...batch]);
        gs.revealedBatch = 0;
        gs.revealFrameCounter = 0;
        gs.alpha = 1.0;
        gs.simFrame = 0;
        gs.simulationStartTime = Date.now();
        gs.settlingUntil = Date.now() + 91_000;
        gs.layoutSaved = false;
        gs.panX = gs.W / 2; gs.panY = gs.H / 2; gs.zoom = 1;
        gs.needsDraw = true;
        // Show calculating overlay
        gs.layoutNotice = 'Laying out entries\u2026';
        if (gs.updateTooltip) gs.updateTooltip();
        // Re-add overlay if not present
        if (layoutTimerInterval) { clearInterval(layoutTimerInterval); layoutTimerInterval = null; }
        if (!layoutOverlay && canvas.parentNode) {
            layoutOverlay = document.createElement('div');
            layoutOverlay.className = 'dle-graph-layout-overlay';
            layoutOverlay.innerHTML = `<div class="dle-graph-layout-overlay-text">
                <i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>
                <span class="dle-graph-layout-overlay-msg">Laying out entries\u2026 0s</span>
            </div>`;
            canvas.parentNode.appendChild(layoutOverlay);
        }
        const replayStart = Date.now();
        layoutTimerInterval = setInterval(() => {
            const msgEl = layoutOverlay?.querySelector('.dle-graph-layout-overlay-msg');
            if (msgEl) {
                const elapsed = Math.round((Date.now() - replayStart) / 1000);
                msgEl.textContent = `Laying out entries\u2026 ${elapsed}s`;
            }
        }, 1000);
        // Auto-fit 1s + 2s + 6s after redraw starts (don't wait for settle)
        // Store timer IDs so they can be cancelled on popup close.
        // BUG-358: Skip fit if user panned manually since the timer was scheduled.
        for (const id of gs._fitTimers || []) clearTimeout(id);
        gs._fitTimers = [
            setTimeout(() => { if (gs.isRunning && gs.fitToView && !gs._userPanned) gs.fitToView(true); }, 1000),
            setTimeout(() => { if (gs.isRunning && gs.fitToView && !gs._userPanned) gs.fitToView(true); }, 2000),
            setTimeout(() => { if (gs.isRunning && gs.fitToView && !gs._userPanned) gs.fitToView(true); }, 6000),
        ];
        dbg('Redraw: replaying BFS reveal animation');
    };

    // ========================================================================
    // Animation loop
    // ========================================================================
    function tick() {
        if (!gs.isRunning) return;
        // BUG-122: Belt-and-braces teardown. The MutationObserver is the primary
        // popup-close detector, but if the popup framework moves the canvas in a way
        // the observer misses (or the .popup ancestor lookup raced and we observed
        // the wrong target), the animation loop is the only thing still ticking. When
        // the canvas is gone, abort listenerAC so document-level keydown/click handlers
        // can never outlive the popup, cancel pending fit timers, and stop layout interval.
        if (!canvas.isConnected || !document.getElementById('dle-graph-canvas')) {
            gs.isRunning = false;
            if (gs.animationFrameId) { cancelAnimationFrame(gs.animationFrameId); gs.animationFrameId = null; }
            for (const id of gs._fitTimers || []) clearTimeout(id);
            gs._fitTimers = [];
            if (layoutTimerInterval) { clearInterval(layoutTimerInterval); layoutTimerInterval = null; }
            try { listenerAC.abort(); } catch (e) { /* already aborted */ }
            try { observer.disconnect(); } catch (e) { /* already disconnected */ }
            return;
        }
        physics.simulate();

        // --- Animated fit: smooth pan/zoom lerp ---
        if (gs._fitAnim && focus.stepFitAnimation()) {
            gs.needsDraw = true;
        }

        // --- Ego-centric focus: smooth position lerp ---
        if (gs._egoLerpActive && focus.lerpEgoPositions()) {
            gs.needsDraw = true;
            gs.hasSpringEnergy = true;
        }

        // --- Entrance animation: lerp reveal scales each frame ---
        let anyRevealing = false;
        if (gs.reducedMotion) {
            // Accessibility: snap reveal scales to 1 immediately
            for (const n of gs.nodes) {
                if (n.hidden || n._revealScale >= 1) continue;
                n._revealScale = 1;
            }
            for (const e of gs.edges) {
                if (e._revealAlpha < 1) e._revealAlpha = 1;
            }
        } else {
            for (const n of gs.nodes) {
                if (n.hidden || n._revealScale >= 1) continue;
                n._revealScale += (1 - n._revealScale) * 0.15;
                if (n._revealScale > 0.995) n._revealScale = 1;
                else anyRevealing = true;
            }
            for (const e of gs.edges) {
                const fromScale = gs.nodes[e.from]._revealScale;
                const toScale = gs.nodes[e.to]._revealScale;
                if (fromScale > 0.5 && toScale > 0.5) {
                    e._revealAlpha += (1 - e._revealAlpha) * 0.1;
                    if (e._revealAlpha > 0.99) e._revealAlpha = 1;
                    else anyRevealing = true;
                }
            }
        }
        if (anyRevealing) { gs.needsDraw = true; gs.hasSpringEnergy = true; }

        const hoverChanged = gs.hoverNode !== gs.prevHoverNode;
        gs.prevHoverNode = gs.hoverNode;
        if (gs.hasSpringEnergy || gs.maxDelta > 0.01 || gs.dragNode || hoverChanged || gs.needsDraw) {
            // BUG-361: Refresh edge colors each frame so theme swaps propagate to
            // canvas-drawn edges. getComputedStyle is cheap relative to a full draw.
            gs.edgeColors = readEdgeColors();
            render.draw();
            if (hoverChanged) render.updateTooltip();
            gs.needsDraw = false;
        }

        gs.animationFrameId = requestAnimationFrame(tick);
    }

    // ========================================================================
    // Layout overlay — blocks input and shows progress during settling
    // ========================================================================
    let layoutOverlay = null;
    let layoutTimerInterval = null;
    if (!restoredLayout) {
        layoutOverlay = document.createElement('div');
        layoutOverlay.className = 'dle-graph-layout-overlay';
        layoutOverlay.innerHTML = `<div class="dle-graph-layout-overlay-text">
            <i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>
            <span class="dle-graph-layout-overlay-msg">Laying out entries\u2026 0s</span>
        </div>`;
        canvas.parentNode.style.position = 'relative'; // ensure overlay positioning works
        canvas.parentNode.appendChild(layoutOverlay);
        gs.settlingUntil = Date.now() + 91_000; // slightly beyond the 90s hard clamp
        const layoutStart = Date.now();
        layoutTimerInterval = setInterval(() => {
            const msgEl = layoutOverlay?.querySelector('.dle-graph-layout-overlay-msg');
            if (msgEl) {
                const elapsed = Math.round((Date.now() - layoutStart) / 1000);
                msgEl.textContent = `Laying out entries\u2026 ${elapsed}s`;
            }
        }, 1000);
    }

    gs.onSettleComplete = () => {
        // Remove overlay, clear notice, show "Layout saved" briefly, auto-fit
        if (layoutTimerInterval) { clearInterval(layoutTimerInterval); layoutTimerInterval = null; }
        if (layoutOverlay) {
            layoutOverlay.remove();
            layoutOverlay = null;
        }
        gs.settlingUntil = 0;
        gs.layoutNotice = '\u2713 Layout saved';
        if (gs.updateTooltip) gs.updateTooltip();
        requestAnimationFrame(() => {
            const el = gs.tooltipEl?.querySelector('.dle-graph-layout-notice');
            if (el) el.classList.add('dle-fade-out');
        });
        // BUG-133: Track the 4s notice-clear timer in _fitTimers so MutationObserver
        // teardown cancels it. Otherwise a stale callback can fire on a destroyed gs.
        if (!gs._fitTimers) gs._fitTimers = [];
        gs._fitTimers.push(setTimeout(() => {
            if (!gs.isRunning) return;
            if (gs.layoutNotice === '\u2713 Layout saved') {
                gs.layoutNotice = '';
                if (gs.updateTooltip) gs.updateTooltip();
            }
        }, 4000));
        if (gs.fitToView && !gs._userPanned) gs.fitToView(true);
    };

    // ========================================================================
    // Start
    // ========================================================================
    render.updateTooltip(); // Show color legend on load (includes layoutNotice)
    tick();

    // Auto-fit: restored = quick, fresh reveal = 1s + 2s + 6s so nodes have spread out
    // Store timer IDs in _fitTimers so MutationObserver cleanup can cancel them
    if (!gs._fitTimers) gs._fitTimers = [];
    // BUG-358: Guard all startup fit timers with !gs._userPanned so a manual pan
    // before the timer fires doesn't snap the view back.
    if (restoredLayout) {
        gs._fitTimers.push(setTimeout(() => { if (gs.isRunning && !gs._userPanned) gs.fitToView(true); }, 150));
    } else {
        gs._fitTimers.push(setTimeout(() => { if (gs.isRunning && !gs._userPanned) gs.fitToView(true); }, 1000));
        gs._fitTimers.push(setTimeout(() => { if (gs.isRunning && !gs._userPanned) gs.fitToView(true); }, 2000));
        gs._fitTimers.push(setTimeout(() => { if (gs.isRunning && !gs._userPanned) gs.fitToView(true); }, 6000));
    }
}
