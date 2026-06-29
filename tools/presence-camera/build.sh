#!/bin/bash
# Build PresenceDetect as a .app bundle so macOS TCC grants camera access
# when launched from launchd (non-GUI context).
#
# Usage: ./build.sh
# Output: ./PresenceDetect.app

set -euo pipefail
cd "$(dirname "$0")"

APP="PresenceDetect.app"
CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"

echo "Building PresenceDetect..."

swiftc -O -o PresenceDetect PresenceDetect.swift \
  -framework AVFoundation -framework Vision \
  -framework CoreMedia 2>&1

rm -rf "$APP"
mkdir -p "$MACOS"
mv PresenceDetect "$MACOS/"

cat > "$CONTENTS/Info.plist" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>PresenceDetect</string>
  <key>CFBundleIdentifier</key>
  <string>com.marknutter.presence-detect</string>
  <key>CFBundleVersion</key>
  <string>1.0</string>
  <key>CFBundleExecutable</key>
  <string>PresenceDetect</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSCameraUsageDescription</key>
  <string>PresenceDetect uses the camera to check if someone is sitting at the desk for presence detection.</string>
</dict>
</plist>
EOF

echo "✅ Built $APP"
echo ""
echo "First run: open PresenceDetect.app to trigger the camera permission dialog."
echo "After granting, the daemon can use it headlessly."
