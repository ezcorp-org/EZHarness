#!/usr/bin/env bash
# r3-github-repeat.sh <tree> <out dir> [<repeat>]: CI root 3 (ci 39956956620, web/e2e/personal-github-settings.spec.ts:208, device code
# not found) re-run in the mock lane form: the mock preview webServer of web/playwright.config.ts (no DOCKER_TEST; it builds, then
# previews on :4173), chromium, one worker, --repeat-each <repeat> (default 20). Expected (w4h-35 reading, ci-349 triage): EVERY repeat of
# :208 red since 2026-10-18T08:21Z (a page.clock date bomb), :184 green. Exit: playwright's exit; the list report is kept.
set -uo pipefail
T=${1:?tree} O=${2:?out} R=${3:-20}
[ -f "$T/web/e2e/personal-github-settings.spec.ts" ] || { echo "r3: no spec in $T"; exit 2; }
mkdir -p "$O"; cd "$T/web" || exit 2
unset DOCKER_TEST DOCKER_TEST_URL PI_E2E_MOCK_BASE_URL
echo "r3: host date $(date -u +%FT%TZ), repeat $R"
bunx playwright test e2e/personal-github-settings.spec.ts --project=chromium --workers=1 --repeat-each="$R" --reporter=list --output="$O/test-results" > "$O/playwright.log" 2>&1; rc=$?
echo "r3: exit $rc; $(grep -cE '✘ .*personal-github-settings.spec.ts:208' "$O/playwright.log") red of :208, $(grep -cE '✓ .*personal-github-settings.spec.ts:208' "$O/playwright.log") green of :208" | tee -a "$O/playwright.log"
exit $rc
