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

# Xcode hands a build script almost none of your shell's PATH — not Homebrew,
# and not nvm, fnm, Volta or asdf, which live under $HOME and rely on the shell
# to find them. node-path.sh knows where all of them keep Node.
# shellcheck source=node-path.sh
. "$HERE/node-path.sh"
spacefore_add_node_paths

if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm was not found. This build ran with almost no PATH (Xcode's script phases" >&2
  echo "       start that way), and none of the usual places had Node: Homebrew, MacPorts," >&2
  echo "       nvm, fnm, Volta, asdf, n. Install Node.js from nodejs.org or with: brew install node" >&2
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
#
# The sizes are the ones Apple's iconset format names, and only those: 16, 32,
# 128, 256 and 512, each with an @2x twin. There is no 64x64 entry in that
# format, and a file iconutil does not recognise is a reason for it to refuse
# the whole set — which shipped the app with a blank icon.
if command -v iconutil >/dev/null 2>&1 && command -v sips >/dev/null 2>&1; then
  ICONSET="$(mktemp -d)/SpaceFore.iconset"
  mkdir -p "$ICONSET"
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$REPO/public/icon-512.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    sips -z "$double" "$double" "$REPO/public/icon-512.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$RESOURCES/SpaceFore.icns"
  rm -rf "$(dirname "$ICONSET")"
fi

echo "Bundled the web app and server into $RESOURCES"
