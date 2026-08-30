#!/usr/bin/env bash
#
# Build SpaceFore.app.
#
# There is no .xcodeproj on purpose. An Xcode project file is a large generated
# thing that is tedious to review and easy to break invisibly; this app is one
# Swift file and a handful of resources, so a script that says exactly what goes
# into the bundle is easier to trust and easier to change. You need Xcode or the
# Command Line Tools installed for `swiftc`, which is the only thing this uses.
#
#   ./macos/build.sh                 build it
#   ./macos/build.sh --embed-node    ...and put a copy of Node inside, so the
#                                    app works on a Mac without Node installed
#   ./macos/build.sh --install       ...and move it into /Applications
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
APP="$HERE/build/SpaceFore.app"

EMBED_NODE=0
INSTALL=0
for argument in "$@"; do
  case "$argument" in
    --embed-node) EMBED_NODE=1 ;;
    --install) INSTALL=1 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $argument" >&2; exit 1 ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This builds a macOS app, so it has to run on a Mac." >&2
  exit 1
fi

command -v swiftc >/dev/null 2>&1 || {
  echo "swiftc is missing. Install Xcode, or just the Command Line Tools:" >&2
  echo "  xcode-select --install" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || {
  echo "Node.js is missing. Install it from nodejs.org or with: brew install node" >&2
  exit 1
}

# ---------------------------------------------------------------- the web app

echo "==> Building the web app"
cd "$ROOT"
[[ -d node_modules ]] || npm ci
npm run build

# ------------------------------------------------------------- the app bundle

echo "==> Assembling SpaceFore.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cp "$HERE/Info.plist" "$APP/Contents/Info.plist"

# The web app, and the server that serves it. `server/index.mjs` resolves `dist/`
# relative to its own location, so the two must keep their positions.
cp -R "$ROOT/dist" "$APP/Contents/Resources/dist"
mkdir -p "$APP/Contents/Resources/server"
cp "$ROOT/server/"*.mjs "$APP/Contents/Resources/server/"
rm -f "$APP/Contents/Resources/server/"*.test.mjs

if [[ "$EMBED_NODE" == "1" ]]; then
  NODE_PATH="$(command -v node)"
  echo "==> Embedding $(node --version) from $NODE_PATH"
  cp "$NODE_PATH" "$APP/Contents/Resources/node"
  chmod +x "$APP/Contents/Resources/node"
fi

# ------------------------------------------------------------------- the icon

if command -v iconutil >/dev/null 2>&1 && command -v sips >/dev/null 2>&1; then
  echo "==> Drawing the icon"
  ICONSET="$HERE/build/SpaceFore.iconset"
  rm -rf "$ICONSET"
  mkdir -p "$ICONSET"
  SOURCE="$ROOT/public/icon-512.png"
  for size in 16 32 64 128 256 512; do
    sips -z $size $size "$SOURCE" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    sips -z $double $double "$SOURCE" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/SpaceFore.icns"
  rm -rf "$ICONSET"
else
  echo "==> Skipping the icon (iconutil/sips not available)"
fi

# ------------------------------------------------------------------ the binary

echo "==> Compiling"
swiftc \
  -O \
  -target "$(uname -m)-apple-macosx12.0" \
  -framework AppKit \
  -framework WebKit \
  -o "$APP/Contents/MacOS/SpaceFore" \
  "$HERE/Sources/SpaceForeApp.swift"

# An ad-hoc signature is enough to run it on the Mac that built it, and keeps
# macOS from asking about an unsigned binary every launch. Distributing it to
# anyone else needs a Developer ID and notarisation, which is out of scope here.
if command -v codesign >/dev/null 2>&1; then
  echo "==> Signing (ad-hoc)"
  codesign --force --deep --sign - "$APP" 2>/dev/null || echo "    (signing failed; the app still runs)"
fi

if [[ "$INSTALL" == "1" ]]; then
  echo "==> Installing to /Applications"
  rm -rf "/Applications/SpaceFore.app"
  cp -R "$APP" /Applications/
  APP="/Applications/SpaceFore.app"
fi

echo
echo "Built: $APP"
echo "Open it with:  open \"$APP\""
if [[ "$EMBED_NODE" != "1" ]]; then
  echo
  echo "It runs Node from your Mac. To make it work without Node installed,"
  echo "build again with --embed-node."
fi
