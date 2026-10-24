#!/usr/bin/env bash
# reprep.sh <series-n> <head> <identity-base> [--unit-extra <file>] [--pg-extra <file>] [--pg-hook (kept in the call form, not used)] [--importers] [--red-first <owner red-on-base.txt>] [--prev-tree <sha>]
# (integrator-5, 2026-10-13): one re-prep of a frozen package head onto the CURRENT integ/w00, in the order the coordinator rules:
#  1. identity FIRST (team-lead's ruling R1, 2026-10-17; detached-merge/merge-identity-lib.sh, shared with commit.sh): the head's own commits
#     from its FORK POINT (git merge-base <PREP_BASE or integ/w00> <head>); <identity-base> is kept in the call form and NOT used; stop on a finding;
#  2. keep the folder's hand-written inputs (commit-locked.sh, extra-legs.sh, commit-msg.txt) across prep.sh; the commit message's old head
#     sha is replaced by the new one;
#  3. prep.sh (trial, hook map incl. the orchestrator line, unit/pg lists, config.sh);
#  4. unit.txt += --unit-extra and pg.txt += --pg-extra (deduplicated); unit.targeted.txt = unit.txt; PG_HOOK in config.sh is DERIVED
#     from the hook list (detached-merge/pg-hook-lib.sh, shared with commit.sh; team-lead's ruling 2026-10-17 after W4H-34): 1 when the
#     list maps a tests/postgres suite (prep.sh writes 0); --pg-hook no longer decides it;
#  4b. --importers (the coordinator's general rule after the W4H-26 hold, 2026-10-14): every root test that imports a changed source
#     file (integrator-5/importers.py) joins unit.txt, or pg.txt for tests/postgres; the hook maps only a subset;
#  5. --red-first: the owner's red-on-base.txt -> red-first-files.txt, case-files-extra.txt (red-first files the hook does not map),
#     warn-cases.txt (every NEW test/it name in those files' diff integ..head) and whole-files.txt (red-first files with no new name);
#  6. prints the trial summary, the hook count, the file count and, with --prev-tree, the diff against the previous trial.
set -u
N=${1:?series-n} H=${2:?head} IB=${3:?identity base}; shift 3; UX= PX= RF= PT= PH= IM=
while [ $# -gt 0 ]; do case "$1" in --unit-extra) UX=$2; shift 2;; --pg-extra) PX=$2; shift 2;; --pg-hook) PH=1; shift;; --importers) IM=1; shift;; --red-first) RF=$2; shift 2;; --prev-tree) PT=$2; shift 2;; *) echo "unknown $1"; exit 2;; esac; done
E=/tmp/factory-platform-evidence; D=$E/w00/w4h-merge/w4h-$N; I=/home/<USER>/work/EZCorp/EZHarness-worktrees/composable-factory-platform/.worktrees/w00-integration
[ -d "$D" ] || { echo "no folder $D"; exit 2; }
HF=$(git -C $I rev-parse "$H") || exit 2; S=${HF:0:9}
# IDENTITY-PREP-BEGIN
. "${MERGE_IDENTITY_LIB:-$E/w00/detached-merge/merge-identity-lib.sh}"
B0=$(git -C $I rev-parse "${PREP_BASE:-integ/w00}^{commit}") || exit 2
merge_identity_commits "$D" prep- "$B0" "$HF" "$I"; ir=$?; cat "$D/prep-identity-base.txt" "$D/prep-identity-commits.txt"
[ $ir -eq 0 ] || { echo "STOP: identity findings (report to the coordinator at once)"; exit 1; }
# IDENTITY-PREP-END
K=$(mktemp -d /tmp/i5-reprep.XXXXXX); for f in commit-locked.sh extra-legs.sh commit-msg.txt; do [ -f "$D/$f" ] && cp -p "$D/$f" "$K/$f"; done
OLD=$(sed -n 's/^merge: [^ ]* \([0-9a-f]\{9\}\) .*/\1/p' "$D/commit-msg.txt" 2>/dev/null | head -1)
( cd /tmp && SERIES=w4h bash $E/w00/w4g-merge/prep.sh "$N" "$(sed -n 's/^merge: [^(]*(\(.*\))$/\1/p' "$K/commit-msg.txt" | head -1)" ) || { echo "STOP: prep.sh failed"; exit 1; }
for f in commit-locked.sh extra-legs.sh; do [ -f "$K/$f" ] && cp -p "$K/$f" "$D/$f"; done
[ -f "$K/commit-msg.txt" ] && { if [ -n "$OLD" ]; then sed "s#$OLD#$S#g" "$K/commit-msg.txt" > "$D/commit-msg.txt"; else cp -p "$K/commit-msg.txt" "$D/commit-msg.txt"; fi; }
[ -n "$UX" ] && { cat "$D/unit.txt" "$UX" | awk '!seen[$0]++' > "$D/unit.new"; mv "$D/unit.new" "$D/unit.txt"; }
[ -n "$PX" ] && { cat "$D/pg.txt" "$PX" | awk 'NF && !seen[$0]++' > "$D/pg.new"; mv "$D/pg.new" "$D/pg.txt"; }
if [ -n "$IM" ]; then T0=$(grep -oE 'TREE=[0-9a-f]+' "$D/config.sh" | cut -d= -f2)
  python3 -I evidence/integrator-5/importers.py "$I" "$(git -C $I rev-parse integ/w00)" "$T0" --out-unit "$D/unit.importers.txt" --out-pg "$D/pg.importers.txt" > "$D/importers.txt"; head -1 "$D/importers.txt"
  cat "$D/unit.txt" "$D/unit.importers.txt" | awk 'NF && !seen[$0]++' > "$D/unit.new"; mv "$D/unit.new" "$D/unit.txt"
  cat "$D/pg.txt" "$D/pg.importers.txt" | awk 'NF && !seen[$0]++' > "$D/pg.new"; mv "$D/pg.new" "$D/pg.txt"; fi
bash $E/w00/node-canonical-filter.sh "$I" "$(grep -oE 'TREE=[0-9a-f]+' "$D/config.sh" | cut -d= -f2)" "$D/unit.txt" "$D/unit.node-canonical.txt"   # after the importers (ruling 2026-10-16)
cp -p "$D/unit.txt" "$D/unit.targeted.txt"
. "${PG_HOOK_LIB:-$E/w00/detached-merge/pg-hook-lib.sh}" || { echo "STOP: pg-hook-lib.sh not readable"; exit 1; }
pg_hook_config "$D/hook-mapped-$S.txt" "$D/config.sh" || { echo "STOP: PG_HOOK not derived"; exit 1; }
if [ -n "$RF" ]; then
  awk -F' [|] ' '/\.test\.ts/{print $1}' "$RF" | sort -u > "$D/red-first-files.txt"
  : > "$D/case-files-extra.txt"; while read -r f; do grep -qxF "$f" "$D/hook-mapped-$S.txt" || echo "$f" >> "$D/case-files-extra.txt"; done < "$D/red-first-files.txt"
  python3 -I evidence/integrator-5/red-first-cases.py "$I" "$D" "$HF"   # one implementation; I-1 (escaped quotes)
  echo "red-first files the hook does not map: $(tr '\n' ' ' < "$D/case-files-extra.txt")"
fi
T=$(grep -oE 'TREE=[0-9a-f]+' "$D/config.sh" | cut -d= -f2)
# IDENTITY-STAGED-BEGIN (R1 (b): the merge's staged files from the trial TREE; IDENTITY_MODE=package written for commit.sh)
grep -q '^IDENTITY_MODE=' "$D/config.sh" || echo "IDENTITY_MODE=package" >> "$D/config.sh"
merge_identity_staged "$D" prep- "$B0" "$T" "$I"; sr=$?; tail -1 "$D/prep-identity-staged.txt"
[ $sr -eq 0 ] || { echo "STOP: staged-file identity findings (report to the coordinator at once)"; exit 1; }
# IDENTITY-STAGED-END
cat "$D/trial-$S/summary.txt"; echo "unit $(grep -c . "$D/unit.txt"); pg $(grep -c . "$D/pg.txt"); hook list $(grep -c . "$D/hook-mapped-$S.txt"); files $(git -C $I diff --name-only integ/w00 "$T" | wc -l) ($(git -C $I diff --shortstat integ/w00 "$T"))"
[ -n "$PT" ] && { echo "--- against the previous trial $PT:"; git -C $I diff --stat "$PT" "$T"; }
exit 0
