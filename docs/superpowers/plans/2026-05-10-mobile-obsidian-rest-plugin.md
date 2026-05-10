# Mobile Obsidian REST Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let mobile/Termux SillyTavern users run DeepLore Enhanced without Obsidian's desktop-only Local REST API plugin.

**Architecture:** Build a companion SillyTavern server plugin that runs inside the Termux SillyTavern process and exposes a Local REST API-compatible server on `127.0.0.1:27123`. DeepLore Enhanced continues to talk to `http://127.0.0.1:27123/vault/...`, so desktop users do not need any behavior change and mobile users only install the optional server plugin.

**Tech Stack:** SillyTavern server plugin API, Node.js CommonJS, Node `http`, `fs`, `path`, `node:test`, DLE docs/wiki updates.

---

## File Structure

Plugin repository or subproject:

- Create: `sillytavern-mobile-obsidian-rest/package.json`
  - Defines package metadata and `npm test`.
- Create: `sillytavern-mobile-obsidian-rest/index.js`
  - Exports ST server plugin `info`, `init(router)`, `exit()`.
  - Starts/stops the compatibility HTTP server.
  - Implements Local REST API-compatible `/`, `/vault/`, `/tags/`, `/search/simple/`, `/search/`, and `/commands/` routes.
- Create: `sillytavern-mobile-obsidian-rest/test/dle-compat.test.mjs`
  - Runs route-level compatibility tests against a temp vault using Node's built-in test runner.
- Create: `sillytavern-mobile-obsidian-rest/README.md`
  - Documents Termux install, configuration, DLE settings, security notes, and limits.
- Create: `sillytavern-mobile-obsidian-rest/LICENSE`
  - Use MIT unless the maintainer requests a different license.

DLE repository:

- Modify: `README.md`
  - Add optional mobile bridge note under requirements/install.
- Modify: `wiki/Installation.md`
  - Add a Mobile / Termux section explaining when the server plugin is needed.
- Modify: `wiki/Quick-Start.md`
  - Add one sentence that mobile users can use the bridge instead of Local REST API.
- Modify: `manifest.json`
  - Optional wording update only if maintainer agrees: mention Obsidian Local REST API or compatible bridge.
- Modify: `src/ui/settings-ui.js`
  - Optional guard against adding duplicate enabled vault rows with the same host, port, HTTPS flag, and name.
- Test: `test/settings-vaults.test.mjs`
  - Optional unit tests for duplicate vault config helper if the guard is implemented.

---

## Task 1: Scaffold the Server Plugin

**Files:**
- Create: `sillytavern-mobile-obsidian-rest/package.json`
- Create: `sillytavern-mobile-obsidian-rest/index.js`
- Create: `sillytavern-mobile-obsidian-rest/LICENSE`

- [ ] **Step 1: Create package metadata**

Create `sillytavern-mobile-obsidian-rest/package.json`:

```json
{
  "name": "sillytavern-mobile-obsidian-rest",
  "version": "0.1.0",
  "description": "SillyTavern server plugin that exposes a mobile-compatible Obsidian Local REST API bridge for DeepLore Enhanced.",
  "main": "index.js",
  "type": "commonjs",
  "scripts": {
    "test": "node --test test/*.test.mjs"
  },
  "keywords": [
    "sillytavern",
    "server-plugin",
    "obsidian",
    "deeplore",
    "termux"
  ],
  "license": "MIT"
}
```

- [ ] **Step 2: Create the minimal plugin export**

Create `sillytavern-mobile-obsidian-rest/index.js` with this initial content:

```js
'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createReadStream } = require('node:fs');

const DEFAULT_PORT = 27123;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_FIELD_DEFINITIONS = 'fields: []\n';

let server = null;
let activeConfig = null;

const info = {
    id: 'mobile-obsidian-rest',
    name: 'Mobile Obsidian REST Bridge',
    description: 'Exposes a Local REST API-compatible vault server for mobile/Termux DeepLore Enhanced users.',
};

function readConfig(env = process.env) {
    const vault = env.OBSIDIAN_VAULT || env.DLE_MOBILE_OBSIDIAN_VAULT || '';
    const apiKey = env.OBSIDIAN_API_KEY || env.DLE_MOBILE_OBSIDIAN_API_KEY || '';
    const host = env.OBSIDIAN_API_HOST || DEFAULT_HOST;
    const port = Number(env.OBSIDIAN_API_PORT || DEFAULT_PORT);
    const fallbackFields = env.OBSIDIAN_API_FALLBACK_FIELDS !== '0';
    const hideRootDotfiles = env.OBSIDIAN_API_HIDE_ROOT_DOTFILES !== '0';

    return { vault, apiKey, host, port, fallbackFields, hideRootDotfiles };
}

async function init(router) {
    activeConfig = readConfig();

    router.get('/status', (_req, res) => {
        res.json({
            ok: !!server,
            service: info.id,
            host: activeConfig.host,
            port: activeConfig.port,
            vaultConfigured: !!activeConfig.vault,
        });
    });

    if (!activeConfig.vault) {
        console.warn('[mobile-obsidian-rest] OBSIDIAN_VAULT is not set; bridge server not started.');
        return;
    }
    if (!activeConfig.apiKey || activeConfig.apiKey === '12345') {
        console.warn('[mobile-obsidian-rest] Set OBSIDIAN_API_KEY to a non-default value; bridge server not started.');
        return;
    }

    server = await startCompatibilityServer(activeConfig);
    console.log(`[mobile-obsidian-rest] listening on http://${activeConfig.host}:${activeConfig.port}`);
}

async function exit() {
    if (!server) return;
    await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
    });
    server = null;
}

async function startCompatibilityServer(config) {
    const requestHandler = createRequestHandler(config);
    const httpServer = http.createServer(requestHandler);
    await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(config.port, config.host, () => {
            httpServer.off('error', reject);
            resolve();
        });
    });
    return httpServer;
}

function createRequestHandler(config) {
    return async function handle(req, res) {
        setCorsHeaders(res);
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        res.writeHead(501, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Route implementation pending' }));
    };
}

function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS,PATCH,HEAD');
    res.setHeader('Cache-Control', 'no-store');
}

module.exports = {
    init,
    exit,
    info,
    _private: {
        readConfig,
        createRequestHandler,
        startCompatibilityServer,
        DEFAULT_FIELD_DEFINITIONS,
    },
};
```

- [ ] **Step 3: Add MIT license**

Create `sillytavern-mobile-obsidian-rest/LICENSE`:

```text
MIT License

Copyright (c) 2026

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 4: Verify scaffold loads**

Run:

```bash
node -e "const p=require('./sillytavern-mobile-obsidian-rest'); console.log(p.info.id, typeof p.init, typeof p.exit)"
```

Expected output:

```text
mobile-obsidian-rest function function
```

- [ ] **Step 5: Commit scaffold**

```bash
git add sillytavern-mobile-obsidian-rest/package.json sillytavern-mobile-obsidian-rest/index.js sillytavern-mobile-obsidian-rest/LICENSE
git commit -m "feat: scaffold mobile obsidian rest server plugin"
```

---

## Task 2: Add DLE Compatibility Tests Before Route Implementation

**Files:**
- Create: `sillytavern-mobile-obsidian-rest/test/dle-compat.test.mjs`
- Modify: `sillytavern-mobile-obsidian-rest/index.js`

- [ ] **Step 1: Write failing compatibility tests**

Create `sillytavern-mobile-obsidian-rest/test/dle-compat.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
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
    await once(server, 'listening');
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

    const traversal = await request(baseUrl, '/vault/../package.json');
    assert.equal(traversal.status, 403);
});
```

- [ ] **Step 2: Run tests and verify they fail because routes are pending**

Run:

```bash
cd sillytavern-mobile-obsidian-rest
npm test
```

Expected: tests fail with status `501` where `200`, `204`, `401`, or `403` is expected.

- [ ] **Step 3: Commit failing tests**

```bash
git add sillytavern-mobile-obsidian-rest/test/dle-compat.test.mjs
git commit -m "test: cover DLE mobile rest compatibility contract"
```

---

## Task 3: Implement the Local REST API Compatibility Routes

**Files:**
- Modify: `sillytavern-mobile-obsidian-rest/index.js`

- [ ] **Step 1: Replace pending handler with route implementation**

In `sillytavern-mobile-obsidian-rest/index.js`, replace `createRequestHandler` and add the helper functions below it:

```js
function createRequestHandler(config) {
    return async function handle(req, res) {
        setCorsHeaders(res);
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        try {
            const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

            if (url.pathname === '/' && req.method === 'GET') {
                return sendJson(res, 200, {
                    ok: 'OK',
                    service: 'obsidian-local-rest-api-mobile-bridge',
                    authenticated: false,
                    vault: path.basename(path.resolve(config.vault)),
                    versions: {
                        self: '0.1.0',
                        api: 'compatible-dle',
                    },
                });
            }

            requireAuth(req, config);

            if (url.pathname === '/tags/' && req.method === 'GET') {
                return sendJson(res, 200, { tags: await collectTags(config) });
            }

            if ((url.pathname === '/search/simple/' || url.pathname === '/search/') && (req.method === 'GET' || req.method === 'POST')) {
                const query = await extractQuery(req, url);
                return sendJson(res, 200, await searchMarkdown(config, query));
            }

            if (url.pathname === '/commands/' && req.method === 'GET') {
                return sendJson(res, 200, { commands: [] });
            }

            if (url.pathname.startsWith('/commands/') && req.method === 'POST') {
                return sendJson(res, 501, {
                    error: 'Command execution is not available in the mobile bridge.',
                });
            }

            if (url.pathname === '/vault/' || url.pathname.startsWith('/vault/')) {
                return handleVaultRoute(req, res, config, url.pathname);
            }

            return sendJson(res, 404, { error: 'Not found' });
        } catch (err) {
            if (err.statusCode) {
                return sendJson(res, err.statusCode, { error: err.message });
            }
            console.warn('[mobile-obsidian-rest] request failed:', err);
            return sendJson(res, 500, { error: 'Internal server error' });
        }
    };
}

function requireAuth(req, config) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${config.apiKey}`) {
        const err = new Error('Unauthorized');
        err.statusCode = 401;
        throw err;
    }
}

async function handleVaultRoute(req, res, config, pathname) {
    const rel = decodeURIComponent(pathname.slice('/vault/'.length)).replace(/^\/+|\/+$/g, '');
    const fullPath = safeVaultPath(config.vault, rel);

    if (req.method === 'GET' || req.method === 'HEAD') {
        if (rel === 'DeepLore/field-definitions.yaml' && config.fallbackFields) {
            try {
                await fs.access(fullPath);
            } catch {
                if (req.method === 'HEAD') {
                    res.writeHead(200);
                    res.end();
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'text/yaml; charset=utf-8' });
                res.end(DEFAULT_FIELD_DEFINITIONS);
                return;
            }
        }

        const stat = await statOrNull(fullPath);
        if (!stat) return sendJson(res, 404, { error: 'Not found' });

        if (stat.isDirectory()) {
            if (req.method === 'HEAD') {
                res.writeHead(200);
                res.end();
                return;
            }
            return sendJson(res, 200, { files: await listDirectory(config, fullPath, rel === '') });
        }

        if (!stat.isFile()) return sendJson(res, 404, { error: 'Not found' });

        if (req.method === 'HEAD') {
            res.writeHead(200, { 'Content-Type': contentTypeFor(fullPath) });
            res.end();
            return;
        }
        res.writeHead(200, { 'Content-Type': contentTypeFor(fullPath) });
        createReadStream(fullPath).pipe(res);
        return;
    }

    if (req.method === 'PUT') {
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, await readRequestBody(req));
        res.writeHead(204);
        res.end();
        return;
    }

    if (req.method === 'POST') {
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.appendFile(fullPath, await readRequestBody(req));
        res.writeHead(204);
        res.end();
        return;
    }

    if (req.method === 'PATCH') {
        return sendJson(res, 501, {
            error: 'Targeted PATCH is not implemented by the mobile bridge. DeepLore Enhanced does not require it.',
        });
    }

    if (req.method === 'DELETE') {
        const stat = await statOrNull(fullPath);
        if (!stat) return sendJson(res, 404, { error: 'Not found' });
        if (stat.isDirectory()) {
            await fs.rmdir(fullPath);
        } else {
            await fs.unlink(fullPath);
        }
        res.writeHead(204);
        res.end();
        return;
    }

    return sendJson(res, 405, { error: 'Method not allowed' });
}

function safeVaultPath(vaultRoot, rel) {
    const base = path.resolve(vaultRoot);
    const candidate = path.resolve(base, rel || '.');
    if (candidate !== base && !candidate.startsWith(base + path.sep)) {
        const err = new Error('Forbidden');
        err.statusCode = 403;
        throw err;
    }
    return candidate;
}

async function listDirectory(config, dirPath, isRoot) {
    const dirents = await fs.readdir(dirPath, { withFileTypes: true });
    const filtered = dirents
        .filter((d) => d.name !== '.obsidian')
        .filter((d) => !(isRoot && config.hideRootDotfiles && d.name.startsWith('.')))
        .sort((a, b) => {
            if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
    return filtered.map((d) => d.isDirectory() ? `${d.name}/` : d.name);
}

async function statOrNull(filePath) {
    try {
        return await fs.stat(filePath);
    } catch {
        return null;
    }
}

function contentTypeFor(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.md') return 'text/markdown; charset=utf-8';
    if (ext === '.yaml' || ext === '.yml') return 'text/yaml; charset=utf-8';
    if (ext === '.json') return 'application/json; charset=utf-8';
    if (ext === '.txt') return 'text/plain; charset=utf-8';
    return 'application/octet-stream';
}

async function readRequestBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
}

function sendJson(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
}
```

- [ ] **Step 2: Run compatibility tests**

Run:

```bash
cd sillytavern-mobile-obsidian-rest
npm test
```

Expected: tests still fail only for missing `collectTags`, `searchMarkdown`, or `extractQuery`.

- [ ] **Step 3: Add search and tag helpers**

Add these helpers near the other helper functions in `index.js`:

```js
async function extractQuery(req, url) {
    const fromUrl = url.searchParams.get('query') || url.searchParams.get('q') || url.searchParams.get('term');
    if (fromUrl) return fromUrl;
    if (req.method !== 'POST') return '';
    const body = await readRequestBody(req);
    if (!body.length) return '';
    const type = req.headers['content-type'] || '';
    if (type.includes('application/json')) {
        try {
            const parsed = JSON.parse(body.toString('utf8'));
            return String(parsed.query || parsed.q || parsed.term || '');
        } catch {
            return '';
        }
    }
    return body.toString('utf8');
}

async function walkFiles(root, options = {}) {
    const out = [];
    async function visit(current) {
        const dirents = await fs.readdir(current, { withFileTypes: true });
        for (const dirent of dirents) {
            if (dirent.name === '.obsidian') continue;
            const full = path.join(current, dirent.name);
            if (dirent.isDirectory()) {
                await visit(full);
            } else if (!options.markdownOnly || path.extname(dirent.name).toLowerCase() === '.md') {
                out.push(full);
            }
        }
    }
    await visit(root);
    return out;
}

function vaultRel(config, filePath) {
    return path.relative(path.resolve(config.vault), filePath).replace(/\\/g, '/');
}

async function collectTags(config) {
    const counts = new Map();
    const hashtagRe = /(?<![\w/])#([A-Za-z0-9_\-/]+)/g;
    const files = await walkFiles(path.resolve(config.vault), { markdownOnly: true });
    for (const file of files) {
        const text = await fs.readFile(file, 'utf8');
        for (const match of text.matchAll(hashtagRe)) {
            const tag = match[1].toLowerCase();
            counts.set(tag, (counts.get(tag) || 0) + 1);
        }
        for (const tag of parseFrontmatterTags(text)) {
            counts.set(tag, (counts.get(tag) || 0) + 1);
        }
    }
    return [...counts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, count]) => ({ name, count }));
}

function parseFrontmatterTags(text) {
    const tags = [];
    const match = /^---\s*\n([\s\S]*?)\n---/m.exec(text);
    if (!match) return tags;
    const fm = match[1];

    const inline = /^tags:\s*\[([^\]]*)\]\s*$/gim;
    for (const item of fm.matchAll(inline)) {
        for (const raw of item[1].split(',')) {
            const tag = raw.trim().replace(/^['"]|['"]$/g, '').replace(/^#/, '').toLowerCase();
            if (tag) tags.push(tag);
        }
    }

    const lines = fm.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        if (!/^tags:\s*$/i.test(lines[i])) continue;
        for (let j = i + 1; j < lines.length; j++) {
            const bullet = /^\s*-\s*(.+?)\s*$/.exec(lines[j]);
            if (!bullet) break;
            const tag = bullet[1].trim().replace(/^['"]|['"]$/g, '').replace(/^#/, '').toLowerCase();
            if (tag) tags.push(tag);
        }
    }
    return tags;
}

async function searchMarkdown(config, query) {
    const q = String(query || '').trim().replace(/^#/, '').toLowerCase();
    const files = await walkFiles(path.resolve(config.vault), { markdownOnly: true });
    const results = [];
    for (const file of files) {
        const rel = vaultRel(config, file);
        const text = await fs.readFile(file, 'utf8');
        const relMatch = q && rel.toLowerCase().includes(q);
        const textMatch = !q || text.toLowerCase().includes(q);
        if (!relMatch && !textMatch) continue;
        results.push({
            filename: rel,
            score: relMatch ? 1.5 : 1,
            match_type: 'fulltext',
            preview: buildPreview(text, q),
        });
    }
    return results.sort((a, b) => b.score - a.score || a.filename.localeCompare(b.filename));
}

function buildPreview(text, query, width = 180) {
    if (!query) return undefined;
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx < 0) return undefined;
    const start = Math.max(0, idx - Math.floor(width / 2));
    const end = Math.min(text.length, idx + Math.floor(width / 2));
    return text.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, width);
}
```

- [ ] **Step 4: Run compatibility tests until green**

Run:

```bash
cd sillytavern-mobile-obsidian-rest
npm test
```

Expected output includes:

```text
# tests 2
# pass 2
# fail 0
```

- [ ] **Step 5: Commit route implementation**

```bash
git add sillytavern-mobile-obsidian-rest/index.js
git commit -m "feat: implement mobile obsidian rest compatibility routes"
```

---

## Task 4: Document Plugin Installation and Mobile DLE Setup

**Files:**
- Create: `sillytavern-mobile-obsidian-rest/README.md`

- [ ] **Step 1: Write plugin README**

Create `sillytavern-mobile-obsidian-rest/README.md`:

```markdown
# SillyTavern Mobile Obsidian REST Bridge

This is a SillyTavern server plugin for Android / Termux users who want to use DeepLore Enhanced with an Obsidian vault.

Obsidian's Local REST API community plugin is desktop-only. This bridge exposes the subset of the Local REST API that DeepLore Enhanced uses, directly from the SillyTavern Node.js process.

Desktop users do not need this plugin. Use Obsidian's official Local REST API plugin instead.

## Requirements

- SillyTavern running in Termux
- `enableServerPlugins: true` in `config.yaml`
- Termux storage permission enabled with `termux-setup-storage`
- An Obsidian vault stored somewhere Termux can read and write
- A private API key of your choice

## Install

From your SillyTavern directory:

```sh
cd plugins
git clone https://github.com/pixelnull/sillytavern-mobile-obsidian-rest
```

Edit `config.yaml`:

```yaml
enableServerPlugins: true
```

Start SillyTavern with environment variables:

```sh
export OBSIDIAN_VAULT="/storage/emulated/0/Documents/First Vault"
export OBSIDIAN_API_KEY="replace-this-with-a-long-random-secret"
export OBSIDIAN_API_HOST="127.0.0.1"
export OBSIDIAN_API_PORT="27123"
npm start
```

## DeepLore Enhanced Settings

In DeepLore Enhanced, set the vault connection to:

- Host: `127.0.0.1`
- Port: `27123`
- API Key: the same value as `OBSIDIAN_API_KEY`
- HTTPS: off

Then click test/refresh.

## Accessing SillyTavern From Another Device

If your browser is not running on the Android device, `127.0.0.1` points to the browser device, not the phone. In that case:

```sh
export OBSIDIAN_API_HOST="0.0.0.0"
```

Then set DeepLore's host to the phone's LAN IP address, for example `192.168.1.42`.

Only do this on a trusted LAN. This bridge exposes read/write access to your vault to anyone with the API key.

## Supported API Surface

Implemented for DeepLore Enhanced:

- `GET /`
- `GET /vault/`
- `GET /vault/<path>`
- `HEAD /vault/<path>`
- `PUT /vault/<path>`
- `POST /vault/<path>` as append
- `DELETE /vault/<path>`
- `GET /tags/`
- `GET|POST /search/simple/`
- `GET|POST /search/` as simple full-text search
- `GET /commands/` as an empty command list

Not implemented:

- Obsidian command execution
- Active file operations
- Periodic notes
- Opening files in the Obsidian UI
- Targeted heading/block/frontmatter PATCH operations
- Dataview or JsonLogic search

## Security

The bridge refuses to start if `OBSIDIAN_API_KEY` is missing or set to the old demo value `12345`.

The default bind address is `127.0.0.1`. Use `0.0.0.0` only when you understand the LAN exposure.
```

- [ ] **Step 2: Commit README**

```bash
git add sillytavern-mobile-obsidian-rest/README.md
git commit -m "docs: explain mobile obsidian rest bridge setup"
```

---

## Task 5: Add DLE Documentation for Mobile Users

**Files:**
- Modify: `README.md`
- Modify: `wiki/Installation.md`
- Modify: `wiki/Quick-Start.md`

- [ ] **Step 1: Update README requirements**

In `README.md`, update the requirements block around the existing SillyTavern/Obsidian bullets so it reads:

```markdown
- **SillyTavern 1.12.14+**
- **Obsidian** with the **Local REST API** plugin enabled on desktop
- **Mobile / Termux alternative:** Android users can use the optional SillyTavern Mobile Obsidian REST Bridge server plugin instead of Obsidian's Local REST API plugin, which is desktop-only
- A lore vault (your existing one works; `/dle-import` converts World Info JSON into vault entries)
- Optional: any LLM provider for AI search; keywords-only mode works without one
```

- [ ] **Step 2: Add a mobile subsection to wiki installation**

In `wiki/Installation.md`, after the requirements list, add:

```markdown
### Mobile / Termux users

Obsidian's Local REST API community plugin does not run on Android. If you run SillyTavern inside Termux, install the optional **SillyTavern Mobile Obsidian REST Bridge** server plugin instead.

Use the bridge only on mobile. Desktop users should use Obsidian's official Local REST API plugin.

Recommended mobile setup:

1. Run `termux-setup-storage` so Termux can access your Obsidian vault folder.
2. Install the bridge into `SillyTavern/plugins/`.
3. Set `enableServerPlugins: true` in `config.yaml`.
4. Start SillyTavern with `OBSIDIAN_VAULT`, `OBSIDIAN_API_KEY`, and `OBSIDIAN_API_PORT=27123`.
5. In DeepLore, add a vault connection with host `127.0.0.1`, port `27123`, HTTPS off, and the same API key.

If you access the Termux SillyTavern server from a different device, bind the bridge to `0.0.0.0` and use the phone's LAN IP in DeepLore. Do this only on a trusted network.
```

- [ ] **Step 3: Update Quick Start prerequisites**

In `wiki/Quick-Start.md`, change the first prerequisite section to:

```markdown
1. **Obsidian** with either:
   - the [Local REST API plugin](https://github.com/coddingtonbear/obsidian-local-rest-api) installed and enabled on desktop, or
   - the optional SillyTavern Mobile Obsidian REST Bridge server plugin when running SillyTavern in Android / Termux
2. **SillyTavern** with DeepLore installed (see [[Installation]])
```

- [ ] **Step 4: Run docs grep sanity check**

Run:

```bash
rg -n "Mobile Obsidian REST Bridge|Termux|Local REST API" README.md wiki/Installation.md wiki/Quick-Start.md
```

Expected: each edited file has at least one relevant match and no duplicate contradictory requirement text.

- [ ] **Step 5: Commit DLE docs**

```bash
git add README.md wiki/Installation.md wiki/Quick-Start.md
git commit -m "docs: document mobile obsidian rest bridge option"
```

---

## Task 6: Optional DLE Guard Against Duplicate Vault Rows

**Files:**
- Modify: `src/ui/settings-ui.js`
- Test: `test/settings-vaults.test.mjs`

- [ ] **Step 1: Extract duplicate vault signature helper**

In `src/ui/settings-ui.js`, near the vault list helpers, add:

```js
function vaultConnectionSignature(vault) {
    return [
        String(vault?.name || '').trim().toLowerCase(),
        String(vault?.host || '127.0.0.1').trim().toLowerCase(),
        String(vault?.port || ''),
        vault?.https ? 'https' : 'http',
    ].join('|');
}

function hasDuplicateEnabledVault(vaults, candidate, candidateIndex = -1) {
    if (!candidate?.enabled) return false;
    const sig = vaultConnectionSignature(candidate);
    return (vaults || []).some((v, idx) => idx !== candidateIndex && v?.enabled && vaultConnectionSignature(v) === sig);
}
```

Also export these helpers only if the test harness can import `settings-ui.js` without browser globals. If it cannot, move the helpers into a pure file:

```text
src/vault/vault-config.js
```

with:

```js
export function vaultConnectionSignature(vault) {
    return [
        String(vault?.name || '').trim().toLowerCase(),
        String(vault?.host || '127.0.0.1').trim().toLowerCase(),
        String(vault?.port || ''),
        vault?.https ? 'https' : 'http',
    ].join('|');
}

export function hasDuplicateEnabledVault(vaults, candidate, candidateIndex = -1) {
    if (!candidate?.enabled) return false;
    const sig = vaultConnectionSignature(candidate);
    return (vaults || []).some((v, idx) => idx !== candidateIndex && v?.enabled && vaultConnectionSignature(v) === sig);
}
```

- [ ] **Step 2: Write failing duplicate guard test**

Create `test/settings-vaults.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDuplicateEnabledVault, vaultConnectionSignature } from '../src/vault/vault-config.js';

test('vaultConnectionSignature normalizes equivalent mobile bridge rows', () => {
    assert.equal(
        vaultConnectionSignature({ name: ' First Vault ', host: 'LOCALHOST', port: 27123, https: false }),
        'first vault|localhost|27123|http',
    );
});

test('hasDuplicateEnabledVault detects enabled duplicate vault rows', () => {
    const vaults = [
        { name: 'First Vault', host: '127.0.0.1', port: 27123, https: false, enabled: true },
        { name: 'First Vault', host: '127.0.0.1', port: 27123, https: false, enabled: true },
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
```

Run:

```bash
node --test test/settings-vaults.test.mjs
```

Expected: fail because `src/vault/vault-config.js` does not exist yet, or because helpers are not exported yet.

- [ ] **Step 3: Implement pure helper if needed**

Create `src/vault/vault-config.js` with the helper code from Step 1.

- [ ] **Step 4: Use helper when adding scanned vaults**

In `src/ui/settings-ui.js`, import the helper:

```js
import { hasDuplicateEnabledVault } from '../vault/vault-config.js';
```

In the scan-vault add callback around the code that does `settings.vaults.push({ ... })`, build the candidate first:

```js
const candidate = {
    name: v.vaultName || `Vault ${settings.vaults.length + 1}`,
    host: v.host || host,
    port: v.port,
    apiKey,
    https: v.scheme === 'https',
    enabled: true,
};
if (hasDuplicateEnabledVault(settings.vaults, candidate)) {
    toastr.info(`"${candidate.name}" is already configured for ${candidate.host}:${candidate.port}.`, 'DeepLore Enhanced');
    return;
}
settings.vaults.push(candidate);
```

- [ ] **Step 5: Use helper when editing/enabling vault rows**

In the `.dle-vault-enabled` change handler, after setting `settings.vaults[idx].enabled = true`, add:

```js
if (hasDuplicateEnabledVault(settings.vaults, settings.vaults[idx], idx)) {
    settings.vaults[idx].enabled = false;
    $(this).prop('checked', false);
    toastr.warning('That vault connection duplicates an enabled row. Disable or remove the existing row first.', 'DeepLore Enhanced');
    saveSettingsDebounced();
    return;
}
```

In the `.dle-vault-name`, `.dle-vault-host`, `.dle-vault-port`, and `.dle-vault-https` handlers, after updating the row value, add a non-blocking warning:

```js
if (hasDuplicateEnabledVault(settings.vaults, settings.vaults[idx], idx)) {
    row.find('.dle-vault-status')
        .text('Duplicate enabled vault')
        .addClass('failure')
        .removeClass('success');
} else {
    row.find('.dle-vault-status')
        .text('')
        .removeClass('failure success');
}
```

- [ ] **Step 6: Run targeted tests**

Run:

```bash
node --test test/settings-vaults.test.mjs
```

Expected:

```text
# tests 3
# pass 3
# fail 0
```

- [ ] **Step 7: Run existing test suite**

Run:

```bash
npm test
npm run test:imports
```

Expected: both commands exit 0.

- [ ] **Step 8: Commit duplicate guard**

```bash
git add src/ui/settings-ui.js src/vault/vault-config.js test/settings-vaults.test.mjs
git commit -m "fix: warn on duplicate enabled vault connections"
```

---

## Task 7: Manual Termux Smoke Test

**Files:**
- No source file changes.

- [ ] **Step 1: Install plugin in a Termux SillyTavern checkout**

Run on Android:

```sh
cd /path/to/SillyTavern
mkdir -p plugins
cp -R /path/to/sillytavern-mobile-obsidian-rest plugins/
```

- [ ] **Step 2: Enable server plugins**

In `config.yaml`, set:

```yaml
enableServerPlugins: true
```

- [ ] **Step 3: Start ST with bridge config**

Run:

```sh
termux-setup-storage
export OBSIDIAN_VAULT="/storage/emulated/0/Documents/First Vault"
export OBSIDIAN_API_KEY="replace-this-with-a-long-random-secret"
export OBSIDIAN_API_HOST="127.0.0.1"
export OBSIDIAN_API_PORT="27123"
npm start
```

Expected server log:

```text
[mobile-obsidian-rest] listening on http://127.0.0.1:27123
```

- [ ] **Step 4: Probe the bridge from Termux**

Run:

```sh
curl -s http://127.0.0.1:27123/
curl -s -H "Authorization: Bearer $OBSIDIAN_API_KEY" http://127.0.0.1:27123/vault/
```

Expected:

- Root request returns JSON with `service: "obsidian-local-rest-api-mobile-bridge"`.
- Vault request returns JSON with a `files` array.

- [ ] **Step 5: Test DLE**

In DeepLore Enhanced:

- Host: `127.0.0.1`
- Port: `27123`
- HTTPS: off
- API key: same as `OBSIDIAN_API_KEY`

Then:

```text
/dle-refresh
/dle-status
```

Expected:

- `/dle-refresh` indexes the mobile vault.
- Browse tab shows each note once.
- Scribe/import/write features create or update files in the vault.

- [ ] **Step 6: Record manual test notes**

Add a short note to the plugin release checklist:

```markdown
## Manual Android smoke test

- Device:
- Android version:
- Termux version:
- SillyTavern version:
- DeepLore Enhanced version:
- Vault path:
- Indexed entry count:
- Write test result:
```

---

## Task 8: Prepare Maintainer-Facing PR Notes

**Files:**
- Create or modify PR description only.

- [ ] **Step 1: Draft DLE PR description**

Use this PR body:

```markdown
## Summary

Adds documentation for a mobile/Termux path where DeepLore Enhanced can use an optional SillyTavern server plugin instead of Obsidian's desktop-only Local REST API community plugin.

Desktop users should keep using the official Obsidian Local REST API plugin. The bridge is only for Android users running SillyTavern in Termux.

## Why

Obsidian's Local REST API community plugin is not available on mobile. Termux users can run SillyTavern on Android and can access the vault files directly, but DLE currently documents only the desktop Local REST API path.

## What changed

- Documented the optional mobile bridge in README and wiki install docs.
- Added setup notes for host/port/API key/HTTPS settings.
- Optional: added a guard against duplicate enabled vault rows, which can make every entry appear twice.

## Testing

- `npm test`
- `npm run test:imports`
- Mobile smoke test on Android / Termux with DLE indexing the vault through `127.0.0.1:27123`

## Notes for maintainer

This does not make a server plugin required for DLE. It gives mobile users an optional bridge because the official Obsidian Local REST API plugin is desktop-only.
```

- [ ] **Step 2: Draft companion plugin release note**

Use this release note:

```markdown
# v0.1.0

Initial mobile bridge for DeepLore Enhanced users running SillyTavern in Android / Termux.

Implemented the DLE-required Local REST API subset:

- Vault listing and markdown reads
- Markdown writes
- Field definitions fallback
- Basic tags and full-text search
- CORS and bearer auth

Not intended for desktop users. Desktop users should use Obsidian's official Local REST API plugin.
```

---

## Self-Review

- Spec coverage:
  - Mobile users can use DLE without Obsidian Local REST API: covered by Tasks 1-4 and 7.
  - DLE maintainer receives optional-install docs: covered by Tasks 5 and 8.
  - Desktop users are not affected: architecture keeps DLE's existing Local REST API flow unchanged.
  - Duplicate vault issue discovered during testing: optional Task 6 adds a focused DLE guard.
- Placeholder scan:
  - The plan uses concrete filenames, commands, route names, and code snippets.
  - The README install example points at the likely maintainer-owned companion repository name.
- Type consistency:
  - Plugin exports `init`, `exit`, `info`, and `_private` consistently across tests and implementation.
  - Config keys are consistently `vault`, `apiKey`, `host`, `port`, `fallbackFields`, and `hideRootDotfiles`.
