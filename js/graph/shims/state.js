// Shim for DLE ui/state.js — hydrated from graph-data.json
import { setSavedLayout } from './settings.js';

export let vaultIndex = [];
export const chatInjectionCounts = new Map();
export const mentionWeights = new Map();
export let fieldDefinitions = [];
export const lastHealthResult = null;

export function trackerKey(entry) {
    return (entry.vaultSource || 'test-vault') + ':' + entry.title;
}

// Called by graph-boot.js after loading JSON
export function hydrateFromJSON(data) {
    vaultIndex = data.nodes.map(n => ({
        title: n.title,
        constant: n.type === 'constant',
        seed: n.type === 'seed',
        bootstrap: n.type === 'bootstrap',
        tokenEstimate: n.tokens,
        priority: n.priority,
        vaultSource: 'test-vault',
        tags: n.tags || [],
        folderPath: n.folder || '',
        filename: n.title,
        customFields: n.cf || {},
        resolvedLinks: [],
        requires: [],
        excludes: [],
        cascadeLinks: [],
        graph: true,
    }));
    // Build resolvedLinks and edge data from edges
    const titleToIdx = new Map();
    vaultIndex.forEach((e, i) => titleToIdx.set(e.title.toLowerCase(), i));
    for (const edge of data.edges) {
        const src = vaultIndex[edge.from];
        const tgt = vaultIndex[edge.to];
        if (!src || !tgt) continue;
        if (edge.type === 'link') {
            if (!src.resolvedLinks.includes(tgt.title)) src.resolvedLinks.push(tgt.title);
            if (!tgt.resolvedLinks.includes(src.title)) tgt.resolvedLinks.push(src.title);
        } else if (edge.type === 'requires') {
            if (!src.requires.includes(tgt.title)) src.requires.push(tgt.title);
        } else if (edge.type === 'excludes') {
            if (!src.excludes.includes(tgt.title)) src.excludes.push(tgt.title);
        } else if (edge.type === 'cascade') {
            if (!src.cascadeLinks.includes(tgt.title)) src.cascadeLinks.push(tgt.title);
        }
        // Build mention weights
        const key = `${src.title}\0${tgt.title}`;
        mentionWeights.set(key, edge.weight || 1);
    }
    // Build saved layout positions from JSON node x,y coords
    const positions = {};
    for (const n of data.nodes) {
        if (n.x != null && n.y != null) {
            positions[n.title] = { x: n.x, y: n.y };
        }
    }
    if (Object.keys(positions).length > 0) {
        setSavedLayout(positions);
    }

    // Populate chatInjectionCounts with fake data for frequency coloring
    for (const n of data.nodes) {
        const tk = (n.vaultSource || 'test-vault') + ':' + n.title;
        chatInjectionCounts.set(tk, Math.floor(Math.random() * 8) + 1);
    }

    // Field definitions
    fieldDefinitions = [
        { name: 'era', label: 'Era', type: 'string', multi: true, gating: { enabled: true, operator: 'match_any', tolerance: 'moderate' }, values: [], contextKey: 'era' },
        { name: 'location', label: 'Location', type: 'string', multi: true, gating: { enabled: true, operator: 'match_any', tolerance: 'moderate' }, values: [], contextKey: 'location' },
        { name: 'scene_type', label: 'Scene Type', type: 'string', multi: true, gating: { enabled: true, operator: 'match_any', tolerance: 'moderate' }, values: [], contextKey: 'scene_type' },
        { name: 'character_present', label: 'Characters Present', type: 'string', multi: true, gating: { enabled: true, operator: 'match_any', tolerance: 'moderate' }, values: [], contextKey: 'character_present' },
    ];
}
