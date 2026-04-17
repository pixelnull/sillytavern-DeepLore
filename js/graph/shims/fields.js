// Shim for DLE fields.js
export const DEFAULT_FIELD_DEFINITIONS = [
    { name: 'era', label: 'Era', type: 'string', multi: true, gating: { enabled: true, operator: 'match_any', tolerance: 'moderate' }, values: [], contextKey: 'era' },
    { name: 'location', label: 'Location', type: 'string', multi: true, gating: { enabled: true, operator: 'match_any', tolerance: 'moderate' }, values: [], contextKey: 'location' },
    { name: 'scene_type', label: 'Scene Type', type: 'string', multi: true, gating: { enabled: true, operator: 'match_any', tolerance: 'moderate' }, values: [], contextKey: 'scene_type' },
    { name: 'character_present', label: 'Characters Present', type: 'string', multi: true, gating: { enabled: true, operator: 'match_any', tolerance: 'moderate' }, values: [], contextKey: 'character_present' },
];
