#!/usr/bin/env bash
# mergeprep-link.sh: give the prep worktree the w4h-35 install without a new install. Each node_modules entry is a symlink to the
# w4h-35 one, except the @ezcorp scope folders, which are COPIED (they hold relative links that must resolve inside the prep tree).
# The packages' built dist folders are copied (integ changes no package source). Touches only the prep worktree.
set -euo pipefail
S=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35; P=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35-mergeprep
[ "$(git -C "$P" rev-parse HEAD)" = e55719316f9266dde7790ee2fc04a336f9be5099 ] || { echo "prep is not at e55719316"; exit 3; }
cd "$S"
for n in node_modules web/node_modules .github/gate-integrity-deps/node_modules packages/@ezcorp/*/node_modules; do
  [ -d "$S/$n" ] || continue
  [ -e "$P/$n" ] && { echo "exists, kept: $n"; continue; }
  mkdir -p "$P/$n"
  for e in "$S/$n"/* "$S/$n"/.[!.]*; do
    [ -e "$e" ] || [ -L "$e" ] || continue
    b=$(basename "$e")
    if [ "$b" = "@ezcorp" ]; then cp -a "$e" "$P/$n/"; else ln -s "$e" "$P/$n/$b"; fi
  done
done
for d in "$S"/packages/@ezcorp/*/dist; do r=${d#"$S"/}; [ -e "$P/$r" ] || cp -a "$d" "$P/$r"; done
echo linked
