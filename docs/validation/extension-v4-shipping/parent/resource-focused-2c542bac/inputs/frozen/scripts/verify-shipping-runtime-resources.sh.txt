#!/usr/bin/env bash
# Verify R4 repeat lifecycle, worker cleanup, and authenticated SSE reconnects.
set -euo pipefail

export EZ_PRODUCTION_RUNTIME_SCRIPT="scripts/verify-shipping-runtime-resources.ts"
exec bash scripts/verify-shipping-runtime.sh
