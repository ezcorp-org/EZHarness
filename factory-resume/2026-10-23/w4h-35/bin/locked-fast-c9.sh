#!/usr/bin/env bash
# locked-fast-c9.sh <head> <base> (gated-flock only; ONE job on team-lead's word): at the exact <head>, the repository's fast stage
# (the shared w00/merge-fast-checks.sh with --repo this worktree; registration, typecheck, lint, gate-integrity, boundaries, every
# guard suite, schema-drift, the focused boundaries test, web-check; its gate-integrity step judged by exit code: the expected set
# is EMPTY, team-lead N1 2026-10-20, so the plain gate must PASS with no finding),
# then the package's C9 set against <base>. Exit 75 on a red
# resource gate so gated-flock re-queues; else 0 only if both stages are 0.
set -uo pipefail
E=evidence/w4h-35; W=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35; stamp=$(date -u +%Y%m%dT%H%M%SZ)
HEAD_WANT=$1 BASE=$2; D=$E/fast-c9-$stamp; mkdir -p "$D"; S=$D/legs.log
. evidence/w00/lock-veto.sh; lock_veto integrator-2
. evidence/w00/resource-gate.sh; RESOURCE_GATE_MAX_WAIT_S=0
resource_gate w4h35-fast-c9 "$S" || { echo "release: gate red $(date -u +%FT%TZ)" >> "$S"; exit 75; }
export TC_IN_LOCK=1
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE; cd "$W" || exit 1
[ "$(git rev-parse --short HEAD)" = "$HEAD_WANT" ] && [ -z "$(git status --short)" ] || { echo "STOP: head is not a clean $HEAD_WANT" >> "$S"; exit 1; }
echo "head $HEAD_WANT base $BASE $(date -u +%FT%TZ)" >> "$S"
echo ./scripts/check-factory-boundaries.test.ts > "$D/focused.txt"
# The shared tool (w00/merge-fast-checks.sh, --repo; validator-8 S2): no owner fork. No --expected-findings: the set is empty (N1),
# and the tool refuses an empty expected file by name (merge-fast-checks.sh:25).
bash evidence/w00/merge-fast-checks.sh "$D/fast" "$D/focused.txt" --web --repo "$W" > "$D/fast.out" 2>&1; raw=$?
echo "fast stage raw exit $raw ($(tail -1 "$D/fast.out")) $(date -u +%FT%TZ)" >> "$S"
grep -q 'exit=75' "$D/fast.out" && { echo "release: fast stage gate red" >> "$S"; exit 75; }
# The fast stage's gate-integrity step is unapproved and the expected set is empty (N1): the step itself must exit 0.
# w00/fast-judge.py (the shared judge, installed 0f5110ea570f8680): every OTHER step exit 0, the FULL step set recorded (guards, focused, web-check) and the FAST DONE line present;
# a SKIPPED step is red (the shared judge's own rule).
python3 -I evidence/w00/fast-judge.py "$D/fast" "$D/fast.out" "$D/focused.txt" --web > "$D/fast-judgement.txt" 2>&1; fj=$?
# The judge never reds gate-integrity alone (fast-judge.py), so this check keeps the gate: the step must be recorded, with exit 0.
python3 -I -c 'import json,sys; r=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]; e=[x for x in r if x.get("name")=="gate-integrity"]; print("gate-integrity:", e[-1].get("exitCode") if e else "MISSING"); sys.exit(0 if e and e[-1].get("exitCode")==0 else 1)' "$D/fast/checks.jsonl" > "$D/fast-gate-integrity.txt" 2>&1; fm=$?
# Exit 0 alone can be a bypass (gate-integrity.ts:1557-1563): the step's output must be the 0-findings form (gate-leg.sh).
. "$E/bin/gate-leg.sh"; gate_leg_ok "$D/fast/gate-integrity.log" fast-gate-integrity "$S"; fg=$?
fast=$([ "$fj" = 0 ] && [ "$fm" = 0 ] && [ "$fg" = 0 ] && echo 0 || echo 1)
echo "fast stage judged $fast: $(cat "$D/fast-judgement.txt" | tr '\n' ' ')| $(tail -1 "$D/fast-gate-integrity.txt")" >> "$S"
bash "$E/bin/locked-static-c9.sh" "$BASE"; c9=$?
echo "c9 exit $c9 ($(ls -d "$E"/static-c9-2026* | tail -1)) $(date -u +%FT%TZ)" >> "$S"
[ "$c9" = 75 ] && exit 75
echo "done fast=$fast c9=$c9 head $(git rev-parse --short HEAD) $(date -u +%FT%TZ)" >> "$S"
[ "$fast" = 0 ] && [ "$c9" = 0 ]
