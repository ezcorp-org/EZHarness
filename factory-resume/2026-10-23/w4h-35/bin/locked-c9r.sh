#!/usr/bin/env bash
# locked-c9r.sh (gated-flock only): the C9-only resume at 9446008c6 (team-lead 2026-10-23, after s11r.exit.20261023T153757Z = 1: every
# leg green but C9, which stopped at its R2-reproduction guard). Commit 11 (test-fix-01) removed one expected failure (the alert-evaluator
# afterAll TypeError), so the guard now names merge-prep/r2-expected.v2.json (proof merge-prep/r2-expected-v2.proof.log).
# Start check: a clean 9446008c6 on the branch; c9_base_check 063b3d16e; then ONLY bin/locked-static-c9.sh 063b3d16e. Exit: its exit
# (a 75 re-queues: the start check passes again at the same head). Last: the manifest of this run's records (legs, static-C9 folder).
set -uo pipefail
E=evidence/w4h-35; W=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35; HEAD_WANT=9446008c6
C9BASE=063b3d16efc4074ebcf78a7df8c20fedfb54ccf0; stamp=$(date -u +%Y%m%dT%H%M%SZ); D=$E/c9r-$stamp; mkdir -p "$D"; S=$D/legs.log
say() { echo "[$(date -u +%FT%TZ)] $*" >> "$S"; }
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE DATABASE_URL FACTORY_TEST_POSTGRES_URL
cd "$W" || exit 1
[ "$(git branch --show-current)" = wp/w4h-35-w16-k8s-profiles ] && [ "$(git rev-parse --short HEAD)" = "$HEAD_WANT" ] && [ -z "$(git status --porcelain)" ] \
  || { say "STOP: the worktree is not a clean $HEAD_WANT on its branch"; exit 1; }
. "$E/bin/c9-base.sh"; c9_base_check "$W" "$C9BASE" "$S" || exit 3
say "C9 at $HEAD_WANT against $C9BASE, R2 signature merge-prep/r2-expected.v2.json"
R2_EXPECTED=$E/merge-prep/r2-expected.v2.json bash "$E/bin/locked-static-c9.sh" "$C9BASE"; rc=$?
C9D=$(ls -d "$E"/static-c9-2026* | sort | tail -1)
say "static C9 exit $rc ($C9D); head $(git log -1 --format=%h), porcelain $(git status --porcelain | wc -l)"
(cd "$E" && find "c9r-$stamp" "${C9D#$E/}" \( -name lcov -o -name 'cov-*' \) -prune -o -type f ! -name c9r-shas.txt -print0 | sort -z | xargs -0 sha256sum) > "$D/c9r-shas.txt"
exit "$rc"
