#!/usr/bin/env bash
# Build the menu bar indicator as a proper .app bundle.
#
# A bare Mach-O executable can create an NSStatusItem in principle, and it even
# launches and stays resident - but no item appears in the menu bar. Measured:
# the bare binary ran with a live pid and an empty menu bar; the identical code
# inside a .app with LSUIElement showed up immediately.
#
# The first version of this shipped the bare binary, so the feature was dead for
# anyone who installed the bundle while working during development, where it had
# been launched from a .app by hand.
#
#   bash scripts/build-menubar.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/vendor/darwin-arm64/SpotifyProgress.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

echo "==> compiling"
swiftc -O -o "$APP/Contents/MacOS/SpotifyProgress" \
  "$ROOT/menubar/StatusBar.swift" -framework Cocoa

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>SpotifyProgress</string>
  <key>CFBundleIdentifier</key><string>ai.atlanticlabs.spotify-progress</string>
  <key>CFBundleName</key><string>Spotify Progress</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <!-- Agent app: menu bar only. Without this it takes a Dock icon and an app
       switcher entry, which is wrong for a status indicator. -->
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
</dict>
PLIST
echo "</plist>" >> "$APP/Contents/Info.plist"

chmod +x "$APP/Contents/MacOS/SpotifyProgress"

# The bare binary is no longer shipped; leaving it would be a second copy that
# silently does nothing.
rm -f "$ROOT/vendor/darwin-arm64/spotify-statusbar"

echo "built: $APP"
du -sh "$APP" | awk '{print "  size:", $1}'
