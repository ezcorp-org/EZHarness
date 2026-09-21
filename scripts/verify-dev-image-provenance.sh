#!/usr/bin/env bash
# Build and inspect the development image provenance contract.
#
# Engine selection is shared with every other image verifier: Podman on a
# developer machine, Docker in CI, or EZCORP_CONTAINER_ENGINE when explicit.
# CI builds through docker/build-push-action with the GHA cache and invokes
# this script with --no-build; local runs reuse the selected engine's cache.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib/container-engine.sh
source scripts/lib/container-engine.sh

IMAGE="${VERIFY_DEV_PROVENANCE_IMAGE:-ezcorp:verify-dev-provenance}"
REVISION="${VERIFY_DEV_PROVENANCE_REVISION:-$(git rev-parse HEAD 2>/dev/null || echo dev-verify)}"
SOURCE_STATE="${VERIFY_DEV_PROVENANCE_SOURCE_STATE:-dirty}"

die() {
  echo "error: $1" >&2
  exit 1
}

if [ "${1:-}" != "--no-build" ]; then
  "$ENGINE" build \
    --build-arg "EZCORP_BUILD_COMMIT=$REVISION" \
    --build-arg "EZCORP_BUILD_SOURCE_STATE=$SOURCE_STATE" \
    -t "$IMAGE" \
    -f Dockerfile.dev \
    .
fi

actual_revision=$("$ENGINE" image inspect "$IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
actual_source_state=$("$ENGINE" image inspect "$IMAGE" --format '{{index .Config.Labels "org.ezcorp.image.source-state"}}')
image_env=$("$ENGINE" image inspect "$IMAGE" --format '{{json .Config.Env}}')

[ "$actual_revision" = "$REVISION" ] \
  || die "OCI revision expected '$REVISION', got '$actual_revision'"
[ "$actual_source_state" = "$SOURCE_STATE" ] \
  || die "OCI source state expected '$SOURCE_STATE', got '$actual_source_state'"
echo "$image_env" | jq -e --arg expected "EZCORP_IMAGE_BUILD_COMMIT=$REVISION" 'index($expected) != null' >/dev/null \
  || die "runtime image environment is missing EZCORP_IMAGE_BUILD_COMMIT=$REVISION"
echo "$image_env" | jq -e --arg expected "EZCORP_IMAGE_BUILD_SOURCE_STATE=$SOURCE_STATE" 'index($expected) != null' >/dev/null \
  || die "runtime image environment is missing EZCORP_IMAGE_BUILD_SOURCE_STATE=$SOURCE_STATE"

echo "dev image provenance verified: revision=$REVISION source-state=$SOURCE_STATE engine=$ENGINE"
