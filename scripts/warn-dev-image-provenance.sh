#!/usr/bin/env sh
# Compare the build-time revision baked into Dockerfile.dev with the checkout
# bind-mounted at /repo. The web source is bind-mounted, so only image-backed
# dependencies and generated assets are at risk when these revisions differ.
set -eu

repo_dir="${EZCORP_REPO_DIR:-/repo}"
image_commit="${EZCORP_IMAGE_BUILD_COMMIT:-unknown}"
image_source_state="${EZCORP_IMAGE_BUILD_SOURCE_STATE:-unknown}"
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
checkout_commit="$(bash "$script_dir/resolve-dev-image-source-state.sh" --revision "$repo_dir" 2>/dev/null || echo unknown)"
checkout_source_state="$(bash "$script_dir/resolve-dev-image-source-state.sh" "$repo_dir" 2>/dev/null || echo unknown)"

print_rebuild_commands() {
  revision="${checkout_commit:-unknown}"
  source_state='$(bash scripts/resolve-dev-image-source-state.sh)'
  printf '         Docker: EZCORP_BUILD_COMMIT=%s EZCORP_BUILD_SOURCE_STATE=%s docker compose up -d --build\n' "$revision" "$source_state" >&2
  echo "         Rootless Podman: bun run podman up -d --build" >&2
}

if [ "$checkout_commit" = unknown ]; then
  echo "WARNING: Cannot read the bind-mounted checkout commit; dev image provenance was not compared." >&2
  print_rebuild_commands
  exit 0
fi

print_rebuild=0
if [ "$image_commit" = "unknown" ]; then
  echo "WARNING: Dev image provenance is unavailable; its build revision was not recorded." >&2
  print_rebuild=1
elif [ "$image_commit" != "$checkout_commit" ]; then
  echo "WARNING: Dev image revision ($image_commit) differs from /repo HEAD ($checkout_commit)." >&2
  echo "         Web source is bind-mounted; image-backed dependencies and generated assets may be stale." >&2
  print_rebuild=1
fi

case "$image_source_state" in
  clean) ;;
  dirty)
    echo "WARNING: This dev image was built from uncommitted source changes." >&2
    echo "         Its image-backed dependencies and generated assets may not match the current checkout." >&2
    print_rebuild=1
    ;;
  *)
    if [ "$image_commit" != "unknown" ]; then
      echo "WARNING: Dev image build source state is unavailable; a matching revision does not prove its image-backed files were clean." >&2
      print_rebuild=1
    fi
    ;;
esac

case "$checkout_source_state" in
  clean) ;;
  dirty)
    echo "WARNING: /repo has uncommitted Docker build-context changes; matching HEAD revisions cannot prove image-backed files match." >&2
    echo "         Rebuild the image, or restore the Docker build context to HEAD before relying on the revision comparison." >&2
    print_rebuild=1
    ;;
  *)
    echo "WARNING: Cannot inspect /repo for uncommitted Docker build-context changes; the revision comparison is incomplete." >&2
    print_rebuild=1
    ;;
esac

if [ "$print_rebuild" = 1 ]; then
  print_rebuild_commands
fi
