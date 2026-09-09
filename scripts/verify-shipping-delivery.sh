#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
: "${EZ_PRODUCTION_IMAGE:?Set the retained production image tag}"
: "${EZ_PRODUCTION_RECEIPT_DIR:?Set an empty owned receipt directory}"

export EZCORP_EXTENSION_INTERNAL_ORIGINS='["http://127.0.0.1:7071"]'
exec bash scripts/verify-production-image-lifecycle.sh -- bun scripts/verify-shipping-delivery.ts
