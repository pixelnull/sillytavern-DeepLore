import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import plugin from '../index.js';

async function makeVault() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-obsidian-rest-'));
    await fs.mkdir(path.join(root, 'DeepLore'), { recursive: true });
    await fs.mkdir(path.join(root, 'Lore'), { recursive: true });
    await fs.writeFile(path.join(root, 'Lore', 'Cosplay Mode.md'), [
        '---',
        'tags: [lorebook]',
        'keys: [Cosplay mode, Cosplay]',
        'summary: Cosplay mode',
        '---',
        '# Cosplay Mode',
        'A test entry.',
        '',
    ].join('\n'));
    await fs.writeFile(path.join(root, 'Lore', 'Mimic Mode.md'), [
        '---',
        'tags:',
        '  - lorebook',
        'keys: [Mimic mode, Mimic]',
        'summary: Mimic mode',
        '---',
        '# Mimic Mode',
        'Another test entry.',
        '',
    ].join('\n'));
    await fs.writeFile(path.join(root, '.hidden-root.md'), 'hidden');
    await fs.mkdir(path.join(root, '.obsidian'), { recursive: true });
    await fs.writeFile(path.join(root, '.obsidian', 'workspace.json'), '{}');
    return root;
}

async function startServer(vault) {
    const server = await plugin._private.startCompatibilityServer({
        vault,
        apiKey: 'secret',
        host: '127.0.0.1',
        port: 0,
        fallbackFields: true,
        hideRootDotfiles: true,
    });
    const address = server.address();
    return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function request(baseUrl, pathname, options = {}) {
    return fetch(`${baseUrl}${pathname}`, {
        ...options,
        headers: {
            Authorization: 'Bearer secret',
            ...(options.headers || {}),
        },
    });
}

test('serves DLE vault listing and markdown reads', async (t) => {
    const vault = await makeVault();
    t.after(() => fs.rm(vault, { recursive: true, force: true }));
    const { server, baseUrl } = await startServer(vault);
    t.after(() => new Promise(resolve => server.close(resolve)));

    const root = await fetch(`${baseUrl}/`);
    assert.equal(root.status, 200);
    const rootJson = await root.json();
    assert.equal(rootJson.service, 'obsidian-local-rest-api-mobile-bridge');
    assert.equal(rootJson.authenticated, false);

    const unauthorized = await fetch(`${baseUrl}/vault/`);
    assert.equal(unauthorized.status, 401);

    const listing = await request(baseUrl, '/vault/');
    assert.equal(listing.status, 200);
    assert.deepEqual((await listing.json()).files, ['DeepLore/', 'Lore/']);

    const nested = await request(baseUrl, '/vault/Lore/');
    assert.equal(nested.status, 200);
    assert.deepEqual((await nested.json()).files, ['Cosplay Mode.md', 'Mimic Mode.md']);

    const note = await request(baseUrl, '/vault/Lore/Cosplay%20Mode.md', {
        headers: { Accept: 'text/markdown' },
    });
    assert.equal(note.status, 200);
    assert.match(note.headers.get('content-type'), /text\/markdown/);
    assert.match(await note.text(), /# Cosplay Mode/);
});

test('allows the legacy mobile shim default API key', () => {
    assert.equal(plugin._private.shouldStartWithApiKey('12345'), true);
    assert.equal(plugin._private.shouldStartWithApiKey(''), false);
});

test('supports DLE writes, fallback field definitions, tags, search, and path safety', async (t) => {
    const vault = await makeVault();
    t.after(() => fs.rm(vault, { recursive: true, force: true }));
    const { server, baseUrl } = await startServer(vault);
    t.after(() => new Promise(resolve => server.close(resolve)));

    const fields = await request(baseUrl, '/vault/DeepLore/field-definitions.yaml');
    assert.equal(fields.status, 200);
    assert.equal(await fields.text(), 'fields: []\n');

    const write = await request(baseUrl, '/vault/Generated/New%20Entry.md', {
        method: 'PUT',
        headers: { 'Content-Type': 'text/markdown' },
        body: '# New Entry\n',
    });
    assert.equal(write.status, 204);
    assert.equal(await fs.readFile(path.join(vault, 'Generated', 'New Entry.md'), 'utf8'), '# New Entry\n');

    const tags = await request(baseUrl, '/tags/');
    assert.equal(tags.status, 200);
    assert.deepEqual(await tags.json(), { tags: [{ name: 'lorebook', count: 2 }] });

    const search = await request(baseUrl, '/search/simple/?query=Mimic', { method: 'POST' });
    assert.equal(search.status, 200);
    const results = await search.json();
    assert.equal(results[0].filename, 'Lore/Mimic Mode.md');

    const traversal = await request(baseUrl, '/vault/%2e%2e%2fpackage.json');
    assert.equal(traversal.status, 403);
});
