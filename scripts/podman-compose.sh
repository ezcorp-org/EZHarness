#!/usr/bin/env bash
# Run the dev stack on rootless Podman.
#
#   bun run podman up -d
#   bun run podman logs -f app
#   bun run podman down
#
# Thin wrapper around the REAL Docker Compose CLI pointed at the rootless
# Podman socket. Two things it guarantees, both of which fail silently when
# done by hand:
#
#   1. DOCKER_HOST points at the Podman socket, so `docker compose` drives
#      Podman instead of the Docker daemon (this box runs both).
#   2. compose.podman.yml is layered on. That override carries `notmpcopyup`
#      on the two tmpfs secret masks; without it Podman's tmpcopyup default
#      seeds each mask with the very tree it exists to hide. The app's
#      boot-time guard turns that into a hard failure rather than a silent
#      leak, but the point of this wrapper is to not hit it in the first place.
#
# Deliberately NOT done by exporting COMPOSE_FILE in .env: Compose reads
# COMPOSE_FILE from .env for EVERY runtime, so a plain `docker compose up`
# against the Docker daemon would then also load this override and die on
# `invalid tmpfs option [notmpcopyup]`. Verified on this repo. If a host runs
# Podman *only*, setting COMPOSE_FILE in .env is safe and saves the wrapper.
#
# podman-compose is intentionally not used: `depends_on: condition:
# service_healthy` (ollama-init waits on ollama) has historically been
# unreliable there. The Docker Compose CLI over the Podman socket handles it.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SOCKET="${PODMAN_SOCKET:-/run/user/$(id -u)/podman/podman.sock}"

if [ ! -S "$SOCKET" ]; then
  echo "error: no Podman socket at $SOCKET" >&2
  echo "  start it with:  systemctl --user enable --now podman.socket" >&2
  echo "  or override the path with PODMAN_SOCKET=/path/to/podman.sock" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "error: the 'docker' CLI (Docker Compose v2+) is required." >&2
  echo "  It is used as a client against the Podman socket; the Docker" >&2
  echo "  daemon itself is not needed." >&2
  exit 1
fi

export DOCKER_HOST="unix://$SOCKET"
export COMPOSE_FILE="docker-compose.yml:compose.podman.yml"

exec docker compose "$@"
