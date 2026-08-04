#!/usr/bin/env bash
# The blocking mock-gate e2e lane, exactly as CI runs it.
#
# The 17 specs `web/e2e/lanes.json` marks `mock-gate`, resolved through the one
# script that owns that derivation (`scripts/e2e-lane-args.ts`) rather than a
# hand-copied list that could drift from the manifest — and `--project=chromium`,
# which is what `.github/workflows/ci.yml:168` passes. `mobile-chromium` exists
# in `playwright.config.ts` but NO CI job runs it (its own config comment says
# "currently unused"); running it locally is a superset of the gate, and it
# currently reds on a pre-existing `diff-panel.spec.ts` viewport assertion that
# is unrelated to this branch — reproduced on the base commit in
# `76-PREEXISTING-diff-panel-on-BASE-7d53be3c.txt`.
#
# `$?` is captured on its own line IMMEDIATELY after the run — never through a
# pipe, never after a trailing `echo`, either of which would report the status
# of the last thing that ran instead of the lane's.
set -u
cd "$(dirname "$0")/../web"
mapfile -t ARGS < <(bun ../scripts/e2e-lane-args.ts mock-gate)
OUT="${1:-../.c3-gate-logs/74-e2e-mock-gate-lane.txt}"
bunx playwright test --project=chromium "${ARGS[@]}" > "$OUT" 2>&1
CODE=$?
echo "EXIT_CODE=$CODE" >> "$OUT"
exit "$CODE"
