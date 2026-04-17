/**
 * DeepLore Enhanced — Graph focus & navigation module.
 * Ego-centric focus mode: radial layout, BFS depth,
 * hover distances, search/filter, fit-to-view.
 */

// ============================================================================
// Public API — call initFocus(gs) after graph state is ready
// ============================================================================

/**
 * @param {object} gs  Shared graph state
 * @param {Function} dbg  Debug logger
 * @returns {{ bfsDepth, computeRadialLayout, enterFocusTree, exitFocusTree,
 *             computeHoverDistances, applyFilters, fitToView, findNearest, hitRadius }}
 */
export function initFocus(gs, dbg) {

    /** Find nearest node to world-space point within maxDist. Skips hidden nodes.
     *  Uses radius-aware distance so larger nodes have proportionally larger hitboxes.
     *  Applies a small downward offset to compensate for visual perception of dots. */
    function findNearest(wx, wy, maxDist, debugLabel) {
        const { nodes } = gs;
        const inFocusTree = !!gs.focusTreeRoot;
        let closest = null, closestDist = maxDist;
        let nearestAny = null, nearestAnyDist = Infinity;
        // Slight downward bias — users perceive node centers ~2px above geometric center
        const biasY = 2 / gs.zoom;
        for (const n of nodes) {
            if (n.hidden) continue;
            if (n.filtered && !inFocusTree) continue;
            const d = Math.sqrt((n.x - wx) ** 2 + (n.y + biasY - wy) ** 2);
            // Subtract node radius so clicks near the edge still hit
            const r = gs.getNodeRadius ? gs.getNodeRadius(n) : 0;
            const effectiveDist = Math.max(0, d - r);
            if (effectiveDist < closestDist) { closest = n; closestDist = effectiveDist; }
            if (d < nearestAnyDist) { nearestAny = n; nearestAnyDist = d; }
        }
        if (debugLabel && !closest && nearestAny) {
            dbg(`findNearest miss (${debugLabel}): nearest="${nearestAny.title}" at dist=${nearestAnyDist.toFixed(1)}, maxDist=${maxDist.toFixed(1)}`);
        }
        return closest;
    }

    function hitRadius() {
        if (gs.focusTreeRoot) return 16 / gs.zoom;
        // BUG-FIX: Guard against cachedVisibleCount=0 (division by zero → Infinity)
        if (gs.cachedVisibleCount <= 0) return 20 / gs.zoom;
        const baseRadius = Math.max(gs.W, gs.H) / (Math.sqrt(gs.cachedVisibleCount) * 2);
        return Math.max(8, Math.min(40, baseRadius / gs.zoom));
    }

    /**
     * BFS from root to maxDepth, returns Map<nodeId, depth>.
     * Uses full adjacency (ignores edge visibility toggles).
     */
    function bfsDepth(rootId, maxDepth) {
        const { nodes, edges } = gs;
        const fullAdj = new Map();
        for (const n of nodes) fullAdj.set(n.id, []);
        for (const edge of edges) {
            fullAdj.get(edge.from).push(edge.to);
            fullAdj.get(edge.to).push(edge.from);
        }
        const dist = new Map();
        const treeEdges = new Set();
        dist.set(rootId, 0);
        const queue = [rootId];
        let head = 0;
        while (head < queue.length) {
            const cur = queue[head++];
            const d = dist.get(cur);
            if (d >= maxDepth) continue;
            for (const nb of (fullAdj.get(cur) || [])) {
                if (!dist.has(nb)) {
                    dist.set(nb, d + 1);
                    queue.push(nb);
                    treeEdges.add(`${cur}:${nb}`);
                    treeEdges.add(`${nb}:${cur}`);
                }
            }
        }
        dist._treeEdges = treeEdges;
        return dist;
    }

    /**
     * Compute radial layout positions for ego-centric focus mode.
     * Root at center, 1-hop ring, 2-hop ring, etc.
     * Each hop ring is evenly distributed in a circle.
     */
    function computeRadialLayout(rootId, depthMap) {
        const positions = new Map();
        // Root at center
        positions.set(rootId, { x: 0, y: 0 });

        // Group nodes by depth
        const levels = new Map();
        for (const [nid, d] of depthMap) {
            if (nid === rootId) continue;
            if (!levels.has(d)) levels.set(d, []);
            levels.get(d).push(nid);
        }

        const maxDepth = Math.max(0, ...levels.keys());
        const baseRingSpacing = 150; // minimum distance between rings
        const minArcPx = 35; // G4: minimum arc space per node to prevent overlap

        for (let d = 1; d <= maxDepth; d++) {
            const nodesAtLevel = levels.get(d) || [];
            if (nodesAtLevel.length === 0) continue;
            // Sort for deterministic layout
            nodesAtLevel.sort((a, b) => gs.nodes[a].title.localeCompare(gs.nodes[b].title));
            // G4: Scale ring radius by population density so crowded rings expand
            const linearRadius = d * baseRingSpacing;
            const densityRadius = (nodesAtLevel.length * minArcPx) / (2 * Math.PI);
            const radius = Math.min(Math.max(linearRadius, densityRadius), 1200); // cap at 1200px
            const angleStep = (2 * Math.PI) / nodesAtLevel.length;
            // Offset each ring slightly to avoid alignment
            const angleOffset = d * 0.3;
            for (let i = 0; i < nodesAtLevel.length; i++) {
                const angle = angleOffset + i * angleStep;
                positions.set(nodesAtLevel[i], {
                    x: Math.cos(angle) * radius,
                    y: Math.sin(angle) * radius,
                });
            }
        }

        return positions;
    }

    function enterFocusTree(rootNode) {
        const { nodes, edges, settings, canvas } = gs;
        const depth = settings.graphFocusTreeDepth || 2;
        const depthMap = bfsDepth(rootNode.id, depth);

        dbg(`Ego Focus: root="${rootNode.title}", depth=${depth}, visible=${depthMap.size}/${nodes.length}`);

        // Save pre-focus positions for smooth exit
        if (!gs._preFocusPositions) {
            gs._preFocusPositions = new Map();
            for (const n of nodes) {
                gs._preFocusPositions.set(n.id, { x: n.x, y: n.y });
            }
        }

        for (const n of nodes) {
            n.hidden = !depthMap.has(n.id);
        }

        gs.focusTreeRoot = rootNode;
        rootNode.pinned = true;

        // Radial layout
        const positions = computeRadialLayout(rootNode.id, depthMap);

        // Set target positions for smooth lerp (store as _targetX/_targetY)
        for (const [nid, pos] of positions) {
            const n = nodes[nid];
            n._targetX = pos.x;
            n._targetY = pos.y;
            n.vx = 0;
            n.vy = 0;
            n._treePinned = true;
            n.pinned = true;
        }

        gs.focusTreeRoot._depthMap = depthMap;
        const treeEdgeIdx = new Set();
        for (let i = 0; i < edges.length; i++) {
            const e = edges[i];
            if (depthMap._treeEdges.has(`${e.from}:${e.to}`)) treeEdgeIdx.add(i);
        }
        gs.focusTreeRoot._treeEdgeIdx = treeEdgeIdx;
        gs.cachedVisibleCount = depthMap.size;
        gs.focusTreePhysics = true; // disable regular physics
        gs._egoLerpActive = true;   // enable position lerp in tick
        gs.alpha = 0.001;
        gs.needsDraw = true;
        gs.hasSpringEnergy = true;

        const backBtn = document.getElementById('dle-graph-back');
        if (backBtn) {
            backBtn.textContent = `← ${rootNode.title} (${depthMap.size} nodes, ${depth}-hop)`;
            backBtn.style.display = 'inline-block';
        }
        const hopMinus = document.getElementById('dle-graph-hop-minus');
        const hopPlus = document.getElementById('dle-graph-hop-plus');
        const depthDisplay = document.getElementById('dle-graph-depth-display');
        if (hopMinus) hopMinus.style.display = 'inline-block';
        if (hopPlus) hopPlus.style.display = 'inline-block';
        if (depthDisplay) { depthDisplay.style.display = 'inline-block'; depthDisplay.textContent = depth; }

        fitToView();
        gs.cachedRect = canvas.getBoundingClientRect();
        updateHints(true);
    }

    function updateHints(focusMode) {
        const el = document.getElementById('dle-graph-hints');
        if (!el) return;
        if (focusMode) {
            // BUG-357: Exit key is 'e', not Backspace/← — correct the hint text.
            el.textContent = 'Double-click node to re-root · +/- to change depth · e to exit focus · Scroll to zoom · 0 to fit';
        } else {
            el.textContent = 'Drag to move · Right-click for menu · Scroll to zoom · Click+drag to pan · Double-click to focus · 0 to fit';
        }
    }

    function exitFocusTree() {
        if (!gs.focusTreeRoot) return;
        const { nodes, W, H } = gs;
        dbg(`Exiting Ego Focus from root="${gs.focusTreeRoot.title}"`);

        for (const n of nodes) {
            if (n._treePinned) {
                n.pinned = false;
                n._treePinned = false;
            }
            n.hidden = n.orphan || (n.revealBatchIdx != null && n.revealBatchIdx >= gs.revealedBatch && n.revealBatchIdx !== -1);
            delete n._targetX;
            delete n._targetY;
        }

        // Restore pre-focus positions if available, else randomize
        if (gs._preFocusPositions) {
            for (const n of nodes) {
                const saved = gs._preFocusPositions.get(n.id);
                if (saved && !n.pinned) {
                    n.x = saved.x;
                    n.y = saved.y;
                }
                n.vx = 0; n.vy = 0;
            }
            gs._preFocusPositions = null;
        } else {
            for (const n of nodes) {
                if (!n.pinned) {
                    n.x = (Math.random() - 0.5) * W * 0.8;
                    n.y = (Math.random() - 0.5) * H * 0.8;
                }
                n.vx = 0; n.vy = 0;
            }
        }

        gs.focusTreeRoot.pinned = false;
        delete gs.focusTreeRoot._treeEdgeIdx;
        delete gs.focusTreeRoot._depthMap;
        gs.focusTreeRoot = null;
        gs.focusTreePhysics = false;
        gs._egoLerpActive = false;
        gs.cachedVisibleCount = nodes.length;

        gs.alpha = 0.8; gs.simFrame = 0;
        gs.needsDraw = true;
        gs.hasSpringEnergy = true;

        const backBtn = document.getElementById('dle-graph-back');
        if (backBtn) backBtn.style.display = 'none';
        const hopMinus = document.getElementById('dle-graph-hop-minus');
        const hopPlus = document.getElementById('dle-graph-hop-plus');
        const depthDisplay = document.getElementById('dle-graph-depth-display');
        if (hopMinus) hopMinus.style.display = 'none';
        if (hopPlus) hopPlus.style.display = 'none';
        if (depthDisplay) depthDisplay.style.display = 'none';

        fitToView();
        gs.cachedRect = gs.canvas.getBoundingClientRect();
        updateHints(false);
    }

    /**
     * Lerp ego-focus nodes toward their target positions.
     * Called from the tick loop. Returns true if still animating.
     */
    function lerpEgoPositions() {
        if (!gs._egoLerpActive) return false;

        // Accessibility: skip lerp animation, snap to targets immediately
        if (gs.reducedMotion) {
            for (const n of gs.nodes) {
                if (n._targetX == null || n.hidden) continue;
                n.x = n._targetX;
                n.y = n._targetY;
            }
            gs._egoLerpActive = false;
            return false;
        }

        let anyMoving = false;
        const speed = 0.12; // lerp factor per frame (~150ms to settle)
        for (const n of gs.nodes) {
            if (n._targetX == null || n.hidden) continue;
            const dx = n._targetX - n.x;
            const dy = n._targetY - n.y;
            if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
                n.x += dx * speed;
                n.y += dy * speed;
                anyMoving = true;
            } else {
                n.x = n._targetX;
                n.y = n._targetY;
            }
        }
        if (!anyMoving) gs._egoLerpActive = false;
        return anyMoving;
    }

    // Per-ring soft caps for hover BFS — keeps the lit subgraph bounded on hub nodes
    // without truncating ring 1 (immediate neighbors are always shown). Tiebreak: lowest
    // degree first, so we prefer leafy edges over chasing more hubs.
    const HOVER_RING_CAPS = [Infinity, Infinity, 40, 60, 80, 100];

    function computeHoverDistances(startId, maxDepth) {
        const depth = maxDepth ?? (gs.settings.graphHoverDimDistance ?? 3);
        const dist = new Map();
        dist.set(startId, 0);
        // BFS ring-by-ring so we can sort/cap each ring independently.
        let frontier = [startId];
        for (let d = 0; d < depth; d++) {
            const ringCap = HOVER_RING_CAPS[d + 1] ?? HOVER_RING_CAPS[HOVER_RING_CAPS.length - 1];
            // Collect all candidate next-ring neighbors, dedup'd against existing dist.
            const candidates = [];
            const seenInRing = new Set();
            for (const u of frontier) {
                for (const v of (gs.adjacency.get(u) || [])) {
                    if (dist.has(v) || seenInRing.has(v)) continue;
                    seenInRing.add(v);
                    candidates.push(v);
                }
            }
            if (!candidates.length) break;
            // Cap by degree (lowest first) when over the soft limit. Ring 1 is uncapped.
            let next = candidates;
            if (candidates.length > ringCap) {
                const degOf = (id) => (gs.edgeCountByNode?.get(id) || (gs.adjacency.get(id)?.length || 0));
                next = candidates
                    .map(id => ({ id, deg: degOf(id) }))
                    .sort((a, b) => a.deg - b.deg)
                    .slice(0, ringCap)
                    .map(x => x.id);
            }
            for (const v of next) dist.set(v, d + 1);
            frontier = next;
        }
        return dist;
    }

    function applyFilters() {
        const { nodes } = gs;
        const q = gs.searchQuery.toLowerCase();
        let matchCount = 0;
        const hasFilter = q || gs.typeFilter || gs.tagFilter;

        if (!hasFilter && !gs.focusTreeRoot) {
            let wasIsolated = false;
            for (const n of nodes) {
                if (n.hidden && !n.orphan && (n.revealBatchIdx == null || n.revealBatchIdx < gs.revealedBatch || n.revealBatchIdx === -1)) {
                    wasIsolated = true;
                    n.hidden = false;
                }
            }
            if (wasIsolated) dbg('Filters cleared — reset isolation mode');
        }

        for (const n of nodes) {
            let matches = true;
            if (q && !n.title.toLowerCase().includes(q)) matches = false;
            if (gs.typeFilter && n.type !== gs.typeFilter) matches = false;
            if (gs.tagFilter && !n.tags.includes(gs.tagFilter)) matches = false;
            n.filtered = hasFilter && !matches;
            if (!n.filtered) matchCount++;
        }
        gs.needsDraw = true;
        dbg(`Filters applied: query="${q}", type="${gs.typeFilter}", tag="${gs.tagFilter}" → ${matchCount}/${nodes.length} match`);
        const searchEl = document.getElementById('dle-graph-search');
        if (searchEl && hasFilter) {
            searchEl.title = `${matchCount} of ${nodes.length} entries match`;
        } else if (searchEl) {
            searchEl.title = '';
        }
    }

    function fitToView(animate = false) {
        const { nodes, edgeCountByNode, W, H } = gs;
        const visible = nodes.filter(n => !n.hidden);
        if (visible.length === 0) return;
        const connected = visible.filter(n => (edgeCountByNode.get(n.id) || 0) > 0);
        const fitSet = connected.length > 0 ? connected : visible;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const n of fitSet) {
            if (n.x < minX) minX = n.x;
            if (n.y < minY) minY = n.y;
            if (n.x > maxX) maxX = n.x;
            if (n.y > maxY) maxY = n.y;
        }
        const dx = maxX - minX || 1;
        const dy = maxY - minY || 1;
        const padX = 40;
        const padTop = 40;
        const padBottom = 60; // Extra room for color legend overlay at bottom
        const targetZoom = Math.max(0.2, Math.min((W - padX * 2) / dx, (H - padTop - padBottom) / dy, 3));
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const targetPanX = W / 2 - cx * targetZoom;
        const targetPanY = (padTop + (H - padBottom - padTop) / 2) - cy * targetZoom;

        if (animate) {
            // Smooth lerp over ~30 frames
            gs._fitAnim = { targetPanX, targetPanY, targetZoom, frames: 0 };
        } else {
            gs.zoom = targetZoom;
            gs.panX = targetPanX;
            gs.panY = targetPanY;
        }
        gs.needsDraw = true;
    }

    /** Step the fit animation — called from tick loop. Returns true while active. */
    function stepFitAnimation() {
        const a = gs._fitAnim;
        if (!a) return false;
        const t = 0.12; // lerp factor — smooth ease-out
        gs.panX += (a.targetPanX - gs.panX) * t;
        gs.panY += (a.targetPanY - gs.panY) * t;
        gs.zoom += (a.targetZoom - gs.zoom) * t;
        a.frames++;
        // Done when close enough or max frames
        if (a.frames > 60 || (Math.abs(gs.panX - a.targetPanX) < 0.5 && Math.abs(gs.panY - a.targetPanY) < 0.5 && Math.abs(gs.zoom - a.targetZoom) < 0.001)) {
            gs.panX = a.targetPanX;
            gs.panY = a.targetPanY;
            gs.zoom = a.targetZoom;
            gs._fitAnim = null;
            return false;
        }
        gs.needsDraw = true;
        return true;
    }

    // Attach to gs for cross-module access
    gs.findNearest = findNearest;
    gs.hitRadius = hitRadius;
    gs.computeHoverDistances = computeHoverDistances;
    gs.applyFilters = applyFilters;
    gs.fitToView = fitToView;
    gs.enterFocusTree = enterFocusTree;
    gs.exitFocusTree = exitFocusTree;
    gs.lerpEgoPositions = lerpEgoPositions;

    return { bfsDepth, computeRadialLayout, enterFocusTree, exitFocusTree,
             computeHoverDistances, applyFilters, fitToView, stepFitAnimation,
             findNearest, hitRadius, lerpEgoPositions };
}
