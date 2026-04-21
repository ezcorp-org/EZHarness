#!/usr/bin/env bash
# Run Playwright end-to-end tests from web/e2e.
#
# scripts/test-web.sh runs the web/ unit tests (bun test on src/__tests__).
# This script is the missing counterpart that actually executes the
# Playwright specs under web/e2e/*.spec.ts via web/playwright.config.ts.
#
# Playwright manages its own preview webServer (see webServer block in
# web/playwright.config.ts) when DOCKER_TEST is not set, so no separate
# dev-server start is needed here.
#
# If browsers are not yet installed, run:
#   cd web && bunx playwright install chromium
#
# Any arguments passed to this script are forwarded to `playwright test`,
# e.g.  scripts/test-e2e.sh --list
#       scripts/test-e2e.sh e2e/auth-login.spec.ts
set -e

cd "$(dirname "$0")/../web"

# Ensure SvelteKit types exist (needed for $lib alias resolution)
if [ ! -f .svelte-kit/tsconfig.json ]; then
  echo "Generating SvelteKit types..."
  bunx svelte-kit sync
fi

exec bunx playwright test "$@"
