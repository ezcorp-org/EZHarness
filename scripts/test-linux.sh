#!/usr/bin/env bash
# Run a repo test command inside a Linux container, from any host.
#
#   bash scripts/test-linux.sh                    # → bun run test
#   bash scripts/test-linux.sh bun run typecheck  # → anything else
#
# WHY THIS EXISTS (macOS local dev):
# ──────────────────────────────────
# A large part of the backend pool exercises Linux-kernel facilities that do
# not exist on Darwin, so `bun run test` on a Mac fails for reasons that have
# nothing to do with the change under test. Measured on macOS 27 / bun 1.3.14
# at the time this script landed: 115 files / 317 assertions red on a clean
# `main`, dominated by
#
#   - `prlimit` (32) and `flock` (24) and `setsid` (4) not on $PATH — those
#     are util-linux, and the macOS versions either do not exist or are not
#     the same programs;
#   - `/proc/self/fd/<n>/...` path walks (25) — the TOCTOU-safe directory
#     descent in scripts/migrate-extension-v4.ts is procfs-only by design.
#
# None of that is a portability bug in the product: prod ships a Linux
# container, and CI runs on Linux. The gap is purely in how a Mac developer
# runs the suite before pushing. This script closes that gap by running the
# pool where it is meant to run, against the working tree as it is on disk.
#
# ── The node_modules masks are load-bearing ────────────────────────────────
#
# The repo is bind-mounted, so a host `bun install` is visible inside the
# container — including its macOS-native binaries. Reusing them produced 18
# "Ensure your package manager supports multi-platform installation" failures
# on top of everything else. Two named volumes mask the host's node_modules
# with Linux-native installs that persist between runs, so the first run pays
# for the install and later runs do not.
#
# ── What this does NOT fix ─────────────────────────────────────────────────
#
# 43 files still fail in here, and they are the suites that need a PRIVILEGED
# Linux host rather than merely a Linux userland: landlock tiers, compiling a
# seccomp filter, network namespaces, Podman-inside-the-container, and the
# browser-rendering runner. Those are CI's job — see docs/macos-local-dev.md
# for the list and the reasoning. This script gets a Mac from 115 red files to
# 43, all of which fail identically on a clean tree.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [ -n "${EZCORP_TEST_IMAGE:-}" ]; then
  IMAGE="$EZCORP_TEST_IMAGE"
else
  # Reuse the image while its actual toolchain inputs are unchanged. A fixed
  # tag leaves developers on an old Bun or Playwright browser after pulling a
  # Dockerfile/lockfile update, even though the working tree itself is mounted.
  IMAGE_INPUT_HASH="$(
    git hash-object Dockerfile.test .bun-version web/package.json web/bun.lock |
      git hash-object --stdin |
      cut -c1-12
  )"
  IMAGE="ezcorp-test-linux:$IMAGE_INPUT_HASH"
fi
ROOT_MODULES_VOLUME="${EZCORP_TEST_ROOT_MODULES:-ezcorp-test-node-modules}"
WEB_MODULES_VOLUME="${EZCORP_TEST_WEB_MODULES:-ezcorp-test-web-node-modules}"

# Podman first: it is the rootless engine the deployment docs already assume,
# and on macOS it is what `podman machine` provides. Docker is accepted so a
# Linux box with only Docker can still use this script.
ENGINE="${EZCORP_CONTAINER_ENGINE:-}"
if [ -z "$ENGINE" ]; then
  if command -v podman >/dev/null 2>&1; then
    ENGINE=podman
  elif command -v docker >/dev/null 2>&1; then
    ENGINE=docker
  else
    echo "error: neither podman nor docker is on \$PATH." >&2
    echo "  macOS:  brew install podman && podman machine init && podman machine start" >&2
    echo "  Linux:  install podman (or docker) from your distro" >&2
    exit 1
  fi
fi

# `keep-id` maps the container's runtime uid back to the invoking user so files
# written into the bind mount stay owned by the developer. It is rootless-only:
# Docker has no equivalent and rejects the flag.
USERNS_ARGS=()
if [ "$ENGINE" = "podman" ]; then
  USERNS_ARGS=(--userns=keep-id)
fi

if ! "$ENGINE" image exists "$IMAGE" 2>/dev/null && ! "$ENGINE" image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "→ building $IMAGE from Dockerfile.test (first run only)..."
  "$ENGINE" build -f Dockerfile.test -t "$IMAGE" .
fi

# The image's own COPY of the source is irrelevant — /repo shadows it — but it
# carries the toolchain (bun pinned to .bun-version, node, git, util-linux).
# Default command, set positionally: `"${@:-bun run test}"` would collapse the
# three words into ONE argv entry when no arguments are given.
if [ "$#" -eq 0 ]; then
  set -- bun run test
fi

# `-t` only when stdin is a terminal: with it in a non-interactive context
# (CI, a pipe, an agent shell) the engine refuses with "the input device is
# not a TTY" and nothing runs.
TTY_ARGS=(-i)
if [ -t 0 ]; then
  TTY_ARGS=(-it)
fi

exec "$ENGINE" run --rm "${TTY_ARGS[@]}" \
  -v "$REPO_ROOT:/repo" \
  -v "$ROOT_MODULES_VOLUME:/repo/node_modules" \
  -v "$WEB_MODULES_VOLUME:/repo/web/node_modules" \
  -w /repo \
  "${USERNS_ARGS[@]}" \
  -e CI=1 \
  `# Bun's install cache defaults to <cwd>/.bun inside the container, and cwd` \
  `# is the bind-mounted repo — so an unset cache dir drops a root-owned` \
  `# .bun/ into the developer's working tree on every run.` \
  -e BUN_INSTALL_CACHE_DIR=/tmp/bun-install-cache \
  -e EZCORP_DB_PATH=":memory:" \
  -e PI_SKIP_INIT=1 \
  "$IMAGE" \
  bash -lc 'bun install --frozen-lockfile >/dev/null && (cd web && bun install --frozen-lockfile >/dev/null) && exec "$@"' _ \
  "$@"
