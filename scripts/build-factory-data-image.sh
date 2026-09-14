#!/usr/bin/env bash
# Builds the pinned PyArrow runner image for `reference.data.v1` FROM THE LOCK.
#
# The image is the C10 release lock's Python runner: its base is pinned by
# registry digest, its dependency closure is generated from the committed
# `src/factory/runner/python/uv.lock` and installed hash-verified, and nothing
# is resolved at build time that the lock does not already name.
#
# The tag is derived from the lock and the Containerfile, so a changed closure
# is a different image rather than a silently replaced one.
#
# Usage: bash scripts/build-factory-data-image.sh [--print-tag]
set -uo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PROJECT_REL="src/factory/runner/python"
CONTEXT="$REPO_ROOT/src/factory/reference-data/image"
LOCK="$REPO_ROOT/$PROJECT_REL/uv.lock"

fail() { echo "factory data image: $*" >&2; exit 1; }

[ -f "$LOCK" ] || fail "missing $PROJECT_REL/uv.lock"
[ -f "$CONTEXT/Containerfile" ] || fail "missing image context"

if command -v uv >/dev/null 2>&1; then uv_exec() { uv "$@"; }
elif command -v nix-shell >/dev/null 2>&1; then uv_exec() { nix-shell -p uv --run "uv $(printf '%q ' "$@")"; }
else fail "no 'uv' available; the closure cannot be generated without the lock resolver"; fi

cd "$REPO_ROOT" || fail "cannot enter repository root"
uv_exec export --locked --no-dev --no-emit-project --format requirements.txt --project "$PROJECT_REL" \
  > "$CONTEXT/locked-requirements.txt" 2>/dev/null \
  || fail "'uv export --locked' failed: the lock does not reproduce"
[ -s "$CONTEXT/locked-requirements.txt" ] || fail "'uv export --locked' wrote nothing"
grep -q '^pyarrow==' "$CONTEXT/locked-requirements.txt" || fail "the exported closure does not contain pyarrow"

TAG_INPUT=$(cat "$LOCK" "$CONTEXT/Containerfile")
TAG=$(printf '%s' "$TAG_INPUT" | sha256sum | cut -c1-32)
IMAGE="localhost/ezcorp-factory-python-data:$TAG"

if [ "${1:-}" = "--print-tag" ]; then echo "$IMAGE"; exit 0; fi

echo "→ building $IMAGE"
podman build --pull=never --tag "$IMAGE" --file "$CONTEXT/Containerfile" "$CONTEXT" >&2 \
  || fail "podman build failed"
podman image inspect "$IMAGE" --format '{{.Id}}' >/dev/null 2>&1 || fail "the built image is not inspectable"
echo "$IMAGE"
