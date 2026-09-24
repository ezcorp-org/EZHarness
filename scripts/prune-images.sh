#!/usr/bin/env bash
# Reclaim the disk that every rebuild of the prod image leaves behind.
#
#   bun run podman:prune            # remove superseded EZCorp images
#   bash scripts/prune-images.sh --check   # list them; remove nothing
#
# WHY: `up --build` tags the new image `ezcorp:local` and leaves the previous
# one untagged ("dangling"). Each is ~4.5 GB. Nothing ever removes them, so a
# `podman machine` disk sized for the stack (60 GB via setup-podman.sh) fills
# after a handful of rebuilds — measured twice on macOS, and the symptom is a
# build that dies at the Dockerfile's `chown -R /app` layer commit with
# "no space left on device", naming neither the cause nor this fix.
#
# WHAT IT REMOVES — and why that is safe to automate:
#   - only DANGLING images (untagged). Anything tagged — ezcorp:local, a
#     pinned release, a verify tag — is untouched.
#   - only images carrying this project's OCI title label
#     (org.opencontainers.image.title=ezcorp, set in the Dockerfile). Another
#     project's dangling images on the same engine are not ours to delete.
#   - never an image a container still uses: both engines refuse to prune
#     those, so a stopped-but-present container keeps its image.
#
# Engine: scripts/lib/container-engine.sh (Podman on a developer machine,
# Docker under CI, EZCORP_CONTAINER_ENGINE to choose). Both engines accept the
# same `image prune -f --filter label=...` form.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/container-engine.sh
source "$REPO_ROOT/scripts/lib/container-engine.sh"

LABEL_FILTER="label=org.opencontainers.image.title=ezcorp"

CHECK_ONLY=0
case "${1:-}" in
  "") ;;
  --check) CHECK_ONLY=1 ;;
  *)
    echo "usage: bash scripts/prune-images.sh [--check]" >&2
    exit 2
    ;;
esac

superseded="$("$ENGINE" images --filter dangling=true --filter "$LABEL_FILTER" --format '{{.ID}} {{.Size}}')"
if [ -z "$superseded" ]; then
  echo "no superseded EZCorp images to remove"
  exit 0
fi

echo "superseded EZCorp images ($ENGINE):"
printf '%s\n' "$superseded" | sed 's/^/  /'
if [ "$CHECK_ONLY" = 1 ]; then
  exit 0
fi
"$ENGINE" image prune -f --filter "$LABEL_FILTER" >/dev/null
echo "removed"
