// Shim for DLE settings.js
const _settings = {
    debugMode: false,
    graphHoverDim: 2,
    graphHoverFalloff: 0.55,
    graphHoverAmbient: 0.06,
    graphTreeDepth: 2,
    graphEdgeFilter: 0.0,
    graphRepulsion: 0.2,
    graphGravity: 13.0,
    graphDamping: 0.50,
    graphColorMode: 'type',
    graphNodeSizeMode: 'centrality',
    graphShowLabels: true,
    graphPreset: 'balanced',
    graphPositions: null,
    graphSavedLayout: null,
    vaults: [{ name: 'test-vault', obsidianVault: 'test-vault' }],
};

export function getSettings() { return _settings; }
export function setSavedLayout(positions) { _settings.graphSavedLayout = { positions }; }
export function invalidateSettingsCache() {}
export function getVaultByName(name) { return _settings.vaults[0]; }
