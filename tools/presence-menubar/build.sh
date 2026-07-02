#!/bin/bash
# Build the Presence Monitor as a proper macOS .app bundle.
#
# Usage: ./build.sh
# Output: ./PresenceMonitor.app (can be double-clicked, dragged to /Applications, etc.)

set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="PresenceMonitor"
APP_DIR="$APP_NAME.app"
CONTENTS="$APP_DIR/Contents"
MACOS="$CONTENTS/MacOS"

echo "Building $APP_NAME..."

# Compile
swiftc -O -o "$APP_NAME" PresenceMenuBar.swift -framework Cocoa 2>&1

# Create .app bundle structure
rm -rf "$APP_DIR"
mkdir -p "$MACOS"
mv "$APP_NAME" "$MACOS/"

# Create Info.plist
cat > "$CONTENTS/Info.plist" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Presence Monitor</string>
  <key>CFBundleDisplayName</key>
  <string>Presence Monitor</string>
  <key>CFBundleIdentifier</key>
  <string>com.marknutter.presence-menubar</string>
  <key>CFBundleVersion</key>
  <string>1.0</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleExecutable</key>
  <string>PresenceMonitor</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSCameraUsageDescription</key>
  <string>Presence Monitor uses the camera for face detection to determine if you are at your desk.</string>
</dict>
</plist>
EOF

echo "✅ Built $APP_DIR"
echo ""
echo "To install:"
echo "  cp -r $APP_DIR /Applications/"
echo ""
echo "To add to Login Items:"
echo "  System Settings → General → Login Items → add Presence Monitor"
echo ""
echo "Or use the launchd plist (already configured) for auto-start."
