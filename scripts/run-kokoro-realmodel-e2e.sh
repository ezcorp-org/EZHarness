#!/usr/bin/env bash
set -euo pipefail

if [[ "${EZCORP_E2E_KOKORO_REAL:-}" != "1" ]]; then
  echo "Set EZCORP_E2E_KOKORO_REAL=1 to authorize the external Kokoro ONNX model download." >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root/web"
exec bunx playwright test --config playwright.kokoro-real.config.ts --project=chromium --workers=1 --reporter=list "$@"
