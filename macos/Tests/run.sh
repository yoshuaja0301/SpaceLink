#!/usr/bin/env bash
#
# Compile and run the parts of the Mac app that do not need a Mac.
#
#   ./macos/Tests/run.sh
#
# `SyncServer.swift` imports nothing but Foundation, so it compiles and runs on
# any platform Swift supports. That matters because it is the half of the app
# where a mistake is expensive — it launches the notes server, waits for it to
# report where it is listening, and shuts it down again. The AppKit half can
# only be exercised on a Mac, which is why so little lives there.
#
# Needs `swiftc` and `node`. Skips, rather than fails, when Swift is absent.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found — skipping the Swift checks."
  echo "  macOS:  xcode-select --install"
  echo "  Linux:  https://swift.org/download"
  exit 0
fi

command -v node >/dev/null 2>&1 || {
  echo "node not found; these checks run the real notes server." >&2
  exit 1
}

echo "==> Compiling SyncServer.swift"
# `-parse-as-library` matches how both the Xcode target and build.sh compile the
# app, so this checks the same thing they will.
swiftc \
  -parse-as-library \
  -o "$OUT/SyncServerTests" \
  "$HERE/../Sources/SyncServer.swift" \
  "$HERE/SyncServerTests.swift"

echo "==> Running"
"$OUT/SyncServerTests" "$(command -v node)" "$REPO/server/index.mjs"
