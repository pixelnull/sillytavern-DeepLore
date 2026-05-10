import test from 'node:test';
import assert from 'node:assert/strict';

import { hasDuplicateEnabledVault, vaultConnectionSignature } from '../src/vault/vault-config.js';

test('vaultConnectionSignature normalizes equivalent mobile bridge rows', () => {
    assert.equal(
        vaultConnectionSignature({ name: ' First Vault ', host: 'LOCALHOST', port: 27123, https: false }),
        'localhost|27123|http',
    );
});

test('hasDuplicateEnabledVault detects enabled duplicate vault rows', () => {
    const vaults = [
        { name: 'First Vault', host: '127.0.0.1', port: 27123, https: false, enabled: true },
        { name: 'First Vault', host: '127.0.0.1', port: 27123, https: false, enabled: true },
    ];

    assert.equal(hasDuplicateEnabledVault(vaults, vaults[1], 1), true);
});

test('hasDuplicateEnabledVault detects same endpoint with different labels', () => {
    const vaults = [
        { name: 'First Vault', host: '127.0.0.1', port: 27123, https: false, enabled: true },
        { name: 'Mobile Bridge', host: '127.0.0.1', port: 27123, https: false, enabled: true },
    ];

    assert.equal(hasDuplicateEnabledVault(vaults, vaults[1], 1), true);
});

test('hasDuplicateEnabledVault ignores disabled duplicate rows', () => {
    const vaults = [
        { name: 'First Vault', host: '127.0.0.1', port: 27123, https: false, enabled: true },
        { name: 'First Vault', host: '127.0.0.1', port: 27123, https: false, enabled: false },
    ];

    assert.equal(hasDuplicateEnabledVault(vaults, vaults[1], 1), false);
});
