#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_NAME="com.marknutter.tg-relay"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"
PLUGIN_ENTRY="$SCRIPT_DIR/src/plugin.ts"
DAEMON_ENTRY="$SCRIPT_DIR/src/daemon.ts"
BUN="$(command -v bun || true)"
CACHED_PLUGIN="$HOME/.claude/plugins/cache/claude-plugins-official/telegram"
LOG_FILE="$HOME/.claude/channels/telegram-router.log"

echo "tg-relay installer"
echo "=================="
echo ""

# Check prerequisites
if [ -z "$BUN" ] || [ ! -x "$BUN" ]; then
  echo "Error: bun not found on PATH. Install from https://bun.sh"
  exit 1
fi
echo "Using bun at: $BUN"

# Install dependencies if needed
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  echo "Installing dependencies..."
  (cd "$SCRIPT_DIR" && "$BUN" install)
fi

# Ensure log file's parent dir exists (launchd doesn't create it)
mkdir -p "$(dirname "$LOG_FILE")"

# 1. Generate and install launchd service
echo ""
echo "1. Installing launchd service..."

if launchctl list "$PLIST_NAME" &>/dev/null; then
  echo "   Unloading existing service..."
  launchctl unload "$PLIST_DST" 2>/dev/null || true
fi

mkdir -p "$(dirname "$PLIST_DST")"
cat > "$PLIST_DST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$PLIST_NAME</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BUN</string>
    <string>$DAEMON_ENTRY</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_FILE</string>
  <key>StandardErrorPath</key>
  <string>$LOG_FILE</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$HOME</string>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
</dict>
</plist>
EOF

launchctl load "$PLIST_DST"
echo "   Installed and loaded: $PLIST_DST"
echo "   Daemon will auto-start on boot and restart on crash."

# 2. Hijack the built-in telegram plugin to run tg-relay
# Claude Code only delivers channel notifications to servers named in --channels.
# The internal server name is "plugin:telegram:telegram", which comes from the
# built-in plugin system. We can't register a custom channel server — so we
# redirect the built-in plugin's .mcp.json to run our plugin.ts instead.
echo ""
echo "2. Configuring plugin..."

# Hijack EVERY cached version, not just the latest. Claude Code may auto-update
# the plugin at any time, and any existing Claude sessions keep running against
# their original version. If an un-hijacked version is loaded, it'll poll the
# bot token directly and cause 409 Conflict fights with the daemon.
HIJACKED=0
if [ -d "$CACHED_PLUGIN" ]; then
  for version_dir in "$CACHED_PLUGIN"/*/; do
    [ -d "$version_dir" ] || continue
    MCP_JSON="$version_dir/.mcp.json"
    if [ -f "$MCP_JSON" ]; then
      if [ ! -f "$MCP_JSON.bak" ]; then
        cp "$MCP_JSON" "$MCP_JSON.bak"
      fi
      cat > "$MCP_JSON" << EOF
{
  "mcpServers": {
    "telegram": {
      "command": "$BUN",
      "args": ["$PLUGIN_ENTRY"]
    }
  }
}
EOF
      echo "   Redirected $MCP_JSON -> $PLUGIN_ENTRY"
      HIJACKED=$((HIJACKED + 1))
    fi

    # Also hijack the cached skills so /telegram:access and /telegram:configure
    # use per-channel state dirs (telegram-{name}/) instead of the upstream's
    # single hardcoded ~/.claude/channels/telegram/ path.
    for SKILL in access configure; do
      DST_SKILL="$version_dir/skills/$SKILL/SKILL.md"
      SRC_SKILL="$SCRIPT_DIR/skills/$SKILL/SKILL.md"
      if [ -f "$DST_SKILL" ] && [ -f "$SRC_SKILL" ]; then
        [ -f "$DST_SKILL.bak" ] || cp "$DST_SKILL" "$DST_SKILL.bak"
        cp "$SRC_SKILL" "$DST_SKILL"
        echo "   Patched $DST_SKILL"
      fi
    done
  done
fi

if [ "$HIJACKED" -eq 0 ]; then
  echo "   Warning: built-in telegram plugin not found in cache."
  echo "   Make sure telegram@claude-plugins-official is installed."
else
  echo "   Hijacked $HIJACKED cached version(s)."
fi

# 3. Disable the official plugin in settings (our code runs via the hijacked .mcp.json)
echo ""
echo "3. Configuring settings..."

SETTINGS="$HOME/.claude/settings.json"
if [ -f "$SETTINGS" ]; then
  python3 -c "
import json
with open('$SETTINGS') as f:
    data = json.load(f)
# Enable the plugin (so .mcp.json is loaded) but our code runs instead
data.setdefault('enabledPlugins', {})['telegram@claude-plugins-official'] = True
with open('$SETTINGS', 'w') as f:
    json.dump(data, f, indent=4)
" 2>/dev/null && echo "   Enabled telegram plugin in settings (runs tg-relay code)."
fi

# 4. Set up shell alias
echo ""
echo "4. Shell alias"
echo ""
echo "   Add this to your ~/.zshrc (or equivalent):"
echo ""
echo '   alias claude!="claude --dangerously-skip-permissions --channels plugin:telegram@claude-plugins-official"'
echo ""
echo "   The --channels flag is required for Claude Code to accept channel notifications."

echo ""
echo "Done! The daemon is now polling all configured bots at:"
echo "  ~/.claude/channels/telegram-*/"
echo ""
echo "Start a session with: claude! (from any project directory)"
echo "Check daemon logs:    tail -f $LOG_FILE"
