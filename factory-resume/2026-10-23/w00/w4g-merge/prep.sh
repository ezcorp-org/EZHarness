#!/usr/bin/env bash
# prep.sh <n> "<subject tail>": prepare the detached merge of wp/w4g-<n> onto the CURRENT integ/w00 head: trial (merge-tree),
# hook list, unit/pg lists from the mapped tests (tests/postgres/* -> pg.txt), focused, commit message, config. Re-run after
# every merge that moves integ/w00; the config names the base and the trial tree it was made from.
# Every unit.txt also carries the repository-invariant tests of w00/invariant-tests.txt (team-lead standing rule, 2026-10-14).
# PREP_REF (optional, integrator-5 2026-10-12): merge this ref instead of wp/<series>-<n> (a W-SYNC of origin/main); BRANCH = the ref.
# PREP_BASE (optional, integrator-5 2026-10-16): prepare onto this commit instead of integ/w00 (a merge commit that becomes integ/w00
# at its publish); the config names it as BASE, and commit.sh then requires integ/w00 = BASE at commit time.
set -u
N=${1:?n} SUBJ=${2:?subject tail}
E=/tmp/factory-platform-evidence; W=/home/<USER>/work/EZCorp/EZHarness-worktrees/composable-factory-platform/.worktrees/w00-integration
SR=${SERIES:-w4g}   # package series (w4g, w4h, ...)
D=$E/w00/$SR-merge/$SR-$N; mkdir -p $D
REF=${PREP_REF:-wp/$SR-$N}; H=$(git -C $W rev-parse "$REF^{commit}"); S=${H:0:9}
B=$(git -C $W rev-parse --verify -q "${PREP_BASE:-integ/w00}^{commit}") || { echo "REFUSED: base ${PREP_BASE:-integ/w00} is not a commit"; exit 2; }
rm -rf $D/trial-$S; ALLOW_DOC_CONFLICTS=1 bash $E/w00/hook-map.sh $B $H $D/trial-$S > /dev/null || { echo "trial failed"; cat $D/trial-$S/summary.txt; exit 1; }
T=$(grep -oE "trial-tree [0-9a-f]{40}" $D/trial-$S/summary.txt | head -1 | cut -d" " -f2)   # the union tree when docs conflicted (hook-map.sh)
[ -n "$T" ] || { echo "no trial-tree in $D/trial-$S/summary.txt"; exit 1; }
cp $D/trial-$S/hook-mapped.txt $D/hook-mapped-$S.txt
grep -E '\.test\.ts$' $D/hook-mapped-$S.txt | grep -v '^tests/postgres/' | grep -v '^web/' | sed 's#^#./#' > $D/unit.txt || true   # web/ tests are vitest files: never bun test
INV=$(bash $E/w00/invariant-include.sh $W $T $D/unit.txt 2> $D/invariant-skipped.txt) || { echo "invariant include failed"; cat $D/invariant-skipped.txt; exit 1; }   # standing rule 2026-10-14
bash $E/w00/node-canonical-filter.sh $W $T $D/unit.txt $D/unit.node-canonical.txt   # never a node:test file under bun (ruling 2026-10-16)
grep '^tests/postgres/.*\.test\.ts$' $D/hook-mapped-$S.txt | sed 's#^#./#' > $D/pg.txt || true
cp $E/w00/w4f-merge/w4f-2/focused.txt $D/focused.txt
n=$(grep -c . $D/hook-mapped-$S.txt)
printf 'merge: '"$REF"' %s into integ/w00 (%s)\n\nThe hook maps %s line(s) (cap 12) and runs them. No gate change expected: the base leg must be clean and the origin/main leg must equal the 8-line expected set.\n' "$S" "$SUBJ" "$n" > $D/commit-msg.txt
cat > $D/config.sh <<CFG
# ${SR^^}-$N detached-merge config (integrator-3, prep.sh $(date -u +%FT%TZ)). Base ${B:0:9} (${PREP_BASE:-integ/w00} when prepared); trial tree ${T:0:9}.
D=$D
BRANCH=$REF HEADSHA=$H
BASE=$B TREE=$T
LIST=$D/hook-mapped-$S.txt MSG=$D/commit-msg.txt FOCUSED=$D/focused.txt
SKIP=0 GATE_APPROVED=0 PG_HOOK=0
HEAVY_EXIT=$D/heavy.exit REVIEW=
CFG
[ "$n" -le 12 ] || echo "WARNING: $n mapped lines, above the cap: a list-bound ruling is needed"
echo "${SR^^}-$N prepared: head $S base ${B:0:9} tree ${T:0:9} mapped $n; unit $(grep -c . $D/unit.txt) ($INV) pg $(grep -c . $D/pg.txt)"
