#!/usr/bin/env bash
# locked-chain.sh (one gated-flock session): C2, then C3's rows, then C3's code. Each commit stands alone: the commit
# job typechecks first and the hook runs every mapped suite (full-run form). Any red step stops the chain.
set -uo pipefail
E=evidence/w4h-35; W=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35; S=$E/logs/locked-chain.log
cd "$W" || exit 1; unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE
# Resumable: a step whose commit is already in the branch is skipped (a gate release mid-chain re-runs the chain).
done_() { git log --format=%s 890448dc3..HEAD 2>/dev/null | grep -qxF "$(head -1 "$1")" || git log --format=%s d1fa296b8..HEAD | grep -qxF "$(head -1 "$1")"; }
if ! done_ "$E/msg-c2.txt"; then
  bash "$E/bin/locked-commit-c2.sh" "$E/msg-c2.txt"; rc=$?; echo "C2 exit $rc $(date -u +%FT%TZ)" >> "$S"; [ "$rc" = 0 ] || exit "$rc"
fi
if ! done_ "$E/msg-c3-rows.txt"; then
  [ -z "$(git status --porcelain)" ] || { echo "STOP: tree not clean before C3 rows" >> "$S"; exit 1; }
  git apply --index "$E/c3-rows.patch" || { echo "STOP: rows patch" >> "$S"; exit 1; }
  GIT_CONFIG_NOSYSTEM=1 git commit -q -F "$E/msg-c3-rows.txt" > "$E/logs/commit-c3-rows.log" 2>&1; rc=$?; echo "C3 rows exit $rc head $(git log -1 --format=%h)" >> "$S"; [ "$rc" = 0 ] || exit "$rc"
fi
if done_ "$E/msg-c3.txt"; then echo "C3 already committed" >> "$S"; exit 0; fi
[ -n "$(git diff --cached --name-only)" ] || git apply --index "$E/c3-code.patch" || { echo "STOP: code patch" >> "$S"; exit 1; }
git add -f tasks/factory/w4h-35-GATES.md 2>/dev/null || true
bash "$E/bin/locked-commit-c2.sh" "$E/msg-c3.txt"; rc=$?; echo "C3 exit $rc head $(git log -1 --format=%h) $(date -u +%FT%TZ)" >> "$S"; exit "$rc"
