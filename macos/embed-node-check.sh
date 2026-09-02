#!/usr/bin/env bash
# Whether a `node` binary can be copied into an app bundle and still run on a
# Mac that has none of the libraries it was built against.
#
#   embed-node-check.sh /path/to/node
#
# Homebrew's node is built with --shared-libuv, --shared-openssl, --shared-icu
# and a dozen more, so it depends on ~20 dylibs under /opt/homebrew (or
# /usr/local on Intel). Copied into a bundle and opened on another Mac, dyld
# aborts it: "Library not loaded: /opt/homebrew/opt/libuv/lib/libuv.1.dylib".
# The nodejs.org binary is self-contained. `otool -L` tells them apart.
#
# Exit 0 when every linked library is a system one; 1 otherwise, listing them.
set -euo pipefail
node="${1:-}"
[[ -n "$node" ]] || { echo "usage: embed-node-check.sh /path/to/node" >&2; exit 2; }
command -v otool >/dev/null 2>&1 || { echo "otool is missing; install the Command Line Tools" >&2; exit 2; }

foreign=$(otool -L "$node" | awk 'NR > 1 { print $1 }' | grep -vE '^(/usr/lib/|/System/|@rpath/|@loader_path/|@executable_path/)' || true)
if [[ -n "$foreign" ]]; then
  echo "error: $node depends on libraries that will not exist on another Mac:" >&2
  echo "$foreign" | sed 's/^/       /' >&2
  echo "       --embed-node needs a self-contained Node, such as the macOS build from" >&2
  echo "       https://nodejs.org/dist/ — point at it with NODE=/path/to/node." >&2
  exit 1
fi
