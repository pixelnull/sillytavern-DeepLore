#!/bin/bash
# Installs the DeepLore server plugin into SillyTavern's plugins directory.
# Run from the extension directory, or pass SillyTavern root as argument.

PLUGIN_ID="deeplore"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -n "$1" ]; then
    ST_ROOT="$1"
else
    # Try to detect: extension is typically at ST/public/scripts/extensions/third-party/<name>
    ST_ROOT="$(cd "$SCRIPT_DIR/../../../../.." 2>/dev/null && pwd)"
fi

if [ ! -f "$ST_ROOT/server.js" ] && [ ! -f "$ST_ROOT/src/server-main.js" ]; then
    echo "Error: Could not find SillyTavern at '$ST_ROOT'"
    echo "Usage: $0 [path-to-SillyTavern]"
    exit 1
fi

PLUGINS_DIR="$ST_ROOT/plugins"
TARGET="$PLUGINS_DIR/$PLUGIN_ID"

mkdir -p "$TARGET"
cp "$SCRIPT_DIR/server/index.js" "$TARGET/index.js"

echo "Server plugin installed to: $TARGET"
echo "Restart SillyTavern to load the plugin."
echo "Make sure 'enableServerPlugins: true' is set in config.yaml"
