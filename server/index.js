const http = require('node:http');

const info = {
    id: 'deeplore',
    name: 'DeepLore',
    description: 'Proxies requests to the Obsidian Local REST API for vault-based lorebook functionality',
};

/**
 * Makes an HTTP request to the Obsidian Local REST API.
 * @param {object} options
 * @param {number} options.port - Obsidian REST API port
 * @param {string} options.apiKey - Bearer token
 * @param {string} options.path - API path (e.g. /vault/)
 * @param {string} [options.method='GET'] - HTTP method
 * @param {string} [options.accept='application/json'] - Accept header
 * @returns {Promise<{status: number, data: string}>}
 */
function obsidianRequest({ port, apiKey, path, method = 'GET', accept = 'application/json' }) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port: port,
            path: path,
            method: method,
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Accept': accept,
            },
            timeout: 30000,
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                resolve({ status: res.statusCode, data: data });
            });
        });

        req.on('error', (err) => {
            reject(err);
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timed out'));
        });

        req.end();
    });
}

/**
 * Encode a vault path for use in the Obsidian REST API URL.
 * Encodes each path segment individually to preserve slashes.
 * @param {string} vaultPath - Path like "LA World/Characters/Alice.md"
 * @returns {string} URL-encoded path like "LA%20World/Characters/Alice.md"
 */
function encodeVaultPath(vaultPath) {
    return vaultPath.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

/**
 * Recursively collects all file paths from the Obsidian vault directory listing.
 * The Obsidian REST API returns { files: [...] } where entries ending in / are directories.
 * Note: The API returns paths relative to the queried directory.
 * @param {number} port
 * @param {string} apiKey
 * @param {string} directory - Directory path (e.g. '' for root, 'LA World')
 * @returns {Promise<string[]>} Array of full file paths
 */
async function listAllFiles(port, apiKey, directory = '') {
    const urlPath = directory ? `/vault/${encodeVaultPath(directory)}/` : '/vault/';
    const res = await obsidianRequest({ port, apiKey, path: urlPath });

    if (res.status !== 200) {
        throw new Error(`Failed to list files at "${directory}": HTTP ${res.status}`);
    }

    const listing = JSON.parse(res.data);
    const files = listing.files || [];
    const allFiles = [];
    const prefix = directory ? directory + '/' : '';

    for (const file of files) {
        if (file.endsWith('/')) {
            // It's a directory, recurse with the full path
            const dirName = file.slice(0, -1); // Remove trailing /
            const fullDirPath = prefix + dirName;
            const subFiles = await listAllFiles(port, apiKey, fullDirPath);
            allFiles.push(...subFiles);
        } else {
            allFiles.push(prefix + file);
        }
    }

    return allFiles;
}

async function init(router) {
    // Parse JSON bodies
    const express = require('express');
    router.use(express.json());

    /**
     * POST /test - Test connection to Obsidian REST API
     */
    router.post('/test', async (req, res) => {
        try {
            const { port, apiKey } = req.body;

            if (!port) {
                return res.status(400).json({ error: 'Missing port' });
            }

            // The root endpoint / doesn't require auth and returns server info
            const result = await obsidianRequest({
                port,
                apiKey: apiKey || '',
                path: '/',
            });

            if (result.status === 200) {
                const serverInfo = JSON.parse(result.data);
                return res.json({
                    ok: true,
                    authenticated: serverInfo.authenticated || false,
                    versions: serverInfo.versions || {},
                });
            }

            return res.json({ ok: false, error: `HTTP ${result.status}` });
        } catch (err) {
            return res.json({ ok: false, error: err.message });
        }
    });

    /**
     * POST /files - List all files in the vault
     */
    router.post('/files', async (req, res) => {
        try {
            const { port, apiKey } = req.body;

            if (!port || !apiKey) {
                return res.status(400).json({ error: 'Missing port or apiKey' });
            }

            const files = await listAllFiles(port, apiKey);
            return res.json({ files });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    });

    /**
     * POST /file - Get a single file's content
     */
    router.post('/file', async (req, res) => {
        try {
            const { port, apiKey, filename } = req.body;

            if (!port || !apiKey || !filename) {
                return res.status(400).json({ error: 'Missing port, apiKey, or filename' });
            }

            const result = await obsidianRequest({
                port,
                apiKey,
                path: `/vault/${encodeVaultPath(filename)}`,
                accept: 'text/markdown',
            });

            if (result.status === 200) {
                return res.json({ content: result.data });
            }

            return res.status(result.status).json({ error: `HTTP ${result.status}` });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    });

    /**
     * POST /index - Fetch all .md files and return their contents
     * This is the main endpoint used by the client extension to build the vault index.
     */
    router.post('/index', async (req, res) => {
        try {
            const { port, apiKey } = req.body;

            if (!port || !apiKey) {
                return res.status(400).json({ error: 'Missing port or apiKey' });
            }

            // List all files
            const allFiles = await listAllFiles(port, apiKey);
            const mdFiles = allFiles.filter(f => f.endsWith('.md'));

            // Fetch content in parallel batches of 10
            const BATCH_SIZE = 10;
            const results = [];

            for (let i = 0; i < mdFiles.length; i += BATCH_SIZE) {
                const batch = mdFiles.slice(i, i + BATCH_SIZE);
                const batchResults = await Promise.all(
                    batch.map(async (filename) => {
                        try {
                            const result = await obsidianRequest({
                                port,
                                apiKey,
                                path: `/vault/${encodeVaultPath(filename)}`,
                                accept: 'text/markdown',
                            });
                            if (result.status === 200) {
                                return { filename, content: result.data };
                            }
                            return null;
                        } catch {
                            return null;
                        }
                    }),
                );
                results.push(...batchResults.filter(Boolean));
            }

            return res.json({ files: results, total: mdFiles.length });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    });

    console.log('[DeepLore] Server plugin initialized');
}

async function exit() {
    console.log('[DeepLore] Server plugin shutting down');
}

module.exports = { info, init, exit };
