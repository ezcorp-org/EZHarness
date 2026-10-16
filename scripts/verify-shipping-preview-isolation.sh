#!/usr/bin/env bash
# Run the uid-based preview isolation tests inside the production image (proof
# "preview-isolation", production-proof namespace shard; scripts/production-proof-plan.ts).
#
# The two test files need the image's setuid-root preview-spawn helper, the
# preview uid range and live /proc/net/tcp, so they run in the candidate image,
# never on the host. The image ships no tests, so the repository's test folder
# is mounted read-only. Rootless Podman maps 65,536 subordinate ids: the map
# keeps the image's low ids (root, the bun user) and moves the helper's preview
# range 90000-99000 (build/preview-spawn.c) onto the rest. Bun's report is the
# receipt; scripts/verify-shipping-production-results.ts checks it test by test.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

: "${EZ_PRODUCTION_IMAGE:?Set EZ_PRODUCTION_IMAGE to the exact candidate image}"
: "${EZ_PRODUCTION_RECEIPT_DIR:?Set EZ_PRODUCTION_RECEIPT_DIR to an owned receipt directory}"

mapfile -t files < <(bun scripts/production-proof-plan.ts bound-tests preview-isolation)
mkdir -p "$EZ_PRODUCTION_RECEIPT_DIR"
report="$EZ_PRODUCTION_RECEIPT_DIR/bun-report.txt"

status=0
podman run --rm \
  --uidmap=0:0:56536 --uidmap=90000:56536:9001 --gidmap=0:0:56536 --gidmap=90000:56536:9001 \
  --network=none \
  --env="EZCORP_PREVIEW_ISOLATION_PROOF=1" \
  --volume="$repo_root/src/__tests__:/app/src/__tests__:ro" \
  --entrypoint=bun \
  "$EZ_PRODUCTION_IMAGE" test --timeout 60000 "${files[@]/#/./}" 2>&1 | tee "$report" || status=$?

# A Bun run exits 0 when every test skipped. The proof holds only when tests ran,
# none skipped, and none failed.
if ! grep -Eq '^ *[1-9][0-9]* pass$' "$report" || grep -Eq '^ *[1-9][0-9]* (skip|todo|fail)$' "$report"; then
  echo "preview-isolation: the in-image tests did not all run and pass" >&2
  exit 1
fi
exit "$status"
