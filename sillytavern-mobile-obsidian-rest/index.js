'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const fss = require('node:fs');
const path = require('node:path');

const DEFAULT_PORT = 27123;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_FIELD_DEFINITIONS = 'fields: []\n';
const MAX_BODY_BYTES = 50 * 1024 * 1024;

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
    const host = env.OBSIDIAN_API_HOST || env.DLE_MOBILE_OBSIDIAN_API_HOST || DEFAULT_HOST;
    const port = Number(env.OBSIDIAN_API_PORT || env.DLE_MOBILE_OBSIDIAN_API_PORT || DEFAULT_PORT);
    const fallbackFields = env.OBSIDIAN_API_FALLBACK_FIELDS !== '0';
    const hideRootDotfiles = env.OBSIDIAN_API_HIDE_ROOT_DOTFILES !== '0';
    const debug = env.OBSIDIAN_API_DEBUG === '1' || env.DLE_MOBILE_OBSIDIAN_DEBUG === '1';

    return { vault, apiKey, host, port, fallbackFields, hideRootDotfiles, debug };
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
    const normalizedConfig = {
        ...config,
        vault: path.resolve(config.vault),
    };

    return async function handle(req, res) {
        setCorsHeaders(res);
        if (req.method === 'OPTIONS') {
            sendEmpty(res, 204);
            return;
        }

        try {
            const url = new URL(req.url || '/', 'http://127.0.0.1');
            if (normalizedConfig.debug) {
                console.log('[mobile-obsidian-rest]', req.method, url.pathname);
            }

            if (req.method === 'GET' && url.pathname === '/') {
                await handleRoot(normalizedConfig, res);
                return;
            }
            if (req.method === 'GET' && url.pathname === '/healthz') {
                await handleHealth(normalizedConfig, res);
                return;
            }

            requireAuth(req, normalizedConfig);

            if (url.pathname === '/tags/' || url.pathname === '/tags') {
                await handleTags(normalizedConfig, res);
                return;
            }
            if (url.pathname === '/search/simple/' || url.pathname === '/search/simple' || url.pathname === '/search/' || url.pathname === '/search') {
                await handleSearch(normalizedConfig, req, res, url);
                return;
            }
            if (url.pathname === '/commands/' || url.pathname === '/commands') {
                sendJson(res, 200, []);
                return;
            }
            if (url.pathname.startsWith('/commands/')) {
                sendJson(res, 501, {
                    ok: false,
                    error: 'Command execution is not available in the mobile bridge.',
                    command: decodeURIComponent(url.pathname.slice('/commands/'.length).replace(/\/$/, '')),
                });
                return;
            }
            if (url.pathname === '/vault' || url.pathname === '/vault/' || url.pathname.startsWith('/vault/')) {
                await handleVault(normalizedConfig, req, res, url);
                return;
            }

            sendJson(res, 404, { error: 'Not found' });
        } catch (err) {
            if (err?.statusCode) {
                sendJson(res, err.statusCode, { error: err.message });
                return;
            }
            console.warn('[mobile-obsidian-rest] request failed:', err?.message || err);
            sendJson(res, 500, { error: 'Internal server error' });
        }
    };
}

async function handleRoot(config, res) {
    sendJson(res, 200, {
        status: 'ok',
        service: 'obsidian-local-rest-api-mobile-bridge',
        authenticated: false,
        vault: path.basename(config.vault),
        compat: {
            fallbackFields: config.fallbackFields,
            hideRootDotfiles: config.hideRootDotfiles,
        },
    });
}

async function handleHealth(config, res) {
    sendJson(res, 200, {
        ok: true,
        vaultExists: await exists(config.vault),
    });
}

async function handleVault(config, req, res, url) {
    const vaultPath = decodeVaultRequestPath(url.pathname);
    const fullPath = resolveVaultPath(config.vault, vaultPath);

    if (req.method === 'GET' || req.method === 'HEAD') {
        if (vaultPath === 'DeepLore/field-definitions.yaml' && config.fallbackFields && !(await exists(fullPath))) {
            sendText(res, 200, DEFAULT_FIELD_DEFINITIONS, 'text/yaml; charset=utf-8', req.method === 'HEAD');
            return;
        }

        const stat = await statOrNull(fullPath);
        if (!stat) {
            sendJson(res, 404, { error: 'Not found' });
            return;
        }
        if (stat.isDirectory()) {
            if (req.method === 'HEAD') {
                sendEmpty(res, 200);
                return;
            }
            sendJson(res, 200, { files: await listDir(fullPath, vaultPath === '', config) });
            return;
        }
        if (stat.isFile()) {
            if (req.method === 'HEAD') {
                sendEmpty(res, 200);
                return;
            }
            await sendFile(res, fullPath);
            return;
        }
        sendJson(res, 404, { error: 'Not found' });
        return;
    }

    if (req.method === 'PUT' || req.method === 'POST' || req.method === 'PATCH') {
        const body = await readBody(req);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, body);
        sendEmpty(res, 204);
        return;
    }

    if (req.method === 'DELETE') {
        const stat = await statOrNull(fullPath);
        if (!stat) {
            sendJson(res, 404, { error: 'Not found' });
            return;
        }
        if (stat.isFile()) {
            await fs.unlink(fullPath);
            sendEmpty(res, 204);
            return;
        }
        if (stat.isDirectory()) {
            try {
                await fs.rmdir(fullPath);
                sendEmpty(res, 204);
            } catch {
                sendJson(res, 409, { ok: false, error: 'Directory not empty.' });
            }
            return;
        }
    }

    sendJson(res, 405, { error: 'Method not allowed' });
}

async function handleTags(config, res) {
    const counts = new Map();
    for await (const file of iterateVaultFiles(config.vault)) {
        if (!file.toLowerCase().endsWith('.md')) continue;
        const text = await fs.readFile(file, 'utf8');
        for (const tag of collectTagsFromText(text)) {
            counts.set(tag, (counts.get(tag) || 0) + 1);
        }
    }
    const tags = [...counts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, count]) => ({ name, count }));
    sendJson(res, 200, { tags });
}

async function handleSearch(config, req, res, url) {
    const query = (await extractQuery(req, url)).trim().replace(/^#/, '').toLowerCase();
    const results = [];
    for await (const file of iterateVaultFiles(config.vault)) {
        if (!file.toLowerCase().endsWith('.md')) continue;
        const text = await fs.readFile(file, 'utf8');
        const relative = relativeVaultPath(config.vault, file);
        const lowerText = text.toLowerCase();
        const lowerRelative = relative.toLowerCase();
        if (!query || lowerText.includes(query) || lowerRelative.includes(query)) {
            const score = 1 + (query && lowerRelative.includes(query) ? 0.5 : 0);
            results.push({
                filename: relative,
                score,
                match_type: 'fulltext',
                preview: buildPreview(text, query),
            });
        }
    }
    results.sort((a, b) => b.score - a.score || a.filename.localeCompare(b.filename));
    sendJson(res, 200, results);
}

function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS,PATCH,HEAD');
    res.setHeader('Cache-Control', 'no-store');
}

function requireAuth(req, config) {
    if (req.headers.authorization !== `Bearer ${config.apiKey}`) {
        throw httpError(401, 'Unauthorized');
    }
}

function decodeVaultRequestPath(pathname) {
    let encoded = pathname === '/vault' ? '' : pathname.slice('/vault/'.length);
    encoded = encoded.replace(/^\/+|\/+$/g, '');
    return decodeURIComponent(encoded).replace(/\\/g, '/');
}

function resolveVaultPath(vaultRoot, vaultPath) {
    const root = path.resolve(vaultRoot);
    const fullPath = path.resolve(root, vaultPath);
    if (fullPath !== root && !fullPath.startsWith(root + path.sep)) {
        throw httpError(403, 'Forbidden');
    }
    return fullPath;
}

async function listDir(fullPath, isRoot, config) {
    const entries = await fs.readdir(fullPath, { withFileTypes: true });
    return entries
        .filter(entry => !(isRoot && config.hideRootDotfiles && entry.name.startsWith('.')))
        .sort((a, b) => {
            if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
            return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        })
        .map(entry => entry.name + (entry.isDirectory() ? '/' : ''));
}

async function* iterateVaultFiles(root) {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.name === '.obsidian') continue;
        const fullPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            yield* iterateVaultFiles(fullPath);
        } else if (entry.isFile()) {
            yield fullPath;
        }
    }
}

function collectTagsFromText(text) {
    const tags = [];
    const frontmatter = text.match(/^---\s*\n([\s\S]*?)\n---/);
    if (frontmatter) {
        const yaml = frontmatter[1];
        for (const inline of yaml.matchAll(/^tags:\s*\[([^\]]*)\]/gim)) {
            for (const part of inline[1].split(',')) {
                addTag(tags, part);
            }
        }

        const block = yaml.match(/^tags:\s*\n((?:\s*-\s*[^\n]+\n?)+)/im);
        if (block) {
            for (const line of block[1].split(/\r?\n/)) {
                const item = line.match(/^\s*-\s*(.+)$/);
                if (item) addTag(tags, item[1]);
            }
        }
    }

    for (const match of text.matchAll(/(?<![\w/])#([A-Za-z0-9_/-]+)/g)) {
        addTag(tags, match[1]);
    }
    return tags;
}

function addTag(tags, raw) {
    const tag = String(raw || '').trim().replace(/^['"]|['"]$/g, '').replace(/^#/, '').toLowerCase();
    if (tag) tags.push(tag);
}

async function extractQuery(req, url) {
    const query = url.searchParams.get('query');
    if (query !== null) return query;
    if (!['POST', 'PUT', 'PATCH'].includes(req.method || '')) return '';
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('application/json')) return '';
    const body = await readBody(req);
    if (!body.length) return '';
    try {
        const data = JSON.parse(body.toString('utf8'));
        for (const key of ['query', 'q', 'term']) {
            if (typeof data?.[key] === 'string') return data[key];
        }
    } catch {
        return '';
    }
    return '';
}

function buildPreview(text, query, width = 180) {
    if (!query) return undefined;
    const lowerText = text.toLowerCase();
    const index = lowerText.indexOf(query);
    if (index < 0) return undefined;
    const start = Math.max(0, index - Math.floor(width / 2));
    const end = Math.min(text.length, index + Math.floor(width / 2));
    return text.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, width);
}

function relativeVaultPath(root, file) {
    return path.relative(root, file).split(path.sep).join('/');
}

function contentTypeForFile(file) {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.md') return 'text/markdown; charset=utf-8';
    if (ext === '.yaml' || ext === '.yml') return 'text/yaml; charset=utf-8';
    if (ext === '.json') return 'application/json; charset=utf-8';
    if (ext === '.txt') return 'text/plain; charset=utf-8';
    return 'application/octet-stream';
}

async function sendFile(res, fullPath) {
    res.writeHead(200, { 'Content-Type': contentTypeForFile(fullPath) });
    await new Promise((resolve, reject) => {
        const stream = fss.createReadStream(fullPath);
        stream.once('error', reject);
        res.once('error', reject);
        res.once('finish', resolve);
        stream.pipe(res);
    });
}

function sendJson(res, status, payload) {
    sendText(res, status, JSON.stringify(payload), 'application/json; charset=utf-8');
}

function sendText(res, status, text, contentType, headOnly = false) {
    res.writeHead(status, { 'Content-Type': contentType });
    res.end(headOnly ? undefined : text);
}

function sendEmpty(res, status) {
    res.writeHead(status);
    res.end();
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(httpError(413, 'Request body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

async function exists(file) {
    return !!(await statOrNull(file));
}

async function statOrNull(file) {
    try {
        return await fs.stat(file);
    } catch {
        return null;
    }
}

function httpError(statusCode, message) {
    const err = new Error(message);
    err.statusCode = statusCode;
    return err;
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
        collectTagsFromText,
        resolveVaultPath,
    },
};
