#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
export EZCORP_EXTENSION_INTERNAL_ORIGINS='["http://127.0.0.1:7071"]'
exec bash scripts/verify-production-image-lifecycle.sh -- bun scripts/verify-shipping-revocation.ts
