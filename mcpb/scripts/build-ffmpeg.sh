#!/usr/bin/env bash
# Build a redistributable, statically linked, audio-capable ffmpeg for macOS arm64.
#
# Why build rather than vendor a prebuilt binary: every convenient prebuilt macOS
# build (@ffmpeg-installer, ffmpeg-static) repackages the same upstream build,
# which is configured --enable-gpl --enable-nonfree. FFmpeg's own position is
# that a non-free build cannot be redistributed at all, which makes those
# binaries unusable in anything shipped to other people.
#
# The important detail: ffmpeg's DEFAULT configure output is LGPL. GPL only
# enters when --enable-gpl is passed for x264/x265, which are video encoders this
# tool never touches. LAME is itself LGPL, so MP3 encoding needs no GPL
# component. Hence: default config, plus libmp3lame, minus autodetect.
#
# ffmpeg is invoked as a separate executable, never linked into the extension's
# own code, so this is mere aggregation and imposes no licence obligation on the
# MIT-licensed server. The LGPL still requires shipping the licence text and
# making the source available - see THIRD-PARTY-NOTICES.md.
#
#   bash scripts/build-ffmpeg.sh
set -euo pipefail

FFMPEG_VERSION="7.1"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$ROOT/.build"
OUT="$ROOT/vendor/darwin-arm64"

BREW="$(brew --prefix)"
LAME="$BREW/opt/lame"

if [ ! -f "$LAME/lib/libmp3lame.a" ]; then
  echo "libmp3lame static library not found. Run: brew install lame" >&2
  exit 1
fi

# pkg-config is deliberately not required: libmp3lame is found by a direct link
# check, and its include/lib paths are passed explicitly below. (An empty array
# expansion under `set -u` is also an error on the bash 3.2 macOS ships.)

mkdir -p "$BUILD"

# Stage libmp3lame.a alone in its own directory.
#
# Homebrew ships both libmp3lame.a and libmp3lame.0.dylib in the same lib dir,
# and the macOS linker prefers the dylib. That produced a binary linked against
# /opt/homebrew/opt/lame/lib/libmp3lame.0.dylib, which works perfectly on a
# machine that has Homebrew and lame installed and fails immediately on the
# machine of the non-technical user this whole extension exists for. Giving the
# linker a directory that contains only the static archive removes the choice.
STATIC_LAME_DIR="$BUILD/static-lame"
mkdir -p "$STATIC_LAME_DIR"
cp "$LAME/lib/libmp3lame.a" "$STATIC_LAME_DIR/"

cd "$BUILD"

if [ ! -d "ffmpeg-$FFMPEG_VERSION" ]; then
  echo "==> fetching ffmpeg $FFMPEG_VERSION source"
  curl -fsSL "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" -o ffmpeg.tar.xz
  tar xf ffmpeg.tar.xz
fi

cd "ffmpeg-$FFMPEG_VERSION"

# --disable-autodetect is load-bearing. Without it, configure links against
# whatever Homebrew libraries happen to be installed, producing a binary with
# dylib dependencies that do not exist on the user's machine - and potentially
# pulling in a component with incompatible licence terms.
echo "==> configuring (LGPL: no --enable-gpl, no --enable-nonfree)"
./configure \
  --prefix="$BUILD/install" \
  --disable-shared \
  --enable-static \
  --disable-autodetect \
  --disable-doc \
  --disable-ffplay \
  --disable-debug \
  --enable-libmp3lame \
  --extra-cflags="-I$LAME/include" \
  --extra-ldflags="-L$STATIC_LAME_DIR" \
  >/dev/null

echo "==> building (this takes a few minutes)"
make -j"$(sysctl -n hw.ncpu)" >/dev/null

echo "==> verifying licence configuration"
CONFIG="$(./ffmpeg -version 2>/dev/null | grep configuration:)"
if echo "$CONFIG" | grep -qE '\-\-enable-(gpl|nonfree)'; then
  echo "REFUSING: built binary reports gpl or nonfree flags" >&2
  echo "$CONFIG" >&2
  exit 1
fi

echo "==> verifying mp3 encoding is present"
./ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libmp3lame || {
  echo "REFUSING: libmp3lame encoder missing from build" >&2
  exit 1
}

# A hard failure, not a warning. A binary linked against a Homebrew dylib runs
# perfectly on the build machine and dies on every machine without Homebrew,
# which is precisely the audience this extension targets. That must never be
# something a build merely mentions in passing.
echo "==> checking the binary is self-contained"
if otool -L ./ffmpeg | grep -vE '/usr/lib/|/System/|:$' | grep -q .; then
  echo "REFUSING: links against non-system libraries, so it will not run on a" >&2
  echo "machine without Homebrew:" >&2
  otool -L ./ffmpeg | grep -vE '/usr/lib/|/System/|:$' >&2
  exit 1
fi

mkdir -p "$OUT"
cp ./ffmpeg "$OUT/ffmpeg"
chmod +x "$OUT/ffmpeg"

echo
echo "installed: $OUT/ffmpeg  ($(du -h "$OUT/ffmpeg" | cut -f1))"
"$OUT/ffmpeg" -version 2>/dev/null | head -1
