#!/usr/bin/env bash
# Full end-to-end suite. Every layer, in the order a real user hits them.
#
#   bash scripts/test-all.sh
#
# Deliberately NOT hermetic: it downloads real audio and talks to real services,
# because every interesting failure in this project has been at a boundary a mock
# would have hidden - DNS, rate limits, Gatekeeper, a linker preferring a dylib.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PASS=0; FAIL=0
declare -a RESULTS

record() {
  if [ "$1" -eq 0 ]; then PASS=$((PASS+1)); RESULTS+=("PASS  $2"); echo "  PASS  $2"
  else FAIL=$((FAIL+1)); RESULTS+=("FAIL  $2"); echo "  FAIL  $2"; fi
}

echo "=== 1. Engine licence and self-containment ==="
FF="$ROOT/vendor/darwin-arm64/ffmpeg"
"$FF" -version 2>/dev/null | grep -qE '\-\-enable-(gpl|nonfree)' && record 1 "ffmpeg is LGPL (no gpl/nonfree)" || record 0 "ffmpeg is LGPL (no gpl/nonfree)"
otool -L "$FF" | tail -n +2 | grep -qvE '/usr/lib/|/System/' && record 1 "ffmpeg self-contained" || record 0 "ffmpeg self-contained"

echo "=== 2. Code signature and notarization ==="
for b in ffmpeg spotdl yt-dlp; do
  codesign --verify --strict "$ROOT/vendor/darwin-arm64/$b" 2>/dev/null
  record $? "$b signature valid"
done

echo "=== 3. Quarantine survival (what a downloaded copy faces) ==="
QT="$(mktemp -d)"
BUNDLE="$ROOT/spotify-playlist-downloader-0.2.2.mcpb"
if [ -f "$BUNDLE" ]; then
  cp "$BUNDLE" "$QT/b.mcpb"
  xattr -w com.apple.quarantine "0083;0;Safari;$(uuidgen)" "$QT/b.mcpb"
  unzip -qo "$QT/b.mcpb" -d "$QT/x"
  for b in ffmpeg spotdl yt-dlp; do
    a="--version"; [ "$b" = "ffmpeg" ] && a="-version"
    "$QT/x/vendor/darwin-arm64/$b" "$a" >/dev/null 2>&1
    record $? "$b runs while quarantined"
  done
else
  record 1 "bundle present for quarantine test"
fi
rm -rf "$QT"

echo "=== 4. MCP protocol surface ==="
node scripts/smoke.mjs >/tmp/ta-smoke.log 2>&1
record $? "smoke suite (6 protocol checks)"

echo "=== 5. Playlist numbering (metadata only, no audio) ==="
# The one untested code path. {list-position} is populated for playlists but
# empty for albums and tracks, which is why the template is chosen per link
# type. Verified from metadata so it needs no bulk download.
rm -f /tmp/ta-pl.spotdl
if [ -n "${PLAYLIST_URL:-}" ]; then
  "$ROOT/vendor/darwin-arm64/spotdl" save "$PLAYLIST_URL" --save-file /tmp/ta-pl.spotdl >/dev/null 2>&1
  python3 - <<'PY'
import json, sys
try:
    d = json.load(open('/tmp/ta-pl.spotdl'))
except Exception:
    sys.exit(1)
pos = [t.get('list_position') for t in d[:5]]
print(f"      {len(d)} tracks, list_position: {pos}")
sys.exit(0 if all(p is not None for p in pos) else 1)
PY
  record $? "playlist populates {list-position}"
else
  echo "      skipped - set PLAYLIST_URL to run"
fi

echo "=== 6. Real download, end to end ==="
node scripts/e2e.mjs "https://open.spotify.com/track/4wajJ1o7jWIg62YqpkHC7S" --clean >/tmp/ta-track.log 2>&1
record $? "single track downloads and tags"

node scripts/e2e.mjs "https://open.spotify.com/album/5vkqYmiPBYLaalcmjujWxK" --clean >/tmp/ta-album.log 2>&1
record $? "album downloads, numbered, counts reconcile"

echo
echo "================================"
printf '%s\n' "${RESULTS[@]}"
echo "================================"
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || echo "logs: /tmp/ta-*.log"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
