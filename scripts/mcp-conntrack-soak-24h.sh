#!/usr/bin/env bash
# Operator run: 20 Stage2 workers, 1,000 real proxy requests each over 24h.
# Requires the candidate image, rootless Podman, and readable kernel journal.
# A shorter explicit duration verifies only that shorter interval.
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
export EZCORP_STAGE2_SOAK_SECONDS="${1:-86400}"
export EZCORP_STAGE2_SOAK_WORKERS=20
export EZCORP_STAGE2_SOAK_REQUESTS=1000
exec node "$script_dir/stage2-conntrack-soak.mjs"
