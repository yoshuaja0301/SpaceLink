#!/usr/bin/env bash
#
# Build SpaceFore.app, without opening Xcode.
#
# There is an Xcode project beside this — SpaceFore.xcodeproj — and it builds
# the same app. This script is the one to use from a terminal or a Makefile: it
# needs only `swiftc`, which comes with the Command Line Tools, and it says in
# one screen exactly what ends up in the bundle. Both call copy-resources.sh, so
# neither can quietly diverge from the other.
#
#   ./macos/build.sh                 build it
#   ./macos/build.sh --embed-node    ...and put a copy of Node inside, so the
#                                    app works on a Mac without Node installed
#                                    (NODE=/path/to/node chooses which; it must
#                                    be the self-contained nodejs.org build)
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

# ---------------------------------------------------------- the app bundle

echo "==> Assembling SpaceFore.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$HERE/Info.plist" "$APP/Contents/Info.plist"

# Builds the web app and puts it, the server and the icon into Resources. The
# Xcode project's script phase calls this same script, so the two ways of
# building produce the same bundle.
"$HERE/copy-resources.sh" "$APP/Contents/Resources"

if [[ "$EMBED_NODE" == "1" ]]; then
  # NODE=/path/to/node picks which one goes in; otherwise whatever is first on
  # PATH. Either way it has to be self-contained: Homebrew's node links against
  # twenty of Homebrew's own dylibs and dies on a Mac without them, which is
  # the one Mac --embed-node exists for. embed-node-check.sh refuses those.
  NODE_PATH="${NODE:-$(command -v node)}"
  "$HERE/embed-node-check.sh" "$NODE_PATH"
  echo "==> Embedding $("$NODE_PATH" --version) from $NODE_PATH"
  cp "$NODE_PATH" "$APP/Contents/Resources/node"
  chmod +x "$APP/Contents/Resources/node"
fi

# ------------------------------------------------------------------ the binary

echo "==> Compiling"
# `-parse-as-library` is what Xcode passes for an application target, and under
# it a statement at the top of a file is an error rather than a program. Passing
# it here too means both ways of building agree about what they are compiling.
swiftc \
  -O \
  -parse-as-library \
  -target "$(uname -m)-apple-macosx12.0" \
  -framework AppKit \
  -framework WebKit \
  -o "$APP/Contents/MacOS/SpaceFore" \
  "$HERE/Sources/SyncServer.swift" \
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
