#!/usr/bin/env bash
# Build the web app with source maps solely for browser V8 coverage conversion.
# Production builds do not set this flag and retain their existing map policy.
set -euo pipefail
: "${EZCORP_BROWSER_COVERAGE:=1}"
export EZCORP_BROWSER_COVERAGE
cd "$(dirname "$0")/../web"
bun run build
