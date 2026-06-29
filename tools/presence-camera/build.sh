#!/bin/bash
# Build FaceDetect as a .app bundle so macOS TCC grants camera access
# when launched from launchd (non-GUI context).
#
# Usage: ./build.sh
# Output: ./FaceDetect.app

set -euo pipefail
cd "$(dirname "$0")"

APP="FaceDetect.app"
CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"

echo "Building FaceDetect..."

swiftc -O -o FaceDetect FaceDetect.swift \
  -framework AVFoundation -framework Vision \
  -framework CoreMedia 2>&1

rm -rf "$APP"
mkdir -p "$MACOS"
cp FaceDetect "$MACOS/"

cat > "$CONTENTS/Info.plist" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>FaceDetect</string>
  <key>CFBundleIdentifier</key>
  <string>com.marknutter.face-detect</string>
  <key>CFBundleVersion</key>
  <string>1.0</string>
  <key>CFBundleExecutable</key>
  <string>FaceDetect</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSCameraUsageDescription</key>
  <string>FaceDetect uses the camera to check if someone is sitting at the desk for presence detection.</string>
</dict>
</plist>
EOF

echo "✅ Built $APP"
echo ""
echo "First run: open FaceDetect.app to trigger the camera permission dialog."
echo "After granting, the daemon can use it headlessly."
