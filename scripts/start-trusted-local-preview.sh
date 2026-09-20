#!/usr/bin/env bash
# Start the production preview with extensions in the trusted-local mode —
# the explicit, per-release-acknowledged UNSANDBOXED mode — and NO host
# runner. Counterpart of start-real-extension-preview.sh, which starts the
# authenticated rootless-Podman runner instead.
#
# Used by web/playwright.trusted-local.config.ts through the real-auth
# fixture wrapper, exactly like the isolated lane:
#
#   bash e2e/run-real-auth-fixture.sh bash ../scripts/start-trusted-local-preview.sh
#
# The in-process TrustedLocalRunner refuses root and refuses a platform other
# than Linux; both checks are the runner's own (`probeSecurity`), repeated
# here only so the failure has a name before a 3-minute build starts.
set -euo pipefail
export BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [[ "$(id -u)" == "0" ]]; then
  echo "trusted-local runs extensions as the app account and refuses root; run as an unprivileged user." >&2
  exit 1
fi

# The two keys of the fail-closed gate in src/extensions/runner-mode.ts.
export EZCORP_EXTENSION_RUNNER=trusted-local
export EZCORP_EXTENSIONS_UNSANDBOXED_ACK=I-understand-extensions-run-with-the-apps-full-powers
# An isolated-runner setting alongside the mode is a refused conflict.
unset EZCORP_EXTENSION_RUNNER_SOCKET EZCORP_EXTENSION_RUNNER_TOKEN EZCORP_EXTENSION_RUNNER_TOKEN_FILE
# The bundled server cannot resolve `packages/` relative to its own chunks;
# point the project root and the trusted SDK entry at this checkout.
export EZCORP_PROJECT_ROOT="$repo_root"
export EZ_EXTENSION_RUNNER_SDK_ENTRY="$repo_root/packages/@ezcorp/sdk/src/v4/index.ts"

cd web
bun run build
export PORT="${EZCORP_PORT:-4173}"
export HOST=127.0.0.1
export ORIGIN="${ORIGIN:-http://localhost:$PORT}"
export BODY_SIZE_LIMIT="${BODY_SIZE_LIMIT:-134217728}"
unset SOCKET_PATH
exec bun build/index.js
