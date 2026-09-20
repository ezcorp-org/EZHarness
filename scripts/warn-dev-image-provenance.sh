#!/usr/bin/env sh
# Compare the build-time revision baked into Dockerfile.dev with the checkout
# bind-mounted at /repo. The web source is bind-mounted, so only image-backed
# dependencies and generated assets are at risk when these revisions differ.
set -eu

repo_dir="${EZCORP_REPO_DIR:-/repo}"
image_commit="${EZCORP_IMAGE_BUILD_COMMIT:-unknown}"
checkout_commit="$(git -C "$repo_dir" rev-parse --verify HEAD 2>/dev/null || true)"
checkout_dirty="$(git -C "$repo_dir" status --porcelain 2>/dev/null || true)"

if [ -z "$checkout_commit" ]; then
  echo "WARNING: Cannot read the bind-mounted checkout commit; dev image provenance was not compared." >&2
  echo "         Rebuild through the sanctioned dev-stack wrapper: bun run podman up -d --build" >&2
  exit 0
fi

if [ "$image_commit" = "unknown" ]; then
  echo "WARNING: Dev image provenance is unavailable; its build revision was not recorded." >&2
  echo "         Rebuild through the sanctioned dev-stack wrapper: bun run podman up -d --build" >&2
elif [ "$image_commit" != "$checkout_commit" ]; then
  echo "WARNING: Dev image revision ($image_commit) differs from /repo HEAD ($checkout_commit)." >&2
  echo "         Web source is bind-mounted; image-backed dependencies and generated assets may be stale." >&2
  echo "         Rebuild through the sanctioned dev-stack wrapper: EZCORP_BUILD_COMMIT=$checkout_commit bun run podman up -d --build" >&2
fi

if [ -n "$checkout_dirty" ]; then
  echo "WARNING: /repo has uncommitted changes; matching HEAD revisions cannot prove image-backed files match." >&2
  echo "         Rebuild through the sanctioned dev-stack wrapper: bun run podman up -d --build" >&2
fi
