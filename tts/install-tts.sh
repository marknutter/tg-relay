#!/bin/bash
# tg-relay-tts installer — sets up the voice-out sidecar.
#
# Idempotent: safe to re-run. Creates a project-local .venv under tts/,
# installs pinned deps, writes a launchd plist, loads it.

set -euo pipefail

TTS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$TTS_DIR/.." && pwd)"
VENV_DIR="$TTS_DIR/.venv"
PYTHON_BIN="$VENV_DIR/bin/python"
SERVER_PY="$TTS_DIR/server.py"

PLIST_NAME="com.marknutter.tg-relay-tts"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"
LOG_FILE="$HOME/.claude/channels/tg-relay-tts.log"

if ! command -v uv &>/dev/null; then
  echo "Error: uv not found. Install from https://docs.astral.sh/uv/" >&2
  exit 1
fi

echo "tg-relay-tts installer"
echo "======================"
echo ""

# 1. Create venv with Python 3.11 (F5-TTS is version-sensitive)
echo "1. Creating venv at $VENV_DIR..."
uv venv --python 3.11 "$VENV_DIR"

# 2. Install pinned deps
echo ""
echo "2. Installing Python deps (this will pull ~3GB of PyTorch)..."
uv pip install --python "$PYTHON_BIN" -r "$TTS_DIR/requirements.txt"

# 3. Ensure log dir exists (launchd won't create it)
mkdir -p "$(dirname "$LOG_FILE")"

# 4. Generate and load launchd plist
echo ""
echo "3. Installing launchd service..."

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
    <string>$PYTHON_BIN</string>
    <string>$SERVER_PY</string>
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
  <integer>10</integer>
</dict>
</plist>
EOF

launchctl load "$PLIST_DST"
echo "   Loaded: $PLIST_DST"

echo ""
echo "Done!"
echo ""
echo "The F5-TTS model will download (~1.5GB) on first synthesis."
echo "Watch the log: tail -f $LOG_FILE"
echo ""
echo "Health check:"
echo "  curl http://127.0.0.1:8077/health"
echo ""
echo "Reference audio goes in:"
echo "  Per-channel: ~/.claude/channels/telegram-<name>/reference.wav + reference.txt"
echo "  Global fallback: ~/.cache/tg-relay-tts/reference.wav + reference.txt"
