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
#      on the tmpfs secret masks; without it Podman's tmpcopyup default seeds
#      each mask with the very tree it exists to hide. Forgetting it always
#      fails closed, but WHICH failure you get depends on how big the masked
#      tree is, and neither one names the missing file: a mask over a large
#      tree aborts the container inside the OCI runtime with an opaque ENOSPC,
#      and only a mask small enough to fit its tmpfs lets the container run far
#      enough to reach the app's legible boot-time guard. Both are written up
#      in docs/deployment.md §"Running under Podman". The point of this wrapper
#      is to reach neither.
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

# ── Preflight: nothing but this wrapper decides the compose file list ───────
#
# Everything above guarantees the RIGHT invocation. These two checks close the
# ways a caller can defeat that guarantee through the wrapper itself, because
# the resulting failure is unreadable: with the override missing, Podman's
# tmpcopyup default seeds each mask from the tree it hides, the OCI runtime
# runs a 17 GB tree into a 64 MB tmpfs while building the mount namespace, and
# the container dies at `Created` with an ENOSPC that mentions neither the mask
# nor the missing file. docs/deployment.md §"Running under Podman" has the
# verbatim error. Fail here instead, where the cause still has a name.
OVERRIDE_FILE="compose.podman.yml"
DEFAULT_COMPOSE_FILE="docker-compose.yml:$OVERRIDE_FILE"

# Compose global flags that consume the NEXT argument (`docker compose --help`,
# Compose 5.1.3). Used only to find where the global flags END: a `-f` before
# the subcommand is --file, but in `bun run podman logs -f app` it is --follow,
# and rejecting that documented invocation would be worse than the bug.
flag_takes_value() {
  case "$1" in
    -f | --file | -p | --project-name | --project-directory | --env-file | \
      --profile | --progress | --ansi | --parallel) return 0 ;;
    *) return 1 ;;
  esac
}

# Values of the GLOBAL -f/--file flags in "$@", one per line.
global_file_args() {
  local -a argv=("$@")
  local i=0 arg
  while [ "$i" -lt "${#argv[@]}" ]; do
    arg="${argv[$i]}"
    case "$arg" in
      -f | --file)
        i=$((i + 1))
        printf '%s\n' "${argv[$i]:-}"
        ;;
      -f=* | --file=*) printf '%s\n' "${arg#*=}" ;;
      # Any other global flag. Skipping its value matters: without that,
      # `-p myproject` would read as the subcommand and a later -f would be
      # missed.
      -*) if flag_takes_value "$arg"; then i=$((i + 1)); fi ;;
      # The subcommand. Every flag after it belongs to IT, not to compose.
      *) break ;;
    esac
    i=$((i + 1))
  done
}

# 1. A global -f/--file REPLACES COMPOSE_FILE rather than adding to it, so it
#    silently drops the override this wrapper exists to layer on. Measured
#    against Compose 5.1.3: `COMPOSE_FILE=base.yml:extra.yml docker compose
#    -f base.yml config --services` lists base.yml's services only.
REQUESTED_FILES="$(global_file_args "$@")"
if [ -n "$REQUESTED_FILES" ]; then
  OVERRIDE_REQUESTED=""
  while IFS= read -r requested; do
    case "$requested" in *"$OVERRIDE_FILE") OVERRIDE_REQUESTED=1 ;; esac
  done <<<"$REQUESTED_FILES"
  if [ -z "$OVERRIDE_REQUESTED" ]; then
    echo "error: a compose -f/--file was passed through this wrapper and none" >&2
    echo "       of the files is $OVERRIDE_FILE:" >&2
    while IFS= read -r requested; do echo "         -f $requested" >&2; done \
      <<<"$REQUESTED_FILES"
    echo "  -f REPLACES the file list rather than adding to it, so the Podman" >&2
    echo "  override would be dropped and the tmpfs secret masks would fail" >&2
    echo "  open. Name it explicitly to layer your own file on top:" >&2
    echo "      bun run podman -f docker-compose.yml -f $OVERRIDE_FILE ..." >&2
    exit 1
  fi
fi

# 2. An inherited COMPOSE_FILE is the mirror image: the export below WINS over
#    it, so the caller's list is the thing that vanishes without a word. Honour
#    a value that already layers the override (the Podman-only-host setup this
#    file's header describes) and refuse one that does not.
if [ -n "${COMPOSE_FILE:-}" ]; then
  case "$COMPOSE_FILE" in
    *"$OVERRIDE_FILE"*) ;;
    *)
      echo "error: COMPOSE_FILE is set in the environment and does not name" >&2
      echo "       $OVERRIDE_FILE:" >&2
      echo "         COMPOSE_FILE=$COMPOSE_FILE" >&2
      echo "  This wrapper exports its own value over yours, so yours would be" >&2
      echo "  discarded silently. Either unset it to take the wrapper's list" >&2
      echo "  ($DEFAULT_COMPOSE_FILE), or add" >&2
      echo "  $OVERRIDE_FILE to it and the wrapper will keep your list as-is." >&2
      exit 1
      ;;
  esac
fi

export DOCKER_HOST="unix://$SOCKET"
export COMPOSE_FILE="${COMPOSE_FILE:-$DEFAULT_COMPOSE_FILE}"

exec docker compose "$@"
