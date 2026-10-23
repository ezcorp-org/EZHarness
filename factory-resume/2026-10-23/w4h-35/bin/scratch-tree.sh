#!/usr/bin/env bash
# scratch-tree.sh <rev> <new dir> [<node_modules source tree>]: the committed files of <rev> (git archive, as the hosted checkout has
# them) in <new dir>, with every node_modules folder of the source tree linked in (read only use). The way merge-prep/*-scratch were made.
set -euo pipefail
REV=${1:?rev} DIR=${2:?dir} NM=${3:-/home/<USER>/work/EZCorp/EZHarness-worktrees/composable-factory-platform/.worktrees/w00-integration}
[ ! -e "$DIR" ] || { echo "scratch-tree: $DIR exists"; exit 2; }
mkdir -p "$DIR"; git -C "$NM" archive "$REV" | tar -x -C "$DIR"
(cd "$NM" && find . -name node_modules -type d -prune -not -path './node_modules/*' -not -path './.github/*') | while read -r d; do ln -s "$NM/${d#./}" "$DIR/${d#./}"; done
echo "scratch-tree: $(git -C "$NM" rev-parse "$REV") in $DIR"
