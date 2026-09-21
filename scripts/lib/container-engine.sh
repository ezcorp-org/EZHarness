#!/usr/bin/env bash
# One place that decides which container engine a script drives.
#
#   source scripts/lib/container-engine.sh
#   "$ENGINE" run ...
#
# Exports ENGINE as `podman` or `docker`. The rule, in order:
#
#   1. EZCORP_CONTAINER_ENGINE, when set, wins — the operator said so.
#   2. Under CI, Docker when it is present. GitHub's Ubuntu runners ship BOTH
#      engines, and release-image.yml builds `ezcorp:verify` with Docker
#      (build-push-action, load: true) before running the verify scripts
#      against it. A "prefer Podman" rule there would point those scripts at
#      an empty Podman store and fail the release gate on an image that
#      exists — in the other engine.
#   3. Otherwise Podman when it is present: it is the engine this project
#      targets, and on a developer machine it is the one the deployment docs
#      and `bun run podman` already assume.
#   4. Otherwise Docker.
#
# A script that sources this and uses "$ENGINE" everywhere needs no other
# change to run on either engine — the CLIs agree on every subcommand the
# verify scripts use (build with a tar context on stdin and --load, run,
# exec, logs, stop/start/restart, volume create/inspect/rm, inspect
# --format with Docker's .Config.* layout). Measured on podman 6.1.2 before
# the scripts were converted; src/__tests__/container-engine.test.ts holds
# the resolution rule itself.
#
# Written for bash 3.2 (macOS) — no associative arrays, no mapfile.
if [ -n "${EZCORP_CONTAINER_ENGINE:-}" ]; then
  case "$EZCORP_CONTAINER_ENGINE" in
    podman | docker) ;;
    *)
      echo "error: EZCORP_CONTAINER_ENGINE must be 'podman' or 'docker' (got '$EZCORP_CONTAINER_ENGINE')" >&2
      exit 2
      ;;
  esac
  if ! command -v "$EZCORP_CONTAINER_ENGINE" >/dev/null 2>&1; then
    echo "error: EZCORP_CONTAINER_ENGINE=$EZCORP_CONTAINER_ENGINE but no such executable on \$PATH" >&2
    exit 2
  fi
  ENGINE="$EZCORP_CONTAINER_ENGINE"
elif [ -n "${CI:-}" ] && command -v docker >/dev/null 2>&1; then
  ENGINE=docker
elif command -v podman >/dev/null 2>&1; then
  ENGINE=podman
elif command -v docker >/dev/null 2>&1; then
  ENGINE=docker
else
  echo "error: neither podman nor docker is on \$PATH." >&2
  echo "  macOS:  brew install podman && podman machine init && podman machine start" >&2
  echo "  Linux:  install podman (or docker) from your distro" >&2
  echo "  or name one explicitly: EZCORP_CONTAINER_ENGINE=podman|docker" >&2
  exit 2
fi
export ENGINE

# ── Compose ────────────────────────────────────────────────────────────────
#
# Scripts that drive a compose project call `resolve_compose` and then use
# "${COMPOSE[@]}" where they would have written `docker compose`. It is a
# function rather than part of the top-level resolution so a script that never
# touches compose (verify-docker-image.sh, rollback, upgrade's own phases)
# does not require a Compose CLI to be installed at all.
#
# Either spelling is accepted — the `docker compose` plugin or the standalone
# `docker-compose` binary. Both are clients: under Podman they are pointed at
# the Podman socket through DOCKER_HOST, and no Docker daemon is involved.
# `brew install docker-compose` installs only the standalone binary, so a
# Podman-only Mac has no `docker` executable — hence the second branch.
#
# Under Podman the socket is the rootless systemd user socket on Linux, or
# the per-machine socket that only `podman machine inspect` knows on macOS.
# An already-exported DOCKER_HOST is honoured untouched.
resolve_compose() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    COMPOSE=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE=(docker-compose)
  else
    echo "error: no Docker Compose CLI found (needed as a client for $ENGINE)." >&2
    echo "      brew install docker-compose        # macOS" >&2
    echo "      <your package manager> docker-compose-plugin" >&2
    return 2
  fi
  if [ "$ENGINE" = podman ] && [ -z "${DOCKER_HOST:-}" ]; then
    local sock="/run/user/$(id -u)/podman/podman.sock"
    if [ ! -S "$sock" ]; then
      sock="$(podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}' 2>/dev/null | head -1)"
    fi
    if [ -z "$sock" ] || [ ! -S "$sock" ]; then
      echo "error: ENGINE is podman but no Podman socket was found for Compose to use." >&2
      echo "  Linux:  systemctl --user enable --now podman.socket" >&2
      echo "  macOS:  podman machine start" >&2
      echo "  or export DOCKER_HOST=unix:///path/to/podman.sock" >&2
      return 2
    fi
    export DOCKER_HOST="unix://$sock"
  fi
  export COMPOSE
}
