#!/usr/bin/env bash
#
# Put the web app, and the server that serves it, into an app bundle's
# Resources directory.
#
#   ./macos/copy-resources.sh <Resources directory>
#
# Both ways of building the app call this — `build.sh`, and the script phase in
# SpaceFore.xcodeproj — so there is one description of what goes into the bundle
# rather than two that drift apart.
#
# `SpaceForeApp.swift` looks for `server/index.mjs` and expects `dist/` beside
# it, because the server resolves `dist/` relative to its own file. Those two
# names and their arrangement are the contract; macos/pbxproj.test.mjs checks it
# from the other side.
#
set -euo pipefail

RESOURCES="${1:-}"
if [[ -z "$RESOURCES" ]]; then
  echo "usage: copy-resources.sh <Resources directory>" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

# Xcode hands a build script almost none of your shell's PATH, so the usual
# places Node lives are added back.
export PATH="/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:$PATH"

if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm was not found. Install Node.js from nodejs.org or with: brew install node" >&2
  exit 1
fi

cd "$REPO"
[[ -d node_modules ]] || npm ci
npm run build

mkdir -p "$RESOURCES"
rm -rf "$RESOURCES/dist" "$RESOURCES/server"
cp -R "$REPO/dist" "$RESOURCES/dist"
mkdir -p "$RESOURCES/server"
cp "$REPO/server/"*.mjs "$RESOURCES/server/"
# Tests have no business inside a shipped app.
rm -f "$RESOURCES/server/"*.test.mjs

# The icon, drawn from the same source the web app uses for its own. Skipped
# where the tools are not available, which is anywhere but a Mac.
if command -v iconutil >/dev/null 2>&1 && command -v sips >/dev/null 2>&1; then
  ICONSET="$(mktemp -d)/SpaceFore.iconset"
  mkdir -p "$ICONSET"
  for size in 16 32 64 128 256 512; do
    sips -z "$size" "$size" "$REPO/public/icon-512.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    sips -z "$double" "$double" "$REPO/public/icon-512.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$RESOURCES/SpaceFore.icns"
  rm -rf "$(dirname "$ICONSET")"
fi

echo "Bundled the web app and server into $RESOURCES"
