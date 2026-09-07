#!/usr/bin/env bash
# Exercise the candidate server's compiled embedding dependency and stored result.
set -euo pipefail

export EZ_PRODUCTION_RUNTIME_SCRIPT="scripts/verify-shipping-embeddings.ts"
exec bash scripts/verify-shipping-runtime.sh
