#!/usr/bin/env bash
# Sign the bundled binaries, then notarize the packed .mcpb so macOS will run it
# on a machine that downloaded it.
#
# Why this exists: measured behaviour, not theory. An unsigned binary carrying
# the com.apple.quarantine attribute is killed by Gatekeeper with SIGKILL and
# produces no output at all - `spctl -a -t execute` reports "rejected". The
# extension therefore works perfectly for whoever built it and dies instantly
# for everyone who downloads it. Locally built files never get the quarantine
# attribute, which is exactly why this never shows up in development.
#
#   bash scripts/sign-and-notarize.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Version comes from the manifest, never a literal. This was pinned at 0.3.3
# while the manifest moved to 0.5.1, so the script notarized current code under
# a stale filename - and since Claude Desktop refuses to replace an install of
# the same version, shipping that would have silently kept old code running on
# the user's machine.
VERSION="$(python3 -c "import json;print(json.load(open('$ROOT/manifest.json'))['version'])")"
BUNDLE="$ROOT/spotify-playlist-downloader-$VERSION.mcpb"
VENDOR="$ROOT/vendor/darwin-arm64"
KEYCHAIN_PROFILE="${NOTARY_PROFILE:-spotify-mcpb-notary}"

# --- Preflight ------------------------------------------------------------

# `|| true` is load-bearing. Under `set -e` with `pipefail`, grep finding nothing
# fails the whole pipeline and kills the script at this assignment - before the
# emptiness check below, so the user gets a silent exit 1 instead of the
# explanation. No certificate is the expected first-run state, not an error.
IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
  | grep "Developer ID Application" | head -1 | sed 's/.*"\(.*\)".*/\1/' || true)"

if [ -z "$IDENTITY" ]; then
  cat >&2 <<'EOF'
No "Developer ID Application" certificate found in the keychain.

An "Apple Development" certificate is not sufficient - that one only signs
builds for your own devices. Distribution outside the App Store needs a
Developer ID Application certificate, which is included in the membership at
no extra cost.

To create one:
  1. Accept the current Program License Agreement if prompted, or Certificates
     stays locked.
  2. developer.apple.com/account/resources/certificates/add
  3. Choose "Developer ID Application".
  4. Upload the request at ~/mcps/credentials/apple/developerID.certSigningRequest
  5. Download the .cer and double-click it to install, then re-run this script.
EOF
  exit 1
fi

echo "==> signing identity: $IDENTITY"

if ! security find-generic-password -s "com.apple.gs.appleid.auth" >/dev/null 2>&1 \
   && ! xcrun notarytool history --keychain-profile "$KEYCHAIN_PROFILE" >/dev/null 2>&1; then
  cat >&2 <<EOF

No stored notary credentials for profile "$KEYCHAIN_PROFILE".

Store them once - this needs an app-specific password, which you create at
appleid.apple.com under Sign-In and Security. Run this yourself; it prompts for
the password interactively and nothing else needs it afterwards:

  xcrun notarytool store-credentials "$KEYCHAIN_PROFILE" \\
    --apple-id walk.adm@gmail.com \\
    --team-id NLVS8YTTQT

Then re-run this script.
EOF
  exit 1
fi

# --- Sign the engines -----------------------------------------------------
#
# Each vendored binary is signed individually. --options runtime enables the
# hardened runtime, which notarization requires. --timestamp embeds a trusted
# timestamp so the signature stays valid after the certificate expires.

ENTITLEMENTS="$ROOT/scripts/pyinstaller.entitlements"

echo "==> signing bundled engines"
for bin in ffmpeg spotdl yt-dlp; do
  path="$VENDOR/$bin"
  [ -f "$path" ] || { echo "missing $path" >&2; exit 1; }

  # spotdl and yt-dlp are PyInstaller bundles: they extract an embedded Python
  # runtime and its shared libraries at startup and execute them. Under the
  # hardened runtime that is blocked, so they sign cleanly and then refuse to
  # run. ffmpeg is a plain native binary and needs no entitlements.
  ent=()
  case "$bin" in
    spotdl|yt-dlp) ent=(--entitlements "$ENTITLEMENTS") ;;
  esac

  # Retry once on failure. codesign intermittently returns
  # errSecInternalComponent when signing several binaries back to back - seen on
  # yt-dlp, the only universal (x86_64 + arm64) binary here, which has roughly
  # twice the hashes to compute. An immediate retry succeeds. Failing the whole
  # build on a transient keychain race is not worth it.
  if ! codesign --force --timestamp --options runtime "${ent[@]+"${ent[@]}"}" \
       --sign "$IDENTITY" "$path" 2>/dev/null; then
    echo "    retrying $bin after a transient signing error"
    sleep 2
    codesign --force --timestamp --options runtime "${ent[@]+"${ent[@]}"}" \
      --sign "$IDENTITY" "$path"
  fi
  codesign --verify --strict --verbose=1 "$path" 2>&1 | sed 's/^/    /'
done

# spotdl is a PyInstaller bundle that unpacks itself at runtime. If the hardened
# runtime blocks that, it needs an entitlement to allow unsigned executable
# memory. Verify by running it, not by assuming.
# The menu bar app is signed as a bundle, not a loose binary, and is never
# executed as a check - it is a GUI agent with no --version flag and running it
# would block the build.
echo "==> signing the menu bar app"
if [ -d "$VENDOR/SpotifyProgress.app" ]; then
  codesign --force --timestamp --options runtime --deep \
    --sign "$IDENTITY" "$VENDOR/SpotifyProgress.app"
  codesign --verify --strict --verbose=1 "$VENDOR/SpotifyProgress.app" 2>&1 | sed 's/^/    /'
else
  echo "    WARNING: SpotifyProgress.app missing - run scripts/build-menubar.sh" >&2
fi

echo "==> confirming the signed engines still execute"
for bin in ffmpeg spotdl yt-dlp; do   # statusbar excluded: GUI app, no --version, would hang
  arg="--version"; [ "$bin" = "ffmpeg" ] && arg="-version"
  if "$VENDOR/$bin" "$arg" >/dev/null 2>&1; then
    echo "    OK  $bin"
  else
    echo "    FAILED  $bin does not run after signing." >&2
    echo "    A PyInstaller bundle under the hardened runtime may need" >&2
    echo "    com.apple.security.cs.allow-unsigned-executable-memory." >&2
    exit 1
  fi
done

# --- Repack, then notarize ------------------------------------------------
#
# Order matters: the bundle must be repacked AFTER signing, or it carries the
# unsigned binaries and notarization is pointless.

echo "==> repacking with the signed engines"
cd "$ROOT"
rm -f ./*.mcpb
npx --yes @anthropic-ai/mcpb pack . >/dev/null
[ -f mcpb.mcpb ] && mv mcpb.mcpb "$(basename "$BUNDLE")"

echo "==> submitting to Apple's notary service (this takes a few minutes)"
xcrun notarytool submit "$BUNDLE" \
  --keychain-profile "$KEYCHAIN_PROFILE" \
  --wait

# Verify by running the binaries under quarantine, not with spctl.
#
# `spctl -a -t install` on a .mcpb always reports "rejected: no usable
# signature" - a .mcpb is a zip, and a zip carries no signature. The signatures
# live on the binaries inside it. That check looks like a failure and is simply
# the wrong tool, so it is replaced with the test that reflects reality: extract
# a quarantined copy and execute each engine, exactly as a user's machine does.
echo "==> verifying under quarantine (what a downloaded copy actually faces)"
QT="$(mktemp -d)"
cp "$BUNDLE" "$QT/" 
xattr -w com.apple.quarantine "0083;0;Safari;$(uuidgen)" "$QT/$(basename "$BUNDLE")"
unzip -qo "$QT/$(basename "$BUNDLE")" -d "$QT/x"
fail=0
for b in ffmpeg spotdl yt-dlp; do
  a="--version"; [ "$b" = "ffmpeg" ] && a="-version"
  if "$QT/x/vendor/darwin-arm64/$b" "$a" >/dev/null 2>&1; then
    echo "    OK      $b runs while quarantined"
  else
    echo "    BLOCKED $b was killed by Gatekeeper" >&2
    fail=1
  fi
done
rm -rf "$QT"
[ "$fail" -eq 0 ] || { echo "Notarization did not take effect." >&2; exit 1; }

echo
echo "Done. Verify the real user experience before shipping:"
echo "  xattr -w com.apple.quarantine '0083;0;Safari;' <a copy of the bundle>"
echo "  then install that copy and run check_setup."
echo "That is the only test that reproduces what someone downloading it gets."
