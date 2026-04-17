/**
 * DeepLore Enhanced — Graph rendering module.
 * Canvas drawing: edges, nodes, labels, tooltip, color legend.
 */
import { vaultIndex, lastHealthResult } from './shims/state.js';
import { COMMUNITY_PALETTE, convexHull } from './graph-analysis.js';

// Local escapeHtml — avoids ST import so this module remains Node.js-testable
const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ============================================================================
// Pure helpers (no state dependency)
// ============================================================================

/**
 * Convert a hex color to a lighter pastel version if it's dark (luminance < 0.65).
 * @param {string} hex  Hex color string (e.g. '#4e79a7')
 * @param {number} [mix=0.25]  Blend amount toward white (0 = unchanged, 1 = white)
 * @returns {string} Hex color string
 */
export function toPastel(hex, mix = 0.25) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    if (lum >= 0.65) return hex;
    const pr = Math.round(r + (255 - r) * mix);
    const pg = Math.round(g + (255 - g) * mix);
    const pb = Math.round(b + (255 - b) * mix);
    return `#${pr.toString(16).padStart(2, '0')}${pg.toString(16).padStart(2, '0')}${pb.toString(16).padStart(2, '0')}`;
}

/** Priority-based color (lower priority = warmer). */
function priorityColor(priority) {
    const p = Math.max(0, Math.min(100, priority || 50));
    if (p <= 25) return '#e53935';
    if (p <= 40) return '#ff9800';
    if (p <= 55) return '#ffeb3b';
    if (p <= 75) return '#66bb6a';
    return '#42a5f5';
}

/** Centrality-based color (more connections = warmer). */
function centralityColor(edgeCount, maxEdgeCount) {
    const ratio = maxEdgeCount > 0 ? edgeCount / maxEdgeCount : 0;
    if (ratio > 0.7) return '#e53935';
    if (ratio > 0.4) return '#ff9800';
    if (ratio > 0.2) return '#ffeb3b';
    if (ratio > 0.05) return '#66bb6a';
    return '#42a5f5';
}

/** Injection frequency color (hot red → cold blue). */
function frequencyColor(count, maxCount) {
    if (!maxCount) return '#4a6fa5';
    const ratio = count / maxCount;
    if (ratio > 0.7) return '#e53935';
    if (ratio > 0.4) return '#e87040';
    if (ratio > 0.15) return '#b08a50';
    if (ratio > 0) return '#6a8db8';
    return '#4a6fa5';
}

/**
 * Lighten a hex color by blending toward white.
 * @param {string} hex  Hex color string
 * @param {number} amount  Blend amount (0 = unchanged, 1 = white)
 * @returns {string} CSS rgb() color string
 */
export function lightenColor(hex, amount) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgb(${Math.min(255, Math.round(r + (255 - r) * amount))}, ${Math.min(255, Math.round(g + (255 - g) * amount))}, ${Math.min(255, Math.round(b + (255 - b) * amount))})`;
}

/**
 * Darken a hex color by blending toward black.
 * @param {string} hex  Hex color string
 * @param {number} amount  Blend amount (0 = unchanged, 1 = black)
 * @returns {string} CSS rgb() color string
 */
export function darkenColor(hex, amount) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgb(${Math.round(r * (1 - amount))}, ${Math.round(g * (1 - amount))}, ${Math.round(b * (1 - amount))})`;
}

// ============================================================================
// Public API — call initRender(gs) after graph state is ready
// ============================================================================

/**
 * @param {object} gs  Shared graph state
 * @returns {{ draw, getNodeColor, getNodeRadius, toScreen, toWorld, updateTooltip, buildColorLegend }}
 */
export function initRender(gs) {

    function toScreen(x, y) { return { x: x * gs.zoom + gs.panX, y: y * gs.zoom + gs.panY }; }
    function toWorld(sx, sy) { return { x: (sx - gs.panX) / gs.zoom, y: (sy - gs.panY) / gs.zoom }; }

    // Custom field color palette (deterministic hash-based assignment)
    const FIELD_COLOR_PALETTE = [
        '#e53935', '#43a047', '#1e88e5', '#fb8c00', '#8e24aa',
        '#00acc1', '#d81b60', '#7cb342', '#5e35b1', '#f4511e',
        '#039be5', '#c0ca33', '#6d4c41', '#00897b', '#3949ab',
    ];
    const fieldColorCache = new Map();
    function ensureFieldIndex(fieldName) {
        if (fieldColorCache.has(`__idx__${fieldName}`)) return;
        const uniqueVals = new Set();
        for (const node of gs.nodes) {
            const val = gs._vaultIndex?.[node.id]?.customFields?.[fieldName];
            if (val != null) {
                if (Array.isArray(val)) val.forEach(v => uniqueVals.add(v));
                else uniqueVals.add(String(val));
            }
        }
        const sorted = [...uniqueVals].sort();
        const map = new Map();
        sorted.forEach((v, i) => map.set(v, FIELD_COLOR_PALETTE[i % FIELD_COLOR_PALETTE.length]));
        fieldColorCache.set(`__idx__${fieldName}`, map);
    }
    function fieldValueColor(fieldName, value) {
        const key = `${fieldName}:${value}`;
        if (fieldColorCache.has(key)) return fieldColorCache.get(key);
        ensureFieldIndex(fieldName);
        const map = fieldColorCache.get(`__idx__${fieldName}`);
        const c = map.get(value) || '#888888';
        fieldColorCache.set(key, c);
        return c;
    }

    function getNodeColor(n) {
        if (n === gs.hoverNode) return '#ffffff';
        let color;
        // Custom field coloring: "field:era", "field:location", etc.
        if (gs.colorMode?.startsWith('field:')) {
            const fieldName = gs.colorMode.slice(6);
            const val = gs._vaultIndex?.[n.id]?.customFields?.[fieldName];
            if (val == null || (Array.isArray(val) && val.length === 0)) {
                color = '#555555'; // no value → grey
            } else {
                const displayVal = Array.isArray(val) ? val[0] : String(val);
                color = fieldValueColor(fieldName, displayVal);
            }
            return toPastel(color);
        }
        switch (gs.colorMode) {
            case 'priority': color = priorityColor(n.priority); break;
            case 'centrality': color = centralityColor(gs.edgeCountByNode.get(n.id) || 0, gs.maxEdgeCount); break;
            case 'frequency': color = frequencyColor(gs.injectionCounts.get(n.id) || 0, gs.maxInjectionCount); break;
            case 'community': color = COMMUNITY_PALETTE[(n.community ?? 0) % COMMUNITY_PALETTE.length]; break;
            default: color = gs.nodeColors[n.type] || '#4caf50'; break;
        }
        return toPastel(color);
    }

    function getNodeRadius(n) {
        const connections = gs.edgeCountByNode.get(n.id) || 0;
        return Math.max(7, Math.min(22, 7 + Math.sqrt(connections / gs.maxEdgeCount) * 15));
    }

    /** Wrap legend HTML with adaptive font scaling for many items */
    function wrapLegendScaled(html, count) {
        // ≤8: inherit, 9-15: 0.6em, 16-25: 0.55em, 26+: 0.5em (floor)
        if (count <= 8) return html;
        const em = count <= 15 ? '0.6em' : count <= 25 ? '0.55em' : '0.5em';
        return `<span style="font-size:${em}">${html}</span>`;
    }

    /** Safety cap + expand toggle for overflowing legends */
    const LEGEND_SAFETY_CAP = 50;
    function capLegendItems(items, cap = LEGEND_SAFETY_CAP) {
        if (items.length <= cap) return items.join('');
        return items.slice(0, cap).join('') + `<span class="dle-dimmed">+${items.length - cap} more</span>`;
    }

    function buildColorLegend() {
        switch (gs.colorMode) {
            case 'type': {
                const items = [
                    ['Constant', toPastel(gs.nodeColors.constant)],
                    ['Seed', toPastel(gs.nodeColors.seed)],
                    ['Bootstrap', toPastel(gs.nodeColors.bootstrap)],
                    ['Regular', toPastel(gs.nodeColors.regular)],
                ];
                return items.map(([label, color]) =>
                    `<span class="dle-graph-legend-swatch"><span class="dle-graph-swatch-dot" style="background:${color};"></span>${label}</span>`
                ).join('');
            }
            case 'priority':
                return `<span class="dle-graph-legend-gradient">Priority:
                    <span>High</span>
                    <span class="dle-graph-legend-gradient-bar" style="background:linear-gradient(to right,${toPastel('#e53935')},${toPastel('#ff9800')},#ffeb3b,${toPastel('#66bb6a')},${toPastel('#42a5f5')});"></span>
                    <span>Low</span>
                </span>`;
            case 'centrality':
                return `<span class="dle-graph-legend-gradient">Connections:
                    <span>Many</span>
                    <span class="dle-graph-legend-gradient-bar" style="background:linear-gradient(to right,${toPastel('#e53935')},${toPastel('#ff9800')},#ffeb3b,${toPastel('#66bb6a')},${toPastel('#42a5f5')});"></span>
                    <span>Few</span>
                </span>`;
            case 'frequency':
                return `<span class="dle-graph-legend-gradient">Injections:
                    <span>Frequent</span>
                    <span class="dle-graph-legend-gradient-bar" style="background:linear-gradient(to right,${toPastel('#e53935')},${toPastel('#e87040')},${toPastel('#b08a50')},${toPastel('#6a8db8')},${toPastel('#4a6fa5')});"></span>
                    <span>Never</span>
                </span>`;
            case 'community': {
                if (!gs.communities || gs.communities.size === 0) return '<span>No communities detected</span>';
                const items = [];
                for (const [, cm] of gs.communities) {
                    if (cm.members.length === 0) continue;
                    items.push(`<span class="dle-graph-legend-swatch"><span class="dle-graph-swatch-dot" style="background:${toPastel(cm.color)};"></span>${escapeHtml(cm.label)} (${cm.members.length})</span>`);
                }
                const html = capLegendItems(items);
                return wrapLegendScaled(html, items.length);
            }
            default: {
                // Custom field color mode: "field:era", "field:mood", etc.
                if (gs.colorMode?.startsWith('field:')) {
                    const fieldName = gs.colorMode.slice(6);
                    ensureFieldIndex(fieldName);
                    const idx = fieldColorCache.get(`__idx__${fieldName}`);
                    if (!idx || idx.size === 0) return `<span>No "${escapeHtml(fieldName)}" values found in vault</span>`;
                    const items = [];
                    // Field name header
                    items.push(`<span class="dle-graph-field-label">${escapeHtml(fieldName)}</span>`);
                    for (const [val, c] of idx) {
                        items.push(`<span class="dle-graph-legend-swatch"><span class="dle-graph-swatch-dot" style="background:${toPastel(c)};"></span>${escapeHtml(val)}</span>`);
                    }
                    // "No value" indicator for grey nodes
                    items.push(`<span class="dle-graph-legend-swatch dle-graph-legend-swatch--empty"><span class="dle-graph-swatch-dot" style="background:#555555;"></span>No value</span>`);
                    const count = items.length - 1; // exclude field-label header from count
                    const html = capLegendItems(items);
                    return wrapLegendScaled(html, count);
                }
                return '';
            }
        }
    }

    /** Append layout status notice (Calculating / Layout saved) to legend HTML */
    function withLayoutNotice(legendHtml) {
        if (!gs.layoutNotice) return legendHtml;
        return `${legendHtml}<span class="dle-graph-layout-notice">${gs.layoutNotice}</span>`;
    }

    function updateTooltip() {
        const tooltipEl = gs.tooltipEl;
        if (!tooltipEl) return;
        if (!gs.hoverNode || gs.hoverNode.hidden) {
            tooltipEl.classList.add('dle-graph-tooltip--legend');
            tooltipEl.classList.remove('dle-graph-tooltip--expanded');
            const legendHtml = withLayoutNotice(buildColorLegend()) || '&nbsp;';
            // Add expand toggle if legend content will likely overflow
            const swatchCount = (legendHtml.match(/dle-graph-legend-swatch/g) || []).length;
            const expandToggle = swatchCount > 8
                ? `<span class="dle-graph-legend-toggle" title="Click to expand/collapse legend">&#x25BC;</span>`
                : '';
            tooltipEl.innerHTML = legendHtml + expandToggle;
            return;
        }
        tooltipEl.classList.remove('dle-graph-tooltip--legend', 'dle-graph-tooltip--expanded');
        const n = gs.hoverNode;
        const entry = gs._vaultIndex?.[n.id];
        const connections = gs.edgeCountByNode.get(n.id) || 0;
        const injections = gs.injectionCounts.get(n.id) || 0;
        const vaultLabel = gs.multiVault && n.vaultSource ? `<span class="dle-dimmed">[${escapeHtml(n.vaultSource)}]</span>` : '';
        const typeBadge = `<span class="dle-graph-tooltip-badge dle-graph-tooltip-badge--${n.type}">${n.type}</span>`;

        let healthBadge = '';
        if (lastHealthResult) {
            const issues = (lastHealthResult.issues || []).filter(i => i.entry === n.title);
            if (issues.length > 0) {
                const worst = issues.some(i => i.severity === 'error') ? 'error' : 'warning';
                healthBadge = `<span class="dle-graph-tooltip-badge dle-graph-tooltip-badge--${worst}">${issues.length} issue${issues.length > 1 ? 's' : ''}</span>`;
            }
        }

        const pinnedLabel = (n.pinned && !n._treePinned) ? '<span class="dle-graph-tooltip-badge dle-graph-tooltip-badge--pinned">pinned</span>' : '';
        const gatingFields = [];
        if (entry.customFields) {
            const activeColorField = gs.colorMode?.startsWith('field:') ? gs.colorMode.slice(6) : null;
            for (const [key, val] of Object.entries(entry.customFields)) {
                if (val != null && val !== '' && (!Array.isArray(val) || val.length > 0)) {
                    let display = Array.isArray(val) ? val.join(', ') : String(val);
                    // Note when multi-value field is colored by first value only
                    if (key === activeColorField && Array.isArray(val) && val.length > 1) {
                        display = `${val[0]} (+${val.length - 1} more)`;
                    }
                    gatingFields.push(`${escapeHtml(key)}: ${escapeHtml(display)}`);
                }
            }
        }
        // Use line breaks for 3+ fields, dot separator for fewer
        const fieldsSeparator = gatingFields.length >= 3 ? '<br>' : ' · ';
        tooltipEl.innerHTML = `
            <strong>${escapeHtml(n.title)}</strong> ${vaultLabel}
            ${typeBadge}${healthBadge}${pinnedLabel}
            <span class="dle-graph-tooltip-stats">~${n.tokens} tokens · Priority ${entry.priority} · ${connections} connections · ${injections} injections</span>
            ${gatingFields.length > 0 ? `<span class="dle-graph-tooltip-gating">${gatingFields.join(fieldsSeparator)}</span>` : ''}
        `;
    }

    function draw() {
        const { ctx, W, nodes, edges, edgeVisibility, edgeColors, hoverDistances, hoverNode,
                focusTreeRoot, colorMode, showLabels, searchQuery, typeFilter, tagFilter,
                zoom, settings, injectionCounts, maxInjectionCount, computedStyle } = gs;
        ctx.clearRect(0, 0, W, gs.H);

        // Draw community hulls (behind everything)
        if (colorMode === 'community' && gs.communities && gs.communities.size > 0) {
            for (const [, cm] of gs.communities) {
                if (cm.members.length < 3) continue;
                // Collect screen positions of visible members
                const pts = [];
                for (const n of cm.members) {
                    if (n.hidden || n._revealScale < 0.3) continue;
                    const s = toScreen(n.x, n.y);
                    pts.push({ x: s.x, y: s.y });
                }
                if (pts.length < 3) continue;
                const hull = convexHull(pts);
                if (hull.length < 3) continue;

                // Expand hull by padding for visual breathing room
                const pad = 20 * zoom;
                let hcx = 0, hcy = 0;
                for (const p of hull) { hcx += p.x; hcy += p.y; }
                hcx /= hull.length; hcy /= hull.length;
                const expanded = hull.map(p => {
                    const dx = p.x - hcx, dy = p.y - hcy;
                    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                    return { x: p.x + (dx / dist) * pad, y: p.y + (dy / dist) * pad };
                });

                // Draw with quadratic Bezier smoothing
                ctx.globalAlpha = 0.12;
                ctx.fillStyle = cm.color;
                ctx.beginPath();
                const last = expanded[expanded.length - 1];
                const first = expanded[0];
                ctx.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2);
                for (let i = 0; i < expanded.length; i++) {
                    const curr = expanded[i];
                    const next = expanded[(i + 1) % expanded.length];
                    ctx.quadraticCurveTo(curr.x, curr.y, (curr.x + next.x) / 2, (curr.y + next.y) / 2);
                }
                ctx.closePath();
                ctx.fill();

                // Community label at centroid — scales with zoom for readability
                const cs = toScreen(cm.cx, cm.cy);
                const communityFontSize = Math.max(8, Math.min(24, 14 * zoom));
                ctx.globalAlpha = Math.min(0.6, 0.2 + zoom * 0.4);
                ctx.fillStyle = cm.color;
                ctx.font = `bold ${communityFontSize}px system-ui, -apple-system, sans-serif`;
                ctx.textAlign = 'center';
                ctx.fillText(cm.label, cs.x, cs.y);
            }
            ctx.globalAlpha = 1;
        }

        // Batch edges by type
        const edgesByType = { link: [], requires: [], excludes: [], cascade: [] };
        for (const edge of edges) {
            if (!edgeVisibility[edge.type]) continue;
            if (nodes[edge.from].hidden || nodes[edge.to].hidden) continue;
            if (edge._revealAlpha < 0.01) continue; // entrance animation: skip unrevealed edges
            (edgesByType[edge.type] || (edgesByType[edge.type] = [])).push(edge);
        }

        // Track drawn dim pairs to avoid multi-edge alpha stacking on hover
        const drawnDimPairs = hoverDistances ? new Set() : null;

        // Hub damping: applied to n+2+ edges when the hovered node has many
        // connections (additive compounding effect). n+1 gets a separate, very
        // gentle tilt — tiny bump for sparse nodes, tiny cut for dense ones,
        // centered at degree 5.
        let hubDamp = 1;
        let n1Tilt = 1;
        if (hoverDistances && gs.hoverNode) {
            const deg = gs.edgeCountByNode.get(gs.hoverNode.id) || 0;
            if (deg > 8) hubDamp = 1 / (1 + (deg - 8) * 0.05);
            n1Tilt = Math.max(0.75, Math.min(1.70, 1 + (5 - deg) * 0.13));
        }


        for (const [type, edgeList] of Object.entries(edgesByType)) {
            if (edgeList.length === 0) continue;
            ctx.strokeStyle = edgeColors[type] || '#555';
            if (type === 'excludes') { ctx.setLineDash([7, 5]); } else if (type === 'cascade') { ctx.setLineDash([2, 4]); } else if (type === 'requires') { ctx.setLineDash([12, 4]); } else { ctx.setLineDash([]); }

            for (const edge of edgeList) {
                const fromFiltered = nodes[edge.from].filtered;
                const toFiltered = nodes[edge.to].filtered;

                // Frequency mode: thicker edges for high-frequency nodes
                let freqAvg = 0;
                if (colorMode === 'frequency') {
                    const fromFreq = (injectionCounts.get(edge.from) || 0) / (maxInjectionCount || 1);
                    const toFreq = (injectionCounts.get(edge.to) || 0) / (maxInjectionCount || 1);
                    freqAvg = (fromFreq + toFreq) / 2;
                    ctx.lineWidth = 1 + freqAvg * 3;
                } else {
                    ctx.lineWidth = 2;
                }

                // Alpha priority: hover dim > focus tree depth > filtered > frequency/standard
                if (hoverDistances && focusTreeRoot && focusTreeRoot._treeEdgeIdx) {
                    if (!focusTreeRoot._treeEdgeIdx.has(edge._idx)) continue;
                    const dm = focusTreeRoot._depthMap;
                    const hid = hoverNode ? hoverNode.id : -1;
                    const touchesHover = (edge.from === hid || edge.to === hid);
                    const otherDepth = edge.from === hid ? (dm.get(edge.to) ?? 0) : (dm.get(edge.from) ?? 0);
                    const hoverDepth = dm.get(hid) ?? 0;
                    const isDownward = touchesHover && otherDepth > hoverDepth;
                    const isUpward = touchesHover && otherDepth < hoverDepth;
                    // Cache "node has downward child" set on the focus root once per focus
                    // session — replaces an O(E) edges.some() per edge (was O(E²) overall).
                    if (!focusTreeRoot._hasDownwardChildSet) {
                        const downSet = new Set();
                        for (const eIdx of focusTreeRoot._treeEdgeIdx) {
                            const e = edges[eIdx];
                            const dF = dm.get(e.from) ?? 0;
                            const dT = dm.get(e.to) ?? 0;
                            if (dF < dT) downSet.add(e.from);
                            else if (dT < dF) downSet.add(e.to);
                        }
                        focusTreeRoot._hasDownwardChildSet = downSet;
                    }
                    const isLeaf = !focusTreeRoot._hasDownwardChildSet.has(hid);
                    const highlight = isDownward || (isLeaf && isUpward);
                    ctx.globalAlpha = highlight ? 0.35 : 0.03;
                    ctx.lineWidth = highlight ? 3 : 1;
                } else if (hoverDistances) {
                    // "Mirrors and lasers": each hop transmits a fraction `t` of the energy.
                    // Edge brightness = min(E_from, E_to). Out-of-set edges fall back to ambient.
                    const t = settings.graphHoverFalloff ?? 0.55;
                    const ambient = settings.graphHoverAmbient ?? 0.06;
                    const du = hoverDistances.get(edge.from);
                    const dv = hoverDistances.get(edge.to);
                    const pairKey = `${Math.min(edge.from, edge.to)},${Math.max(edge.from, edge.to)}`;
                    if (drawnDimPairs.has(pairKey)) continue;
                    drawnDimPairs.add(pairKey);

                    if (du === undefined || dv === undefined) {
                        // Off-branch relative to hover — ducked below ambient
                        // so the hover branch visually pops against the rest.
                        ctx.globalAlpha = ambient * 0.55;
                        ctx.lineWidth = 1;
                        ctx.shadowBlur = 0;
                    } else {
                        const eF = Math.pow(t, du);
                        const eT = Math.pow(t, dv);
                        // Edge alpha: clamp n+1 at a lower max, then drop 30%
                        // per additional ring (compounding). n+1 is the cap;
                        // n+2 = 0.7*cap, n+3 = 0.49*cap, n+4 = 0.343*cap, etc.
                        const dEdge = Math.max(du, dv);
                        const HOVER_MAX = 0.40;
                        // Hub damping only applies from n+2 outward — when a
                        // hub is directly hovered, its n+1 edges stay at the
                        // full cap; damping is for edges further out in the
                        // branch where the additive effect compounds.
                        const damp = dEdge <= 1 ? n1Tilt : hubDamp;
                        const minE = damp * HOVER_MAX * Math.pow(0.6, Math.max(0, dEdge - 1));
                        const maxE = Math.max(eF, eT);
                        let alpha = minE * 0.95;
                        if (du === dv && du > 0) alpha *= 0.7; // same-ring sibling damp
                        if (alpha < ambient) alpha = ambient;
                        ctx.globalAlpha = alpha;
                        ctx.lineWidth = 1 + 2.5 * minE;
                        if (minE > 0.3) {
                            ctx.shadowColor = edgeColors[type] || '#aac8ff';
                            ctx.shadowBlur = Math.min(6, 6 * maxE);
                        } else {
                            ctx.shadowBlur = 0;
                        }
                    }
                } else if (focusTreeRoot && focusTreeRoot._treeEdgeIdx) {
                    if (!focusTreeRoot._treeEdgeIdx.has(edge._idx)) continue;
                    const dm = focusTreeRoot._depthMap;
                    const maxD = Math.max(dm.get(edge.from) ?? 0, dm.get(edge.to) ?? 0);
                    if (maxD === 0)      { ctx.globalAlpha = 0.6; ctx.lineWidth = 3; }
                    else if (maxD === 1) { ctx.globalAlpha = 0.35; ctx.lineWidth = 2; }
                    else                 { ctx.globalAlpha = 0.15; ctx.lineWidth = 1; }
                } else if (fromFiltered && toFiltered) {
                    ctx.globalAlpha = 0.06;
                } else if (fromFiltered || toFiltered) {
                    ctx.globalAlpha = 0.12;
                } else if (colorMode === 'frequency') {
                    ctx.globalAlpha = 0.2 + freqAvg * 0.6;
                } else if (edge._backbone === false) {
                    // Disparity-filtered: barely visible, revealed on hover
                    ctx.globalAlpha = 0.03;
                } else {
                    // Default-dim: backbone edges at low visibility, revealed on hover
                    ctx.globalAlpha = 0.08;
                }

                // Entrance animation: fade edges in with reveal progress
                if (edge._revealAlpha < 1) ctx.globalAlpha *= edge._revealAlpha;

                const a = toScreen(nodes[edge.from].x, nodes[edge.from].y);
                const b = toScreen(nodes[edge.to].x, nodes[edge.to].y);
                ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
            }
        }
        ctx.setLineDash([]); ctx.globalAlpha = 1; ctx.lineWidth = 1; ctx.shadowBlur = 0;

        // Draw nodes — flat circles, rendered AFTER edges
        const bgColor = computedStyle.getPropertyValue('--dle-bg-surface').trim() || '#1a1a2e';
        // Background mask pass
        for (const n of nodes) {
            if (n.hidden || n._revealScale < 0.01) continue;
            const s = toScreen(n.x, n.y);
            const r = getNodeRadius(n) * n._revealScale;
            ctx.globalAlpha = 1;
            ctx.fillStyle = bgColor;
            ctx.beginPath(); ctx.arc(s.x, s.y, (r + 1) * zoom, 0, Math.PI * 2); ctx.fill();
        }
        // Colored node pass
        for (const n of nodes) {
            if (n.hidden || n._revealScale < 0.01) continue;
            if (hoverDistances && focusTreeRoot && focusTreeRoot._depthMap) {
                const nd = focusTreeRoot._depthMap.get(n.id) ?? 99;
                ctx.globalAlpha = nd === 0 ? 1.0 : nd === 1 ? 1.0 : 0.6;
            } else if (hoverDistances) {
                const t = settings.graphHoverFalloff ?? 0.55;
                const ambient = settings.graphHoverAmbient ?? 0.06;
                const hopDist = hoverDistances.get(n.id);
                const energy = hopDist === undefined ? 0 : Math.pow(t, hopDist);
                ctx.globalAlpha = Math.max(energy, ambient);
            } else if (focusTreeRoot && focusTreeRoot._depthMap) {
                const nd = focusTreeRoot._depthMap.get(n.id) ?? 99;
                ctx.globalAlpha = nd === 0 ? 1.0 : nd === 1 ? 1.0 : 0.5;
            } else if (n.filtered) {
                ctx.globalAlpha = 0.12;
            } else {
                ctx.globalAlpha = 1;
            }
            const s = toScreen(n.x, n.y);
            const r = getNodeRadius(n) * n._revealScale;
            ctx.fillStyle = getNodeColor(n);
            ctx.beginPath(); ctx.arc(s.x, s.y, r * zoom, 0, Math.PI * 2); ctx.fill();
            if (focusTreeRoot === n) {
                ctx.strokeStyle = '#ffd700'; ctx.lineWidth = 3;
                ctx.beginPath(); ctx.arc(s.x, s.y, (r + 4) * zoom, 0, Math.PI * 2); ctx.stroke();
                ctx.lineWidth = 1;
            } else if (n.pinned && !n._treePinned) {
                ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
                ctx.beginPath(); ctx.arc(s.x, s.y, (r + 3) * zoom, 0, Math.PI * 2); ctx.stroke();
                ctx.lineWidth = 1;
            }
        }
        ctx.globalAlpha = 1;

        // Gap analysis overlay
        if (gs.gapAnalysisActive && gs.gapAnalysis) {
            const ga = gs.gapAnalysis;
            const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 600); // calm breathing pulse

            // Orphan nodes: pulsing red ring
            ctx.strokeStyle = '#e53935';
            ctx.lineWidth = 2.5;
            for (const id of ga.orphans) {
                const n = nodes[id];
                if (n.hidden) continue;
                const s = toScreen(n.x, n.y);
                const r = getNodeRadius(n) * (n._revealScale || 1);
                ctx.globalAlpha = 0.5 + pulse * 0.35;
                ctx.beginPath(); ctx.arc(s.x, s.y, (r + 6) * zoom, 0, Math.PI * 2); ctx.stroke();
            }

            // Weak bridges: dashed yellow highlight
            ctx.strokeStyle = '#ffd600';
            ctx.lineWidth = 3;
            ctx.setLineDash([6, 4]);
            ctx.globalAlpha = 0.7;
            for (const idx of ga.bridges) {
                const e = edges[idx];
                if (nodes[e.from].hidden || nodes[e.to].hidden) continue;
                const a = toScreen(nodes[e.from].x, nodes[e.from].y);
                const b = toScreen(nodes[e.to].x, nodes[e.to].y);
                ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
            }

            // Missing connections: faint dashed cyan lines
            if (ga.missingConnections.length > 0) {
                ctx.strokeStyle = '#00bcd4';
                ctx.lineWidth = 1;
                ctx.setLineDash([3, 6]);
                ctx.globalAlpha = 0.25;
                // Limit to 50 to avoid clutter
                const shown = ga.missingConnections.slice(0, 50);
                for (const mc of shown) {
                    const na = nodes[mc.a], nb = nodes[mc.b];
                    if (na.hidden || nb.hidden) continue;
                    const a = toScreen(na.x, na.y);
                    const b = toScreen(nb.x, nb.y);
                    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
                }
            }

            ctx.setLineDash([]); ctx.globalAlpha = 1; ctx.lineWidth = 1;

            // If pulsing, request redraw for animation
            gs.needsDraw = true;
        }

        // Draw labels
        if (showLabels) {
            ctx.font = `500 ${Math.max(9, 11 * zoom)}px system-ui, -apple-system, sans-serif`; ctx.textAlign = 'center';
            ctx.lineJoin = 'round';
            for (const n of nodes) {
                if (n.hidden || n._revealScale < 0.5) continue;
                if (n.filtered && !focusTreeRoot) continue;
                const inHoverSet = hoverDistances && hoverDistances.has(n.id);
                if (hoverDistances && !focusTreeRoot && !inHoverSet) continue;
                const s = toScreen(n.x, n.y);
                const isHub = (gs.edgeCountByNode.get(n.id) || 0) >= 5;
                const matchesFilter = (searchQuery || typeFilter || tagFilter) && !n.filtered;
                const hoverDist = inHoverSet ? hoverDistances.get(n.id) : null;
                const inHoverLabelSet = inHoverSet && hoverDist !== null && hoverDist <= 1;
                if (focusTreeRoot || inHoverLabelSet || zoom > 0.7 || (zoom > 0.4 && (isHub || matchesFilter))) {
                    if (inHoverLabelSet && !focusTreeRoot) {
                        const isHovered = n === hoverNode;
                        ctx.fillStyle = isHovered ? '#fff' : '#ddd';
                        ctx.globalAlpha = isHovered ? 1.0 : 0.85;
                    } else if (focusTreeRoot) {
                        const isHovered = n === hoverNode;
                        const treeEdgeSet = focusTreeRoot._depthMap?._treeEdges;
                        const isTreeNeighbor = isHovered ? false : (hoverNode && treeEdgeSet &&
                            treeEdgeSet.has(`${hoverNode.id}:${n.id}`) &&
                            (focusTreeRoot._depthMap.get(n.id) ?? 0) > (focusTreeRoot._depthMap.get(hoverNode.id) ?? 0));
                        const bright = isHovered || n === focusTreeRoot || isTreeNeighbor;
                        ctx.fillStyle = (isHovered || n === focusTreeRoot) ? '#fff' : isTreeNeighbor ? '#ccc' : '#888';
                        ctx.globalAlpha = bright ? 1.0 : 0.6;
                    } else {
                        ctx.fillStyle = '#ddd';
                        ctx.globalAlpha = 1;
                    }
                    const labelOffset = (getNodeRadius(n) + 4) * zoom;
                    // Hop distance tag for nodes in the hover branch (skip the
                    // hovered node itself at distance 0).
                    const labelText = (inHoverSet && hoverDist && hoverDist > 0)
                        ? `${n.title} [+${hoverDist}]`
                        : n.title;
                    // Dark outline for readability over any background
                    ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
                    ctx.lineWidth = 3;
                    ctx.strokeText(labelText, s.x, s.y - labelOffset);
                    ctx.fillText(labelText, s.x, s.y - labelOffset);
                }
            }

            // Zoomed hover label — bold pill for the hovered node
            if (hoverNode && zoom < 0.8) {
                const hs = toScreen(hoverNode.x, hoverNode.y);
                const fontSize = Math.max(13, 14);
                ctx.save();
                ctx.font = `bold ${fontSize}px system-ui, -apple-system, sans-serif`;
                ctx.textAlign = 'center';
                ctx.fillStyle = '#fff';
                ctx.globalAlpha = 1;
                const textW = ctx.measureText(hoverNode.title).width;
                const pad = 4;
                const hoverLabelOffset = (getNodeRadius(hoverNode) + 6) * zoom;
                ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
                ctx.fillRect(hs.x - textW / 2 - pad, hs.y - hoverLabelOffset - fontSize + 2, textW + pad * 2, fontSize + pad);
                ctx.fillStyle = '#fff';
                ctx.fillText(hoverNode.title, hs.x, hs.y - hoverLabelOffset + 2);
                ctx.restore();
            }
        }
    }

    // Legend expand/collapse toggle click handler
    if (gs.tooltipEl) {
        gs.tooltipEl.addEventListener('click', (e) => {
            if (e.target.closest('.dle-graph-legend-toggle')) {
                gs.tooltipEl.classList.toggle('dle-graph-tooltip--expanded');
            }
        });
    }

    // Attach to gs for cross-module access
    gs.toScreen = toScreen;
    gs.toWorld = toWorld;
    gs.getNodeColor = getNodeColor;
    gs.getNodeRadius = getNodeRadius;
    gs.updateTooltip = updateTooltip;

    return { draw, getNodeColor, getNodeRadius, toScreen, toWorld, updateTooltip, buildColorLegend };
}
