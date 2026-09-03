# Put every place a Mac keeps Node on PATH, newest version first.
#
# A GUI app and an Xcode script phase both start with a PATH that has none of
# the shell's additions, so Homebrew, MacPorts, nvm, fnm, Volta, asdf and n are
# all invisible unless added back here. Sourced by copy-resources.sh; the same
# list, in Swift, is what the app uses at run time (SyncServer.swift).
#
# bash 3.2 — the one macOS ships — so: no arrays beyond globs, no mapfile, no
# ${var,,}. Prepending in ascending order leaves the highest version first.
spacelink_add_node_paths() {
  local dir
  for dir in /opt/local/bin /usr/local/bin /opt/homebrew/bin; do
    if [ -d "$dir" ]; then PATH="$dir:$PATH"; fi
  done
  # Version managers keep each version in its own bin. `sort -V` is not in
  # bash 3.2's coreutils on macOS, so order by numeric components by hand.
  #
  # Guarded, because copy-resources.sh runs under `set -euo pipefail`: with
  # no nvm directory the `ls` fails, the pipeline fails, and the assignment
  # would take the whole build down with it — on every Mac without nvm.
  local versions=""
  if [ -d "$HOME/.nvm/versions/node" ]; then
    versions=$(ls -1 "$HOME/.nvm/versions/node" | sed 's/^v//' | sort -t. -k1,1n -k2,2n -k3,3n | sed 's/^/v/')
  fi
  for dir in $versions; do
    if [ -d "$HOME/.nvm/versions/node/$dir/bin" ]; then PATH="$HOME/.nvm/versions/node/$dir/bin:$PATH"; fi
  done
  for dir in "$HOME/.volta/bin" "$HOME/.local/share/fnm/aliases/default/bin" \
             "$HOME/Library/Application Support/fnm/aliases/default/bin" "$HOME/.asdf/shims" \
             "$HOME/.nodenv/shims" "$HOME/n/bin"; do
    if [ -d "$dir" ]; then PATH="$dir:$PATH"; fi
  done
  export PATH
}
