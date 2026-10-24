#!/usr/bin/env bash
# W4F merge hold (shared by W4F-1/2/3), ONE lock hold on the clean detached merge commit:
#   bash evidence/w00/gated-flock.sh <label> <dir>/hold-gate.log timeout 7200 bash hold-w4f.sh <dir>   (gate before the lock, lead 2026-10-04; branch-dir holds merge-sha.txt,
#   unit.txt [hook-mapped non-PG files, ./-paths], pg.txt [PostgreSQL suites], expected-base-findings.txt [W4F-1 only], decision [W4F-1])
# Producer legs switch on from the merge's diff vs its first parent (standing rule: a producer runs whenever the diff touches its
# measured set): provisioning producer; factory-sdk suite; orchestrator package test + Node producer (also for factory-transport);
# web vitest coverage for web/src/lib (the only producer there). Then lcov merge, runbook, CRAP (--changed vs this merge's base,
# binding: every function this merge touched <= 30; origin/main is wave4f's final gates), merge-commit-gates (base: exact set or none; main: the 8 lines).
set -u
D=${1:?branch evidence dir}
. evidence/w00/heavy-lib.sh
M=$(cat $D/merge-sha.txt)
# EXTRA-LEGS-GATE-BEGIN (F4, team-lead 2026-10-23, after the W4H-35 hold ran without its extra legs): the folder holds extra-legs.sh OR an
# explicit extra-legs.none record (one line: why this merge has no package legs); neither = REFUSED here, before the config check and any leg.
[ -f $D/extra-legs.sh ] || [ -f $D/extra-legs.none ] || { echo "REFUSED: $D has neither extra-legs.sh nor extra-legs.none; no leg runs" >> "$S"; exit 3; }
# EXTRA-LEGS-GATE-END
python3 evidence/w00/config-check.py --accept-note "$D/config-note.txt" >> "$S" 2>&1 || { echo "STOP: shared config check at hold start" >> "$S"; st=1; heavy_done; exit 1; }
echo "shared config hash at hold start: $(sha256sum /home/<USER>/work/EZCorp/EZHarness/.git/config | cut -c1-16) (accepted baseline $(cat evidence/w00/config-baseline/hash.accepted))" >> "$S"
[ "$(git rev-parse HEAD)" = "$M" ] && [ -z "$(git branch --show-current)" ] && [ -z "$(git status --porcelain)" ] || { echo "REFUSED: not at the clean detached merge $M" >> "$S"; exit 3; }
B=$(git rev-parse HEAD^1); git diff --name-only $B HEAD > $D/diff-files.txt
touches() { grep -qE "$1" $D/diff-files.txt; }
# Prune scan (lead 2026-10-03, common.md "Prune scan"): before any leg; a prune subcommand outside a comment or a test is a STOP.
bash evidence/w00/prune-scan.sh "$D" "$B" > /dev/null 2>&1; ps_rc=$?
echo "prune scan: exit $ps_rc ($(tail -1 $D/prune-scan.txt 2>/dev/null))" >> "$S"
[ "$ps_rc" = 0 ] || { echo "STOP: prune scan found a prune command (prune-scan.txt); report to the lead" >> "$S"; st=1; heavy_done; exit 1; }
NOTEST=1 leg attestation-check python3 evidence/w00/attestation-check.py "$M" src/factory/task-stops.ts --allow-removal
guard_leg
C=coverage/$(basename $D); rm -rf $C coverage/lcov.info; mkdir -p $C
for p in sdk transport orchestrator; do NOTEST=1 leg build-factory-$p bun run --cwd packages/@ezcorp/factory-$p build; done
# PG-LEGS-BEGIN (team-lead's staging item 6 "75i"): each pg file runs with its CI step env, read by w00/pg-step-env.py through the ONE
# workflow reader (ci-workflow-steps.ts); pg() still sets DATABASE_URL and FACTORY_TEST_POSTGRES_URL to this hold's server. Every file's
# summary goes to pg-step-env.log; a REFUSED key (exit 4), a key on no list (5), the Bun flag off the pinned value (6), an AMBIGUOUS file (3)
# or a reader failure (2) is a RED leg by name, never a run without its env and never a run with a refused key (team-lead's rulings
# 0a892fb02b54ed4b and fa7ebe77c2b62c95).
[ -s $D/pg.txt ] && while read -r f; do n=$(basename $f .test.ts)
  pe=$(mktemp /tmp/hold-pg-env.XXXXXX); python3 -I evidence/w00/pg-step-env.py "$PWD" "$f" > "$pe" 2>> $D/pg-step-env.log < /dev/null; per=$?
  if [ "$per" = 0 ]; then PE=(); mapfile -d '' PE < "$pe"; leg "pg-$n" pg env ${PE[@]+"${PE[@]}"} bun test --timeout <PID> --coverage --coverage-reporter=lcov --coverage-dir=$C/pg-$n "$f"
  else NOTEST=1 leg "pg-$n" bash -c 'echo "pg-step-env refused $1: exit $2 (pg-step-env.log)"; exit 2' _ "$f" "$per"; fi
  rm -f "$pe"; done < $D/pg.txt
# PG-LEGS-END
[ -s $D/unit.txt ] && while read -r f; do n=$(echo "${f#./}" | tr '/.@' '---'); leg "unit-$n" bun test --timeout <PID> --coverage --coverage-reporter=lcov --coverage-dir=$C/unit-$n "$f"; done < $D/unit.txt
# Package-specific legs ruled for one merge (e.g. W4G-11: a set in ONE process, a --check command): $D/extra-legs.sh, sourced
# here so it uses this hold's leg/pg helpers, coverage dir $C and merge $M.
# EXTRA-LEGS-SOURCE-BEGIN
if [ -f $D/extra-legs.sh ]; then echo "extra-legs: $D/extra-legs.sh $(sha256sum $D/extra-legs.sh | cut -c1-16)" >> "$S"; . $D/extra-legs.sh
else echo "extra-legs: none, by record $D/extra-legs.none $(sha256sum $D/extra-legs.none | cut -c1-16): $(head -1 $D/extra-legs.none)" >> "$S"; fi
# EXTRA-LEGS-SOURCE-END
# lane-forms (hold leg (b), team-lead's ruling 2026-10-17; it replaces the retired web-bunleg-changed): every CHANGED *.test.ts runs in EVERY
# required hosted lane that owns it (w00/lane-table.tsv; ownership = this tree's classifier sets and vitest's own list), in the lane's own
# command, env and cwd; podman=no rows run without Podman (the hosted no-runner form). Drift of a row's pins, an orphan, a set with no row,
# a red or zero-test run and a Podman row outside the lock are red by name (w00/lane-forms-leg.py); no changed test file: its named PASS.
# v6: --base $B (this merge's first parent) adds every test file whose lane set moved between the base and head rules ("MOVED").
# v7 (team-lead's ruling a8b7283108caee00): under heavy-lib's pg(), so the workflow-step and lane rows get the hold's own PostgreSQL
# (the leg drops both database URLs from every other row's env).
NOTEST=1 leg lane-forms pg python3 -I evidence/w00/lane-forms-leg.py --table evidence/w00/lane-table.tsv --diff-files $D/diff-files.txt --covdir "$PWD/$C/lane-forms" --base $B
# hold leg (e) (team-lead's ruling after the push16 hosted red, 2026-10-17): every test that digests the SDK bundle runs when the merge touches
# what that digest covers (w00/sdk-digest-select.sh: lock constants found by a repository search); each through file_leg, the hosted command.
# HOLD-LEG-E-BEGIN
SDS=$(bash evidence/w00/sdk-digest-select.sh $D/diff-files.txt 2>$D/sdk-digest-select.log); sds=$?
if [ $sds != 0 ]; then NOTEST=1 leg sdk-digest bash -c 'cat "$1"; exit 2' _ $D/sdk-digest-select.log
elif [ -z "$SDS" ]; then NOTEST=1 leg sdk-digest cat $D/sdk-digest-select.log
else for t in $SDS; do file_leg "sdk-digest-$(basename "$t" .test.ts | tr . -)" "$t" bun test --timeout <PID> "./$t"; done; fi
# HOLD-LEG-E-END
touches '^packages/@ezcorp/factory-sdk/' && leg sdk-lcov bun test --coverage --coverage-reporter=lcov --coverage-dir=$C/sdk ./packages/@ezcorp/factory-sdk/src
if touches '^packages/@ezcorp/factory-(orchestrator|transport)/'; then
  leg orchestrator-package-test bash -c 'cd packages/@ezcorp/factory-orchestrator && exec bun run test'
  node_cov_leg orchestrator-node $C/orch; fi
touches '^src/factory/(provisioning/|gateway-process\.ts)' && leg pg-provisioning-gateway pg env -u DATABASE_URL COV_OUT=$REPO/$C/pg-provisioning bash scripts/factory-provisioning-coverage.sh
# W4G legs, switched on by the diff (lead 2026-10-01, W4G brief):
#  - the pool coverage producer (CI db-postgres step) for pool code, private-files or the producer itself;
#  - the Python quality lanes as CI runs them (ci.yml: `python-quality.sh all`) for the pin or the locked project;
#  - the dependency audit as deps-audit.yml runs it for any lockfile or package manifest;
#  - BOTH images built to the end with podman for any container file (the candidate job builds the whole Dockerfile).
touches '^src/factory/(pool/|private-files)|^scripts/factory-pool-coverage\.sh' && leg pg-pool-producer pg env COV_OUT=$REPO/$C/pool-producer bash scripts/factory-pool-coverage.sh
touches '^\.python-version$|^src/factory/runner/python/|^src/factory/reference-image/python/|^scripts/python-quality' && NOTEST=1 leg python-quality-all bash scripts/python-quality.sh all
touches '(^|/)bun\.lock$|(^|/)package\.json$' && NOTEST=1 leg deps-audit bun scripts/audit-deps.ts
touches '^web/(bun\.lock|package\.json)$' && leg web-vitest-full bash scripts/web-vitest-coverage.sh --output $REPO/$C/web-vitest-full   # a web dependency change runs the whole web vitest pool (its lcov joins)
# actionlint 1.7.7 (release checksum verified; w00/tools/actionlint-1.7.7) for any workflow or action change, with the two
# self-hosted runner labels declared (lead 2026-10-01, W4G-6): 0 errors over every workflow is the gate.
touches '^\.github/(workflows|actions)/' && NOTEST=1 leg actionlint evidence/w00/tools/actionlint-1.7.7/actionlint -config-file evidence/w00/tools/actionlint-1.7.7/actionlint-labels.yaml
touches '^\.github/(workflows|actions)/|^\.github/actionlint\.yaml$' && NOTEST=1 leg actionlint-labels python3 -I evidence/w00/tools/actionlint-1.7.7/actionlint-labels-agree.py .github/actionlint.yaml evidence/w00/tools/actionlint-1.7.7/actionlint-labels.yaml   # the repository's labels equal the hold's (w4h-36; absent file passes, named)
# Container files: every image built from a CLEAN snapshot of the merge commit (git archive, w00/image-leg.sh), never from this
# worktree, whose ignored dist/ folders would mask a missing build step (W4G-1 REJECT). Full (then boot to /api/health 200/401),
# full --no-cache, dev with its provenance check, test, and the factory image (w4f-3's documented commands, lead item 6).
if touches '(^|/)Dockerfile[^/]*$|^deploy/factory/Dockerfile'; then
  for im in full boot fullnocache dev test factory; do NOTEST=1 leg image-$im bash evidence/w00/image-leg.sh "$M" $im; done
fi
if touches '^web/src/lib/'; then
  grep -E '^web/src/lib/.*\.(unit|component|server)\.test\.ts$' $D/diff-files.txt | sed 's#^web/##' > $D/web-vitest.txt || true
  [ -s $D/web-vitest.txt ] && leg web-lib-vitest-lcov bash evidence/w16/repro/web-vitest-lcov.sh $REPO $REPO/$C/weblib $(cat $D/web-vitest.txt); fi
web_server_leg $C/web
# The Bun canonical producers (scripts/coverage-config.ts BUN_CANONICAL_PRODUCERS: a source whose ONLY trusted lcov is a tagged producer),
# run as CI's scripts/test-coverage.sh runs them, api-client first (team-lead/validator-8 R4, 2026-10-16, after the W4H-33 hold: the patch
# gate found web/src/lib/api.ts with NO lcov record because no hold leg ran its producer). A missing producer script fails by name.
# web-utility-coverage.sh writes its bun output to temp files and checks its own records, so it runs NOTEST.
file_leg bun-producer-api-client scripts/api-client-coverage.sh env COV_OUT=$REPO/$C/bun-api-client bash scripts/api-client-coverage.sh
file_leg bun-producer-empty-node-shim scripts/empty-node-shim-coverage.sh env COV_OUT=$REPO/$C/bun-empty-node-shim bash scripts/empty-node-shim-coverage.sh
# web-utility-coverage.sh writes its bun output to temp files and checks its own records itself, so its leg runs NOTEST.
NOTEST=1 file_leg bun-producer-web-utility scripts/web-utility-coverage.sh env COV_OUT=$REPO/$C/bun-web-utility bash scripts/web-utility-coverage.sh
for d in $C/*/; do [ -f $d/lcov.info ] && cp $d/lcov.info $C/$(basename $d).lcov; done
NOTEST=1 leg coverage-merge bun scripts/merge-lcov.ts "$C/*.lcov" coverage/lcov.info
# Parity with the hosted per-file gate (validator-8 R7, 2026-10-16, after ci 38887660827): a source file OUTSIDE the repository in the
# merged lcov (e.g. a test's /tmp bundle) is counted by the hosted "Global coverage floor"; the local hold names it red here.
NOTEST=1 leg lcov-foreign-sources python3 -I evidence/w00/lcov-foreign-sources.py "$REPO" coverage/lcov.info
cp coverage/lcov.info $D/merged.lcov
mock_pass_known_flake $(basename $D)-mock
# CRAP: BINDING against this merge's base (only the functions THIS merge touched; every one must be <= 30).
# No origin/main leg here (lead ruling 2026-10-01): origin/main CRAP is judged by wave4f's final gates over the full-pool lcov;
# the hold's lcov is partial and is not used for that judgment.
if [ -n "${MCG_COVERAGE_INFORMATIONAL:-}" ]; then
  # Opt-in (lead ruling (a), 2026-10-05, W4H-10 main sync only): CRAP --changed vs the first parent runs and is recorded in full, but
  # does not set the status (the first-parent diff is main's code on partial lcov); the next combined run's CRAP binds.
  INFORMATIONAL="$MCG_COVERAGE_INFORMATIONAL" NOTEST=1 leg crap-changed-base env BASE_REF=$B bun scripts/crap-score.ts --changed   # leg-judge.sh: raw exit kept, no status
  echo "crap-changed-base: INFORMATIONAL ($MCG_COVERAGE_INFORMATIONAL); it does not set the status" >> "$S"
else
NOTEST=1 leg crap-changed-base env BASE_REF=$B bun scripts/crap-score.ts --changed
fi
# The origin/main leg's expected set: the shared 8-line file, or $D/expected-main-findings.txt when the merge folder has one (even
# empty: after the W-SYNC of main 6eb1bbb33, main carries the gate tooling and the leg reads 0; integrator-5 2026-10-12).
XM=evidence/w00/expected-integ-findings-vs-main.txt; [ -e $D/expected-main-findings.txt ] && XM=$D/expected-main-findings.txt
echo "origin/main leg expected set: $XM ($(grep -c . $XM) line(s))" >> "$S"
if [ -s $D/expected-base-findings.txt ]; then
  NOTEST=1 leg merge-commit-gates env EXPECTED_BASE_FINDINGS=$D/expected-base-findings.txt EXPECTED_MAIN_FINDINGS=$XM bash evidence/w00/merge-commit-gates.sh "$D" "$B" "$D/../gate-change-decision.txt"
else
  # a ruled gate change without a decision file: $D/expected-integ-findings-vs-base.txt names the base leg's expected findings
  # (team-lead 2026-10-16, W4H-33 red A); merge-commit-gates.sh then judges the base leg by that set, as the origin/main leg
  XB=; [ -e $D/expected-integ-findings-vs-base.txt ] && XB=$D/expected-integ-findings-vs-base.txt && echo "base leg expected set: $XB ($(grep -c . $XB) line(s))" >> "$S"
  NOTEST=1 leg merge-commit-gates env ${XB:+EXPECTED_BASE_FINDINGS=$XB} EXPECTED_MAIN_FINDINGS=$XM bash evidence/w00/merge-commit-gates.sh "$D" "$B"
fi
python3 evidence/w00/config-check.py --accept-note "$D/config-note.txt" >> "$S" 2>&1 || { echo "STOP: shared config check at hold end" >> "$S"; st=1; }
echo "shared config hash at hold end: $(sha256sum /home/<USER>/work/EZCorp/EZHarness/.git/config | cut -c1-16) (accepted baseline $(cat evidence/w00/config-baseline/hash.accepted))" >> "$S"
heavy_done
