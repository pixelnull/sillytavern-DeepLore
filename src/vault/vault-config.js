/**
 * Pure helpers for vault connection configuration.
 */

export function vaultConnectionSignature(vault) {
    return [
        String(vault?.host || '127.0.0.1').trim().toLowerCase(),
        String(vault?.port || ''),
        vault?.https ? 'https' : 'http',
    ].join('|');
}

export function hasDuplicateEnabledVault(vaults, candidate, candidateIndex = -1) {
    if (!candidate?.enabled) return false;
    const signature = vaultConnectionSignature(candidate);
    return (vaults || []).some((vault, index) => (
        index !== candidateIndex
        && vault?.enabled
        && vaultConnectionSignature(vault) === signature
    ));
}
