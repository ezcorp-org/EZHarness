#!/usr/bin/env bash
# Usage: [EXPECTED_MAIN_FINDINGS=<file>] merge-commit-gates.sh <out-dir> <base-ref> [<gate-change decision file>]
# The optional third argument is ONLY for a merge the user has approved as a gate change (the label-equivalent,
# e.g. W03g on decision A): gate-integrity then runs with GATE_CHANGE_APPROVED=1 for this one commit, the decision
# file's sha256 and the unapproved run's findings are recorded next to the approved run. Without it, never set.
# The gates that must run AT the merge commit (HEAD = the merged tree), after the commit:
# gate-integrity against origin/main and against <base-ref>, then new-file and patch coverage against <base-ref>
# (coverage/lcov.info from the batch). gate-integrity on a staged merge reads the working tree but numbers added
# lines by mergeBase...HEAD with HEAD still the old commit, so its staged result is advisory only (W16d, 2026-09-27).
set -u
D=$1 BASE=$2 DECISION=${3:-}
REPO=${MCG_REPO:-/home/<USER>/work/EZCorp/EZHarness-worktrees/composable-factory-platform/.worktrees/w00-integration}   # test seam (merge-commit-gates.test.sh)
. "${MCG_BUN_PIN_LIB:-evidence/w00/bun-pin.sh}"; bun_pin "$REPO"   # test seam: the library that defines bun_pin   # rule "Bun pin switch": PATH from the tree's .bun-version
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GATE_CHANGE_APPROVED
cd "$REPO" || exit 2
[ -z "$(git rev-parse -q --verify MERGE_HEAD)" ] && [ -z "$(git status --porcelain)" ] || { echo "REFUSED: not at a clean committed head"; exit 3; }
mkdir -p "$D/cov"; st=0
echo "pin: bun $(bun --version); BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING=${BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING-unset}" | tee "$D/cov/pin.txt"
run() { local n=$1; shift; "$@" > "$D/cov/$n.log" 2>&1; local rc=$?; last_rc=$rc; echo "$n exit=$rc $(tail -1 "$D/cov/$n.log")"; [ $rc -ne 0 ] && st=1; }
# origin/main leg (lead ruling w00/ruling-origin-main-gate-leg.txt, after W18c): when EXPECTED_MAIN_FINDINGS names the
# expected-integ-findings file, the leg PASSES only when the unapproved findings equal that set exactly (findings-match.py);
# GATE_CHANGE_APPROVED is never used on this leg then. Without the variable the leg is judged by its own exit, as before.
if [ -n "${EXPECTED_MAIN_FINDINGS:-}" ]; then
  bun scripts/gate-integrity.ts > "$D/cov/gate-integrity-origin-main.log" 2>&1; rc=$?; echo "gate-integrity-origin-main exit=$rc (unapproved; judged by the expected set)"
  python3 evidence/w00/findings-match.py "$D/cov/gate-integrity-origin-main.log" "$EXPECTED_MAIN_FINDINGS" > "$D/cov/origin-main-expected-match.txt" 2>&1; m=$?
  echo "origin-main-expected-match exit=$m $(tail -1 "$D/cov/origin-main-expected-match.txt")"; [ $m -ne 0 ] && st=1
  run gate-integrity-base env BASE_REF=$BASE bun scripts/gate-integrity.ts
  # EXPECTED_BASE_FINDINGS without a decision file and without SYNC_BASE_MAIN (team-lead 2026-10-16, after the W4H-33 hold's red A:
  # a RULED gate change, e.g. two ruled test deletions): the unapproved base leg stays on record, and the base leg PASSES only when its
  # findings equal that set exactly (findings-match.py, label "base"), as the origin/main leg is judged. No file: the exit decides (the label path).
  if [ -n "${EXPECTED_BASE_FINDINGS:-}" ] && [ -z "$DECISION" ] && [ -z "${SYNC_BASE_MAIN:-}" ]; then
    st=$(( m != 0 ))
    python3 evidence/w00/findings-match.py "$D/cov/gate-integrity-base.log" "$EXPECTED_BASE_FINDINGS" base > "$D/cov/base-expected-match.txt" 2>&1; b=$?
    echo "base-expected-match exit=$b $(tail -1 "$D/cov/base-expected-match.txt")"; [ $b -ne 0 ] && st=1
  fi
  # SYNC_BASE_MAIN=<main sha> (the W-SYNC ruling, team-lead 2026-10-14 22:46Z; a main-sync merge only): the base leg above stays on
  # record, but validator-8's sync-base-leg.py (w00 copy, never a second implementation) decides it: clean iff every file a finding names
  # is byte-identical at HEAD and at main. The receipt line lists the files and the equality result (cov/sync-base-leg.txt).
  if [ -n "${SYNC_BASE_MAIN:-}" ] && [ -z "$DECISION" ]; then
    base_rc=$last_rc; st=$(( m != 0 )); python3 evidence/w00/sync-base-leg.py "$D/cov/gate-integrity-base.log" HEAD "$SYNC_BASE_MAIN" > "$D/cov/sync-base-leg.txt" 2>&1; w=$?
    echo "sync-base-leg exit=$w (main $SYNC_BASE_MAIN) $(tail -1 "$D/cov/sync-base-leg.txt"): $(grep -E '^(MAIN-OWN|NOT-MAIN) ' "$D/cov/sync-base-leg.txt" | tr '\n' ' ')"; [ $w -ne 0 ] && st=1
    # a red base leg that names no file (a crash, a parse change) is not a W-SYNC finding set: it stays red
    [ "$base_rc" -ne 0 ] && grep -q '^files named 0;' "$D/cov/sync-base-leg.txt" && { echo "sync-base-leg: base leg red (exit $base_rc) but no file named: RED"; st=1; }
  fi
  if [ -n "$DECISION" ]; then
    [ -s "$DECISION" ] || { echo "REFUSED: decision file $DECISION missing or empty"; exit 4; }
    echo "gate change approved at $(git rev-parse HEAD) by $DECISION sha256 $(sha256sum "$DECISION" | cut -c1-64) (base leg only)" > "$D/cov/gate-change-approval.txt"
    st=$m  # the unapproved base run stays on record; the approved base run decides the base leg; the main leg keeps its match result
    run gate-integrity-base-approved env GATE_CHANGE_APPROVED=1 BASE_REF=$BASE bun scripts/gate-integrity.ts
    # The approved run bypasses EVERY finding; so with EXPECTED_BASE_FINDINGS (the decision's approved paths) the unapproved base
    # findings must equal that set exactly, or the leg is red (an unapproved extra finding cannot hide behind the approval).
    if [ -n "${EXPECTED_BASE_FINDINGS:-}" ]; then
      python3 evidence/w00/findings-match.py "$D/cov/gate-integrity-base.log" "$EXPECTED_BASE_FINDINGS" base > "$D/cov/base-expected-match.txt" 2>&1; b=$?
      echo "base-expected-match exit=$b $(tail -1 "$D/cov/base-expected-match.txt")"; [ $b -ne 0 ] && st=1
    fi
  fi
else
run gate-integrity-origin-main bun scripts/gate-integrity.ts
run gate-integrity-base env BASE_REF=$BASE bun scripts/gate-integrity.ts
if [ -n "$DECISION" ]; then
  [ -s "$DECISION" ] || { echo "REFUSED: decision file $DECISION missing or empty"; exit 4; }
  echo "gate change approved at $(git rev-parse HEAD) by $DECISION sha256 $(sha256sum "$DECISION" | cut -c1-64)" > "$D/cov/gate-change-approval.txt"
  st=0   # the unapproved runs above stay on record; the approved runs below decide
  run gate-integrity-origin-main-approved env GATE_CHANGE_APPROVED=1 bun scripts/gate-integrity.ts
  run gate-integrity-base-approved env GATE_CHANGE_APPROVED=1 BASE_REF=$BASE bun scripts/gate-integrity.ts
fi
fi
# MCG_COVERAGE_INFORMATIONAL=<reason> (lead ruling (a), 2026-10-05, the W-SYNC form for W4H-10): new-file and patch run and are
# recorded, but do NOT set the status, because the first-parent diff of a main-sync merge is main's own files and this hold's lcov
# is partial; the next combined run's final gates are the binding coverage judgement. Never set for a package merge.
if [ -n "${MCG_COVERAGE_INFORMATIONAL:-}" ]; then
  st0=$st
  run new-file env BASE_REF=$BASE bun scripts/check-new-file-coverage.ts
  run patch env BASE_REF=$BASE bun scripts/check-patch-coverage.ts
  st=$st0; echo "new-file and patch: INFORMATIONAL ($MCG_COVERAGE_INFORMATIONAL); they do not set the status"
else
run new-file env BASE_REF=$BASE bun scripts/check-new-file-coverage.ts
run patch env BASE_REF=$BASE bun scripts/check-patch-coverage.ts
fi
echo "GATES at $(git rev-parse --short HEAD) base $BASE status=$st"; exit $st
