#!/usr/bin/env bash
# locked-merge-session.sh (gated-flock only; ONE job on team-lead's word): replays the validator-OKed merge prep on the w4h-35 branch.
#   1. merge commit: `git merge --no-commit --no-ff` integ 063b3d16e, then the worktree reset to HEAD and patch 01 applied to the
#      index (the resolution); its tree must equal d9bf1261; committed by locked-commit-fix.sh (in-lock typecheck, full hook, own pg15).
#   2. rows commit: patch 02, tree 95d5a20d. 2b. rows amendment: patch 02c (02d), tree dd2d917f. 3. code commit: patch 03 (03e), tree 781218a2.
#   3b. the session-6 fix (validator-8 D1-D3): patch 04, tree 61b161cb, on the code commit.
#   3c. the run-13 fix (the hosted harness data directories): patch 05, tree b305790f, on commit 04.
#   3d. the second run-13 fix (the orchestrator's Node graph): patch 06, tree c0293f79, on commit 05.
#   3e. the coverage key of commit 06's new file: patch 07, tree db721465, on commit 06.
#   4. the commit mutants (01-m1, 03-c, 04-m, 05-m, 06-m) must be red at the new head; 5. fast stage and C9 at the new head (locked-fast-c9.sh),
#      against C9BASE = the branch's merge-base with origin/main, checked by c9_base_check (F1, team-lead 2026-10-20; it replaces
#      ruling M6's first parent: integ 063b3d16e is in main 802d46288 since PR 341). Resumable: a commit already in the branch is
#      not made again. FIRST stays the merge's first parent (the merge step's parent and the made() range).
set -uo pipefail
E=evidence/w4h-35; W=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35; M=$E/merge-prep
S=$E/logs/locked-merge-session-$(date -u +%Y%m%dT%H%M%SZ).log
INTEG=063b3d16efc4074ebcf78a7df8c20fedfb54ccf0; FIRST=e55719316; C9BASE=063b3d16efc4074ebcf78a7df8c20fedfb54ccf0
say() { echo "[$(date -u +%FT%TZ)] $*" >> "$S"; }
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE; cd "$W" || exit 1
[ "$(git branch --show-current)" = wp/w4h-35-w16-k8s-profiles ] || { say "STOP: wrong branch"; exit 1; }
made() { git log --format=%h --fixed-strings --grep="$(head -1 "$1")" "$FIRST..HEAD" | head -1; }
# commit_step <message> <patch> <tree> <expected parent short> <merge|plain>
commit_step() {
  local msg=$1 patch=$2 tree=$3 parent=$4 kind=$5
  if [ -n "$(made "$msg")" ]; then say "$(basename "$patch"): already committed as $(made "$msg")"; return 0; fi
  [ "$(git rev-parse --short HEAD)" = "$parent" ] && [ -z "$(git status --porcelain)" ] || { say "STOP: not a clean $parent before $(basename "$patch")"; return 1; }
  if [ "$kind" = merge ]; then
    git -c rerere.enabled=false merge --no-commit --no-ff "$INTEG" > "$S.merge" 2>&1
    git rev-parse -q --verify MERGE_HEAD > /dev/null || { say "STOP: no merge in progress"; return 1; }
    git read-tree -u --reset HEAD || { say "STOP: reset to HEAD failed"; return 1; }
  fi
  git apply --index "$M/$patch" 2> "$S.apply-$patch" || { say "STOP: $patch does not apply"; return 1; }
  [ "$(git write-tree)" = "$tree" ] || { say "STOP: $patch gives tree $(git write-tree), not $tree"; return 1; }
  mapfile -t paths < <(git apply --numstat "$M/$patch" | cut -f3)
  bash "$E/bin/locked-commit-fix.sh" "$msg" "$parent" "${paths[@]}"; local rc=$?
  say "$(basename "$patch") commit exit $rc head $(git rev-parse --short HEAD)"
  [ "$rc" = 0 ] || return "$rc"
  [ "$(git rev-parse 'HEAD^{tree}')" = "$tree" ] || { say "STOP: the commit's tree is not $tree"; return 1; }
  [ "$kind" != merge ] || [ "$(git rev-parse HEAD^2)" = "$INTEG" ] || { say "STOP: the merge's second parent is not $INTEG"; return 1; }
}
commit_step "$M/msg-merge.txt" 01-merge-resolution.patch d9bf12617237d17dd3cbd34ae953e3a6b8271014 "$FIRST" merge || exit $?
merge=$(made "$M/msg-merge.txt")
commit_step "$M/msg-rows13.txt" 02-rows.patch 95d5a20d085637e800e22a2bf6596bb06a125bfd "$merge" plain || exit $?
rows=$(made "$M/msg-rows13.txt")
# 2b. rows amendment (team-lead's host-scope ruling after session 4): patch 02c (02d), tree dd2d917f.
commit_step "$M/msg-rows13b.txt" 02c-rows-amendment.patch dd2d917fd29d79dc883b50e1ebe7adc346b0f08a "$rows" plain || exit $?
rows=$(made "$M/msg-rows13b.txt")
commit_step "$M/msg-code13.txt" 03-code.patch 781218a29fcbfa04f0a962f97ba3bb7c651a9472 "$rows" plain || exit $?
code=$(made "$M/msg-code13.txt")
# 3a. The type requirement of commit 04, red first, in the lock (team-lead pre-ruling; validator-8 conditions 1-4), before any commit:
# patch 04 on the files only; 04-m planted (merge-prep/session-mutants.json, pinned) = the optional form: the in-lock typecheck must
# FAIL with only TS2578 at metrics-listener.test.ts:205 (ts2578-judge.py); the required form: the typecheck must pass; then the
# worktree back to a clean $code with HEAD unchanged, else STOP. Logs by hash in this log.
type_steps() {
  local t=$E/logs/session-type-$(date -u +%Y%m%dT%H%M%SZ) head rc paths
  head=$(git rev-parse HEAD); paths=$(git apply --numstat "$M/04-code.patch" | cut -f3)
  . evidence/w00/tc-gate.sh; . evidence/w00/bun-pin.sh; bun_pin "$W" > /dev/null; export TC_IN_LOCK=1
  restore() { git checkout -- $paths; [ "$(git rev-parse HEAD)" = "$head" ] && [ -z "$(git status --porcelain)" ]; }
  git apply "$M/04-code.patch" || { say "STOP: patch 04 does not apply to the files"; restore; return 1; }
  python3 -I -c 'import json,sys; m=[x for x in json.load(open(sys.argv[1])) if x[0].startswith("04-m")][0]; t=open(m[1]).read(); assert t.count(m[2])==1; open(m[1],"w").write(t.replace(m[2],m[3]))' "$M/session-mutants.json" \
    || { say "STOP: 04-m does not plant"; restore; return 1; }
  tc_run w4h35-04-type-red "$S" bun run typecheck > "$t-red.log" 2>&1; rc=$?
  python3 -I "$E/bin/ts2578-judge.py" "$t-red.log" "$rc" src/factory/observability/metrics-listener.test.ts 205 > "$t-red.judge" 2>&1; local jr=$?
  say "type red (04-m, the optional form): typecheck exit $rc; $(cat "$t-red.judge"); log $(sha256sum "$t-red.log" | cut -c1-16)"
  git checkout -- src/factory/observability/metrics-listener.ts && git apply --include=src/factory/observability/metrics-listener.ts "$M/04-code.patch"
  tc_run w4h35-04-type-green "$S" bun run typecheck > "$t-green.log" 2>&1; local gr=$?
  say "type green (the required form): typecheck exit $gr; log $(sha256sum "$t-green.log" | cut -c1-16)"
  restore || { say "STOP: the worktree is not a clean $head after the type steps"; return 1; }
  say "type steps: worktree clean at $(git rev-parse --short HEAD), 0 porcelain"
  [ "$jr" = 0 ] && [ "$gr" = 0 ] || { say "STOP: the type red/green does not match; no commit"; return 1; }
}
[ -n "$(made "$M/msg-code14.txt")" ] || type_steps || exit $?
commit_step "$M/msg-code14.txt" 04-code.patch 61b161cb5f6c97956c7b8a767b9ae9a503222e33 "$code" plain || exit $?
fix=$(made "$M/msg-code14.txt")
commit_step "$M/msg-code15.txt" 05-code.patch b305790ff5eac0493dd0cdee5fda42bb0b302e10 "$fix" plain || exit $?
fix5=$(made "$M/msg-code15.txt")
commit_step "$M/msg-code16.txt" 06-code.patch c0293f79ac45d923f4e778ff2cd782eb0e70be42 "$fix5" plain || exit $?
fix6=$(made "$M/msg-code16.txt")
commit_step "$M/msg-code17.txt" 07-code.patch db72146552be0b02a227ab52d2c632e02f2a929a "$fix6" plain || exit $?
new=$(git rev-parse --short HEAD); say "commits: merge $merge, rows $rows, code $code, fix $fix, run-13 fix $fix5, run-13 fix 2 $fix6, coverage key $new"
[ -z "$(git status --porcelain)" ] || { say "STOP: the tree is not clean after the commits"; exit 1; }
python3 -I "$E/bin/run12-mutants.py" "$W" "$E/logs/session-mutants-$new.log" "$M/session-mutants.json" > /dev/null 2>&1; rc=$?
say "commit mutants (01-m1, 03-c, 04-m, 05-m, 06-m) exit $rc ($(tr '\n' ' ' < "$E/logs/session-mutants-$new.log"))"
[ "$rc" = 0 ] && [ -z "$(git status --porcelain)" ] || { say "STOP: a commit mutant survived, or the tree is not clean"; exit 1; }
. "$E/bin/c9-base.sh"; c9_base_check "$W" "$C9BASE" "$S" || exit 3
say "fast stage and C9 at $new against $C9BASE (= merge-base HEAD origin/main $(git rev-parse --short origin/main))"
bash "$E/bin/locked-fast-c9.sh" "$new" "$C9BASE"; rc=$?; say "fast-c9 exit $rc"; exit "$rc"
