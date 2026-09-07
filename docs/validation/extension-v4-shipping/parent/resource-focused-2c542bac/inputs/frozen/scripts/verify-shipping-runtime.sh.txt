#!/usr/bin/env bash
# Verify one owned production app survives a paused, in-flight extension build.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
: "${EZ_PRODUCTION_IMAGE:?Set the exact candidate production image}"

receipt_dir="${EZ_PRODUCTION_RECEIPT_DIR:-$repo_root/.cache/terra-shipping/runtime}"
export EZ_PRODUCTION_RECEIPT_DIR="$receipt_dir"
# The runner accepts the host UID. The default Docker daemon does not remap
# bind-mounted Unix socket peer credentials, so run this owned app as that UID.
export EZ_PRODUCTION_APP_UID="${EZ_PRODUCTION_APP_UID:-$(id -u)}"
export EZ_PRODUCTION_APP_GID="${EZ_PRODUCTION_APP_GID:-$(id -g)}"

runtime_script="${EZ_PRODUCTION_RUNTIME_SCRIPT:-scripts/verify-shipping-runtime.ts}"
exec bash scripts/verify-production-image-lifecycle.sh -- \
  bun "$runtime_script"
