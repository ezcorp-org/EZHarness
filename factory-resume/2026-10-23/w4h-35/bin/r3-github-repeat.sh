#!/usr/bin/env bash
# r3-github-repeat.sh <tree> <out dir> [<repeat>]: CI root 3 (ci 39956956620, web/e2e/personal-github-settings.spec.ts:208, device code
# not found) re-run in the mock lane form: the mock preview webServer of web/playwright.config.ts (no DOCKER_TEST; it builds, then
# previews on :4173), chromium, one worker, --repeat-each <repeat> (default 20). Expected (w4h-35 reading, ci-349 triage): EVERY repeat of
# :208 red since 2026-10-18T08:21Z (a page.clock date bomb), :184 green. Exit: playwright's exit; the list report is kept.
# NOT RUN is red by name, exit 3, never a 0/0 count (session 11 v4: the webServer build failed and the count read 0 red, 0 green):
# the tree needs its own installed web/node_modules (scratch-tree.sh <rev> <dir> install), and every repeat of :208 must report.
set -uo pipefail
T=${1:?tree} O=${2:?out} R=${3:-20}
[ -f "$T/web/e2e/personal-github-settings.spec.ts" ] || { echo "r3: no spec in $T"; exit 2; }
[ -d "$T/web/node_modules" ] && [ ! -L "$T/web/node_modules" ] || { echo "r3: NOT RUN: $T/web/node_modules is not an installed folder (scratch-tree.sh ... install)"; exit 3; }
mkdir -p "$O"; cd "$T/web" || exit 2
unset DOCKER_TEST DOCKER_TEST_URL PI_E2E_MOCK_BASE_URL
echo "r3: host date $(date -u +%FT%TZ), repeat $R"
bunx playwright test e2e/personal-github-settings.spec.ts --project=chromium --workers=1 --repeat-each="$R" --reporter=list --output="$O/test-results" > "$O/playwright.log" 2>&1; rc=$?
# The case is keyed by its TITLE, not its line: commit 10 moves it from :208 to :211 (dry run r3-dry/r3-a27-plus10).
TITLE='personal-github-settings.spec.ts:[0-9]+:1 › failed account lookup retires its one-use code and starts a fresh request'
red=$(grep -cE "✘ .*$TITLE" "$O/playwright.log"); green=$(grep -cE "✓ .*$TITLE" "$O/playwright.log")
if grep -q 'Process from config.webServer was not able to start' "$O/playwright.log" || [ $((red+green)) != "$R" ]; then
  echo "r3: NOT RUN: $((red+green)) of $R repeats of :208 reported (webServer: $(grep -c 'webServer was not able to start' "$O/playwright.log") start failure); exit $rc" | tee -a "$O/playwright.log"; exit 3; fi
echo "r3: exit $rc; $red red of :208, $green green of :208" | tee -a "$O/playwright.log"
exit $rc
