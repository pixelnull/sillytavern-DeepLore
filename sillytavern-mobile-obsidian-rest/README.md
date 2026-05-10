# SillyTavern Mobile Obsidian REST Bridge

Optional SillyTavern server plugin for Android / Termux users who want DeepLore Enhanced to read an Obsidian vault without Obsidian's desktop-only Local REST API plugin.

Desktop users should keep using Obsidian's Local REST API plugin. This bridge is only for the mobile setup where SillyTavern runs inside Termux and can read the vault folder directly.

## What It Provides

- A Local REST API-compatible HTTP server on `127.0.0.1:27123` by default
- `GET /vault/` directory listings
- markdown reads through `GET /vault/{path}`
- markdown/plain writes through `PUT`, `POST`, or `PATCH /vault/{path}`
- `GET /vault/DeepLore/field-definitions.yaml` fallback content when the file does not exist
- simple `/tags/`, `/search/`, `/search/simple/`, and command compatibility routes used by DLE-style clients

## Install In Termux

From your SillyTavern folder:

```bash
tmpdir="$(mktemp -d)"
git clone https://github.com/pixelnull/sillytavern-DeepLore-Enhanced.git "$tmpdir/dle"
cp -R "$tmpdir/dle/sillytavern-mobile-obsidian-rest" ./plugins/sillytavern-mobile-obsidian-rest
rm -rf "$tmpdir"
```

Then set `enableServerPlugins: true` in `config.yaml`.

## Start SillyTavern

```bash
termux-setup-storage
export OBSIDIAN_VAULT="/storage/emulated/0/Documents/First Vault"
export OBSIDIAN_API_KEY="choose-a-long-random-token"
export OBSIDIAN_API_PORT=27123
node server.js
```

In DeepLore Enhanced, configure the vault connection as:

- Host: `127.0.0.1`
- Port: `27123`
- HTTPS: off
- API key: the same value as `OBSIDIAN_API_KEY`

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `OBSIDIAN_VAULT` | required | Absolute path to the Obsidian vault folder. |
| `OBSIDIAN_API_KEY` | required | Bearer token DLE sends to the bridge. Do not use `12345`. |
| `OBSIDIAN_API_HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` only on a trusted LAN. |
| `OBSIDIAN_API_PORT` | `27123` | HTTP port to expose for DLE. |
| `OBSIDIAN_API_FALLBACK_FIELDS` | `1` | Serve `fields: []` for missing `DeepLore/field-definitions.yaml`. |
| `OBSIDIAN_API_HIDE_ROOT_DOTFILES` | `1` | Hide root dot folders such as `.obsidian` from vault listings. |
| `OBSIDIAN_API_DEBUG` | `0` | Log compatibility server requests. |

The same options can use `DLE_MOBILE_OBSIDIAN_*` prefixes if you want to keep them separate from other Obsidian tooling.

## Security Notes

Server plugins are not sandboxed. This bridge can read and write the vault path you provide, and it exposes that access over HTTP to anyone who can reach its bind address and knows the API key.

Keep the default `127.0.0.1` bind address unless you specifically need another device to reach the phone. If you bind to `0.0.0.0`, use a long random API key and a trusted network only.
