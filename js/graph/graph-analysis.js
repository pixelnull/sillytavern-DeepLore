/**
 * DeepLore Enhanced — Graph analysis module.
 * Disparity filter (Serrano et al. backbone extraction).
 * Louvain community detection.
 */

// ============================================================================
// Serrano et al. disparity filter
// ============================================================================

/**
 * Compute the backbone of the graph using the disparity filter.
 * Sets `edge._backbone = true/false` on every edge in `gs.edges`.
 *
 * Algorithm: For each edge (i,j) with weight w_ij, compute the p-value
 * at both endpoints: p_ij = (1 - w_ij / s_i)^(k_i - 1) where s_i is
 * the strength (sum of weights) and k_i is the degree. If either
 * endpoint's p-value < alpha, the edge is part of the backbone.
 *
 * @param {object} gs   Shared graph state
 * @param {number} alpha  Significance threshold (lower = sparser)
 */
export function computeDisparityFilter(gs, alpha) {
    const { nodes, edges } = gs;

    // Compute node strength (sum of incident edge weights) and degree
    const strength = new Float64Array(nodes.length);
    const degree = new Uint32Array(nodes.length);

    for (const e of edges) {
        const w = e.weight || 1;
        strength[e.from] += w;
        strength[e.to] += w;
        degree[e.from]++;
        degree[e.to]++;
    }

    let backboneCount = 0;

    for (const e of edges) {
        const w = e.weight || 1;

        // p-value at "from" endpoint
        const kFrom = degree[e.from];
        const sFrom = strength[e.from];
        let pFrom = 1;
        if (kFrom > 1 && sFrom > 0) {
            // BUG-F5: Clamp ratio to [0,1] — w can exceed sFrom with high mention weights,
            // causing Math.pow(negative, fraction) → NaN
            pFrom = Math.pow(Math.max(0, 1 - w / sFrom), kFrom - 1);
        }

        // p-value at "to" endpoint
        const kTo = degree[e.to];
        const sTo = strength[e.to];
        let pTo = 1;
        if (kTo > 1 && sTo > 0) {
            pTo = Math.pow(Math.max(0, 1 - w / sTo), kTo - 1);
        }

        // Edge is backbone if significant at either endpoint
        e._backbone = (pFrom < alpha || pTo < alpha);

        // Degree-1 nodes: their single edge is always backbone
        if (kFrom <= 1 || kTo <= 1) e._backbone = true;

        if (e._backbone) backboneCount++;
    }

    gs._backboneCount = backboneCount;
    gs._disparityAlpha = alpha;
}

// ============================================================================
// Louvain community detection
// ============================================================================

/** 12-color distinguishable palette for Louvain community visualization.
 * @type {string[]} */
export const COMMUNITY_PALETTE = [
    '#4e79a7', '#f28e2b', '#e15759', '#76b7b2',
    '#59a14f', '#edc948', '#b07aa1', '#ff9da7',
    '#9c755f', '#bab0ac', '#86bcb6', '#d37295',
];

/**
 * Run Louvain community detection on the graph.
 * Sets `node.community` (integer) on each node in `gs.nodes`.
 * Stores community metadata on `gs.communities`.
 *
 * @param {object} gs  Shared graph state
 */
export function computeLouvainCommunities(gs) {
    const { nodes, edges } = gs;
    const n = nodes.length;
    if (n === 0) return;

    // Build weighted adjacency (only non-orphan, non-hidden-permanently)
    // m = total edge weight
    let m2 = 0; // 2*m (sum of all weights, counted once per edge = m, but modularity uses 2m)
    const adj = new Array(n);
    for (let i = 0; i < n; i++) adj[i] = [];

    for (const e of edges) {
        const w = e.weight || 1;
        adj[e.from].push({ node: e.to, weight: w });
        adj[e.to].push({ node: e.from, weight: w });
        m2 += 2 * w;
    }
    if (m2 === 0) {
        // No edges — each node is its own community
        for (let i = 0; i < n; i++) nodes[i].community = i;
        gs.communities = buildCommunityMeta(gs);
        return;
    }

    // Node weight (sum of incident edge weights)
    const k = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        for (const nb of adj[i]) k[i] += nb.weight;
    }

    // Initial: each node in its own community
    const comm = new Int32Array(n);
    for (let i = 0; i < n; i++) comm[i] = i;

    // Sum of weights inside each community (Σ_in) and total weight of each community (Σ_tot)
    const sigmaIn = new Float64Array(n);
    const sigmaTot = new Float64Array(n);
    for (let i = 0; i < n; i++) sigmaTot[i] = k[i];

    // Phase 1: Local moves — iterate until no improvement
    const MAX_ITERATIONS = 20;
    // BUG-AUDIT-H17: Allocate order array ONCE, re-shuffle in place each iteration.
    const order = Array.from({ length: n }, (_, i) => i);
    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
        let moved = false;
        // Shuffle in place for better convergence
        for (let i = order.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [order[i], order[j]] = [order[j], order[i]];
        }

        for (const i of order) {
            if (nodes[i].orphan) continue;
            const ci = comm[i];

            // Compute weight from i to each neighboring community
            const neighborComms = new Map();
            let ki_in = 0; // weight from i to its own community
            for (const nb of adj[i]) {
                const cj = comm[nb.node];
                neighborComms.set(cj, (neighborComms.get(cj) || 0) + nb.weight);
                if (cj === ci) ki_in += nb.weight;
            }

            // Remove i from its community
            sigmaIn[ci] -= 2 * ki_in;
            sigmaTot[ci] -= k[i];

            // Find best community to move i into
            let bestComm = ci;
            let bestDelta = 0;

            for (const [cj, ki_cj] of neighborComms) {
                // Modularity gain of moving i to community cj
                const delta = ki_cj - sigmaTot[cj] * k[i] / m2;
                if (delta > bestDelta) {
                    bestDelta = delta;
                    bestComm = cj;
                }
            }
            // Also consider staying (delta = 0 baseline already set)

            // Move i to bestComm
            comm[i] = bestComm;
            const ki_best = neighborComms.get(bestComm) || 0;
            sigmaIn[bestComm] += 2 * ki_best;
            sigmaTot[bestComm] += k[i];

            if (bestComm !== ci) moved = true;
        }

        if (!moved) break;
    }

    // Renumber communities to 0..C-1
    const uniqueComms = [...new Set(comm)];
    const commMap = new Map();
    uniqueComms.forEach((c, idx) => commMap.set(c, idx));

    for (let i = 0; i < n; i++) {
        nodes[i].community = commMap.get(comm[i]);
    }

    gs.communities = buildCommunityMeta(gs);
}

/**
 * Build community metadata: centroid, member count, label, color.
 * @param {object} gs
 * @returns {Map<number, {id, members, color, label, cx, cy}>}
 */
function buildCommunityMeta(gs) {
    const { nodes } = gs;
    const meta = new Map();

    for (const n of nodes) {
        if (n.community == null) continue;
        if (!meta.has(n.community)) {
            meta.set(n.community, {
                id: n.community,
                members: [],
                color: COMMUNITY_PALETTE[n.community % COMMUNITY_PALETTE.length],
                label: '',
                cx: 0, cy: 0,
            });
        }
        meta.get(n.community).members.push(n);
    }

    // Compute label: most common non-lorebook tag per community
    const lorebookTag = (gs.settings?.lorebookTag || 'lorebook').toLowerCase();
    for (const [, cm] of meta) {
        const tagCounts = new Map();
        for (const n of cm.members) {
            for (const t of (n.tags || [])) {
                if (t.toLowerCase() === lorebookTag) continue;
                tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
            }
        }
        let bestTag = '', bestCount = 0;
        for (const [t, c] of tagCounts) {
            if (c > bestCount) { bestTag = t; bestCount = c; }
        }
        cm.label = bestTag || `Cluster ${cm.id + 1}`;
    }

    return meta;
}

/**
 * Update community centroids (call each physics frame for cluster forces).
 * @param {object} gs
 */
export function updateCommunityCentroids(gs) {
    if (!gs.communities) return;
    for (const [, cm] of gs.communities) {
        let sx = 0, sy = 0, count = 0;
        for (const n of cm.members) {
            if (n.hidden || n.orphan) continue;
            sx += n.x; sy += n.y; count++;
        }
        if (count > 0) { cm.cx = sx / count; cm.cy = sy / count; }
    }
}

/**
 * Compute convex hull of a set of 2D points using Graham scan.
 * @param {Array<{x: number, y: number}>} points
 * @returns {Array<{x: number, y: number}>}
 */
export function convexHull(points) {
    if (points.length < 3) return points.slice();

    // Find bottom-most (then left-most) point
    let pivot = 0;
    for (let i = 1; i < points.length; i++) {
        if (points[i].y > points[pivot].y ||
            (points[i].y === points[pivot].y && points[i].x < points[pivot].x)) {
            pivot = i;
        }
    }
    [points[0], points[pivot]] = [points[pivot], points[0]];
    const p0 = points[0];

    // Sort by polar angle
    const sorted = points.slice(1).sort((a, b) => {
        const cross = (a.x - p0.x) * (b.y - p0.y) - (a.y - p0.y) * (b.x - p0.x);
        if (cross !== 0) return -cross; // CCW first
        // Collinear: closer first
        const da = (a.x - p0.x) ** 2 + (a.y - p0.y) ** 2;
        const db = (b.x - p0.x) ** 2 + (b.y - p0.y) ** 2;
        return da - db;
    });

    const stack = [p0];
    for (const pt of sorted) {
        while (stack.length > 1) {
            const top = stack[stack.length - 1];
            const next = stack[stack.length - 2];
            const cross = (top.x - next.x) * (pt.y - next.y) - (top.y - next.y) * (pt.x - next.x);
            if (cross <= 0) stack.pop();
            else break;
        }
        stack.push(pt);
    }
    return stack;
}

// ============================================================================
// Gap analysis
// ============================================================================

/**
 * Compute gap analysis overlays. Returns an object with:
 * - orphans: node ids with zero edges
 * - bridges: edge indices connecting different communities with only 1 cross-link
 * - typeImbalance: per-community type distribution
 * - missingConnections: pairs of entries sharing contextual fields but no edges
 *
 * @param {object} gs  Shared graph state (requires communities from Phase 5)
 * @returns {object}
 */
export function computeGapAnalysis(gs) {
    const { nodes, edges, edgeCountByNode, communities } = gs;

    // -- Orphan nodes: zero edges --
    const orphans = [];
    for (const n of nodes) {
        if ((edgeCountByNode.get(n.id) || 0) === 0) {
            orphans.push(n.id);
        }
    }

    // -- Weak bridges: cross-community edges where communities have only 1 link --
    const bridges = [];
    if (communities && communities.size > 1) {
        // Count cross-community edges per community pair
        const crossCounts = new Map(); // "min,max" → count
        const crossEdgeIdxs = new Map(); // "min,max" → [edge indices]
        for (let i = 0; i < edges.length; i++) {
            const e = edges[i];
            const ca = nodes[e.from].community;
            const cb = nodes[e.to].community;
            if (ca == null || cb == null || ca === cb) continue;
            const key = `${Math.min(ca, cb)},${Math.max(ca, cb)}`;
            crossCounts.set(key, (crossCounts.get(key) || 0) + 1);
            if (!crossEdgeIdxs.has(key)) crossEdgeIdxs.set(key, []);
            crossEdgeIdxs.get(key).push(i);
        }
        for (const [key, count] of crossCounts) {
            if (count === 1) {
                bridges.push(...crossEdgeIdxs.get(key));
            }
        }
    }

    // -- Type imbalance per community --
    const typeImbalance = new Map();
    if (communities) {
        for (const [cid, cm] of communities) {
            const counts = { regular: 0, constant: 0, seed: 0, bootstrap: 0 };
            for (const n of cm.members) {
                counts[n.type] = (counts[n.type] || 0) + 1;
            }
            typeImbalance.set(cid, { label: cm.label, total: cm.members.length, ...counts });
        }
    }

    // -- Missing connections: entries sharing era/location/characterPresent but no edge --
    const missingConnections = [];
    const edgeSet = new Set();
    for (const e of edges) {
        edgeSet.add(`${Math.min(e.from, e.to)},${Math.max(e.from, e.to)}`);
    }
    // Only check non-orphan, non-hidden nodes — limit to prevent O(n^2) blowup
    const candidates = nodes.filter(n => !n.orphan && !n.hidden);
    if (candidates.length <= 200) {
        // Access vault entries for contextual fields
        const vaultIndex = gs._vaultIndex; // set by graph.js
        for (let i = 0; i < candidates.length; i++) {
            const ni = candidates[i];
            const ei = vaultIndex?.[ni.id];
            if (!ei) continue;
            for (let j = i + 1; j < candidates.length; j++) {
                const nj = candidates[j];
                const ej = vaultIndex?.[nj.id];
                if (!ej) continue;
                const key = `${Math.min(ni.id, nj.id)},${Math.max(ni.id, nj.id)}`;
                if (edgeSet.has(key)) continue;

                // Check shared contextual fields (via customFields)
                let shared = false;
                const cfi = ei.customFields || {};
                const cfj = ej.customFields || {};
                // Check all string/string[] custom fields for overlap
                for (const key of Object.keys(cfi)) {
                    const vi = cfi[key];
                    const vj = cfj[key];
                    if (vi == null || vj == null) continue;
                    // BUG-AUDIT-13: Normalize both values to arrays to handle mixed
                    // scalar/array comparisons (e.g., era: "modern" vs era: ["modern"])
                    const arrI = Array.isArray(vi) ? vi : [vi];
                    const arrJ = Array.isArray(vj) ? vj : [vj];
                    if (arrI.some(v => arrJ.includes(v))) { shared = true; break; }
                }
                if (shared) {
                    missingConnections.push({ a: ni.id, b: nj.id, aTitle: ni.title, bTitle: nj.title });
                }
            }
        }
    }

    return { orphans, bridges, typeImbalance, missingConnections };
}
