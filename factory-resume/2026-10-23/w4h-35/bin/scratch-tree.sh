#!/usr/bin/env bash
# scratch-tree.sh <rev> <new dir> [<node_modules source tree> | install]: the committed files of <rev> (git archive, as the hosted checkout
# has them) in <new dir>, then its dependencies either
#  - linked: every node_modules folder of the source tree linked in (read only use; enough for bun test of src/ and tests/), or
#  - install: `bun install --frozen-lockfile` at the root and in web/, as CI's setup action does (pinned Bun; copyfile backend, so no
#    file is shared with Bun's cache). A web build needs this: vite writes its temp config into web/node_modules and loads it back, which
#    fails through a link into another tree (W4H-35 session 11 v4, r3-a27: "Cannot find module .../node_modules/.vite-temp/...").
set -euo pipefail
REV=${1:?rev} DIR=${2:?dir} NM=${3:-/home/<USER>/work/EZCorp/EZHarness-worktrees/composable-factory-platform/.worktrees/w00-integration}
SRC=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35; BUN=/tmp/factory-tools/bun-1.4.2/bun-linux-x64/bun
[ ! -e "$DIR" ] || { echo "scratch-tree: $DIR exists"; exit 2; }
if [ "$NM" = install ]; then
  mkdir -p "$DIR"; git -C "$SRC" archive "$REV" | tar -x -C "$DIR"
  (cd "$DIR" && PATH="$(dirname "$BUN"):$PATH" timeout 900 "$BUN" install --frozen-lockfile --backend=copyfile) || { echo "scratch-tree: root install failed"; exit 3; }
  (cd "$DIR/web" && PATH="$(dirname "$BUN"):$PATH" timeout 900 "$BUN" install --frozen-lockfile --backend=copyfile) || { echo "scratch-tree: web install failed"; exit 3; }
  echo "scratch-tree: $(git -C "$SRC" rev-parse "$REV") in $DIR (installed)"
else
  mkdir -p "$DIR"; git -C "$NM" archive "$REV" | tar -x -C "$DIR"
  (cd "$NM" && find . -name node_modules -type d -prune -not -path './node_modules/*' -not -path './.github/*') | while read -r d; do ln -s "$NM/${d#./}" "$DIR/${d#./}"; done
  echo "scratch-tree: $(git -C "$NM" rev-parse "$REV") in $DIR"
fi
