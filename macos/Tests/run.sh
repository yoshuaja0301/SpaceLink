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

# ---------------------------------------------------------------- the AppKit half

echo
echo "==> Typechecking SpaceForeApp.swift against the API as Apple documents it"

# The AppKit half cannot run off a Mac, but it can be typechecked against stubs
# whose every declaration was copied from Apple's documentation for that symbol.
# That makes it a check against an independent description of the API rather
# than against itself: a wrong label, a wrong type, a wrong enum case or a
# delegate signature that does not match will not compile.
#
# What this does NOT check is in Stubs/AppKitStub.swift, and worth knowing:
# `#selector` and the responder chain, and availability on older macOS.
swiftc -emit-module -module-name AppKit -emit-module-path "$OUT/AppKit.swiftmodule" \
  "$HERE/Stubs/AppKitStub.swift"
swiftc -emit-module -module-name WebKit -emit-module-path "$OUT/WebKit.swiftmodule" -I "$OUT" \
  "$HERE/Stubs/WebKitStub.swift"

# Objective-C interop does not exist here, so `#selector(…)` and `@objc` — and
# only those — are rewritten first. Everything else is the real source.
node "$HERE/Stubs/rewrite.mjs" "$HERE/../Sources/SpaceForeApp.swift" "$OUT/SpaceForeApp.swift"

swiftc -typecheck -parse-as-library -I "$OUT" \
  "$HERE/../Sources/SyncServer.swift" \
  "$OUT/SpaceForeApp.swift"

echo "  ok    SpaceForeApp.swift typechecks against the documented API"
