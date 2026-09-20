#!/usr/bin/env bash
# Run either stack on rootless Podman. This is the DEFAULT entry point for
# both: Podman is the engine this project targets, and Docker is reachable
# only by pointing the same Compose CLI somewhere else.
#
#   bun run podman up -d                # dev stack  (docker-compose.yml)
#   bun run podman logs -f app
#   bun run podman down
#
#   bun run podman --prod up -d --build # prod stack (compose.prod.yml)
#   bun run podman --prod ps
#
# `--prod` must come first, before any Compose flag or subcommand. It swaps
# the file list AND injects `--env-file .env.prod`, because that stack's
# `${VAR:?}` interpolation aborts without it and Compose 5.5.1 ignores
# COMPOSE_ENV_FILE (measured; the variables simply read as unset).
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

# ── Which stack ────────────────────────────────────────────────────────────
STACK=dev
if [ "${1:-}" = "--prod" ]; then
  STACK=prod
  shift
fi

# ── The Podman socket ──────────────────────────────────────────────────────
#
# On Linux it is the rootless systemd user socket. On macOS there is no such
# path: containers run inside a `podman machine` VM and the API arrives over a
# per-machine socket on the host, whose path only `podman machine inspect`
# knows. Without this fallback the wrapper is Linux-only, which is the whole
# reason macOS instructions drifted to raw `docker compose` invocations.
SOCKET="${PODMAN_SOCKET:-}"
if [ -z "$SOCKET" ]; then
  SOCKET="/run/user/$(id -u)/podman/podman.sock"
  if [ ! -S "$SOCKET" ] && command -v podman >/dev/null 2>&1; then
    MACHINE_SOCKET="$(podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}' 2>/dev/null | head -1)"
    if [ -n "$MACHINE_SOCKET" ]; then SOCKET="$MACHINE_SOCKET"; fi
  fi
fi

if [ ! -S "$SOCKET" ]; then
  echo "error: no Podman socket at $SOCKET" >&2
  echo "  Linux:  systemctl --user enable --now podman.socket" >&2
  echo "  macOS:  podman machine start   (podman machine init, once)" >&2
  echo "  or override the path with PODMAN_SOCKET=/path/to/podman.sock" >&2
  exit 1
fi

# ── The Compose CLI ────────────────────────────────────────────────────────
#
# Either spelling is accepted, and neither needs a Docker daemon: both are
# clients, and DOCKER_HOST below points them at Podman. The standalone
# `docker-compose` binary matters because `brew install docker-compose`
# installs ONLY that — a Podman-only Mac has no `docker` executable at all,
# and requiring one turned this wrapper into a dead end on that host.
#
# podman-compose is still not used: `depends_on: condition: service_healthy`
# (ollama-init waits on ollama) has historically been unreliable there.
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD=(docker-compose)
else
  echo "error: no Docker Compose CLI found." >&2
  echo "  Install either spelling — both are clients pointed at Podman," >&2
  echo "  and the Docker daemon itself is never needed:" >&2
  echo "      brew install docker-compose        # macOS" >&2
  echo "      <your package manager> docker-compose-plugin" >&2
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
if [ "$STACK" = "prod" ]; then
  OVERRIDE_FILE="compose.podman-prod.yml"
  DEFAULT_COMPOSE_FILE="compose.prod.yml:$OVERRIDE_FILE"
else
  OVERRIDE_FILE="compose.podman.yml"
  DEFAULT_COMPOSE_FILE="docker-compose.yml:$OVERRIDE_FILE"
fi

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

# Whether a given GLOBAL flag (e.g. --env-file) appears before the subcommand.
# Same walk as global_file_args: a flag AFTER the subcommand belongs to it.
global_flag_present() {
  local wanted="$1"
  shift
  local -a argv=("$@")
  local i=0 arg
  while [ "$i" -lt "${#argv[@]}" ]; do
    arg="${argv[$i]}"
    case "$arg" in
      "$wanted") return 0 ;;
      "$wanted"=*) return 0 ;;
      -*) if flag_takes_value "$arg"; then i=$((i + 1)); fi ;;
      *) break ;;
    esac
    i=$((i + 1))
  done
  return 1
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

# 3. The prod stack's env file. Its `${VAR:?}` interpolation aborts the deploy
#    when the secrets are absent, and Compose 5.5.1 does not read
#    COMPOSE_ENV_FILE, so the flag has to be on the command line. Injected as
#    a GLOBAL flag (before the subcommand, where Compose accepts any order),
#    and only when the caller did not pass their own.
# EZ_COMPOSE_ENV_FILE lets an operator keep several (staging vs production)
# without spelling out --env-file every time; it is also what makes this
# branch testable, since .env.prod itself is gitignored and absent in CI.
ENV_FILE="${EZ_COMPOSE_ENV_FILE:-.env.prod}"
ENV_FILE_ARGS=()
if [ "$STACK" = "prod" ] && ! global_flag_present --env-file "$@"; then
  if [ ! -f "$ENV_FILE" ]; then
    echo "error: $ENV_FILE is missing — the prod stack cannot interpolate" >&2
    echo "  its required secrets without it." >&2
    echo "      cp .env.prod.example .env.prod && chmod 600 .env.prod" >&2
    exit 1
  fi
  ENV_FILE_ARGS=(--env-file "$ENV_FILE")
fi

export DOCKER_HOST="unix://$SOCKET"
export COMPOSE_FILE="${COMPOSE_FILE:-$DEFAULT_COMPOSE_FILE}"

exec "${COMPOSE_CMD[@]}" "${ENV_FILE_ARGS[@]}" "$@"
