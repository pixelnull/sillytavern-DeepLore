// Shim for DLE helpers.js
export function buildObsidianURI(vaultName, filename) {
    return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(filename)}`;
}
