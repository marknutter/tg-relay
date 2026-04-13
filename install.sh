#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_NAME="com.marknutter.tg-relay"
PLIST_SRC="$SCRIPT_DIR/$PLIST_NAME.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"
PLUGIN_ENTRY="$SCRIPT_DIR/src/plugin.ts"
BUN="$(command -v bun || echo /opt/homebrew/bin/bun)"

echo "tg-relay installer"
echo "=================="
echo ""

# Check prerequisites
if [ ! -x "$BUN" ]; then
  echo "Error: bun not found. Install from https://bun.sh"
  exit 1
fi

if [ ! -f "$PLIST_SRC" ]; then
  echo "Error: $PLIST_SRC not found. Run from the tg-relay repo root."
  exit 1
fi

# Install dependencies if needed
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  echo "Installing dependencies..."
  (cd "$SCRIPT_DIR" && bun install)
fi

# 1. Install launchd service
echo ""
echo "1. Installing launchd service..."

if launchctl list "$PLIST_NAME" &>/dev/null; then
  echo "   Unloading existing service..."
  launchctl unload "$PLIST_DST" 2>/dev/null || true
fi

cp "$PLIST_SRC" "$PLIST_DST"
launchctl load "$PLIST_DST"
echo "   Installed and loaded: $PLIST_DST"
echo "   Daemon will auto-start on boot and restart on crash."

# 2. Register MCP plugin
echo ""
echo "2. Registering MCP plugin..."

# Remove if already registered (to update the path)
claude mcp remove tg-relay 2>/dev/null || true
claude mcp add tg-relay --scope user -- "$BUN" "$PLUGIN_ENTRY"
echo "   Registered: claude mcp add tg-relay --scope user -- $BUN $PLUGIN_ENTRY"

# 3. Optionally disable built-in telegram plugin
echo ""
echo "3. Built-in Telegram plugin"
if claude mcp list 2>/dev/null | grep -q "plugin:telegram:telegram"; then
  echo "   The built-in telegram plugin is currently active."
  read -rp "   Disable it? (recommended to avoid conflicts) [Y/n] " answer
  answer="${answer:-Y}"
  if [[ "$answer" =~ ^[Yy] ]]; then
    claude mcp remove "plugin:telegram:telegram" 2>/dev/null || true
    echo "   Disabled built-in telegram plugin."
  else
    echo "   Kept built-in telegram plugin (may conflict with tg-relay)."
  fi
else
  echo "   Built-in telegram plugin not found (already disabled or not installed)."
fi

echo ""
echo "Done! The daemon is now polling all configured bots at:"
echo "  ~/.claude/channels/telegram-*/"
echo ""
echo "New Claude Code sessions will automatically connect via the tg-relay plugin."
echo "Check daemon logs: tail -f ~/.claude/channels/telegram-router.log"
