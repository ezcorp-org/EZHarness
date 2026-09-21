#!/usr/bin/env bash
# One-command install of the production stack on Podman.
#
#   bash scripts/setup-podman.sh                # macOS or Linux
#   bash scripts/setup-podman.sh --check        # report; change nothing
#
# Runs on the bash that macOS ships (3.2): no associative arrays, no mapfile,
# no ${var,,}. It needs nothing from this repo's toolchain either — no bun —
# because an operator standing up the prod stack should not need a JavaScript
# runtime to do it. That is also why this is a script and not a `bun run`.
#
# WHAT IT DOES, in order, each step idempotent and each skipped when already
# done:
#
#   1. Engine.   macOS: brew installs podman + docker-compose if absent, then a
#                `podman machine` is created (sized for the ollama sidecar's
#                4g cap) and started. Linux: the rootless socket is enabled.
#   2. Env.      A complete .env.prod is built privately with real secrets, a
#                localhost URL, and the accepted runner choice, then published
#                once without replacement. Existing files are never modified.
#   3. Runner.   The extension-runner mode is accepted before a fresh env file
#                is published, or validated without changing an existing file.
#   4. Dirs.     The four ./.ezcorp bind sources are pre-created. Plain mkdir:
#                under rootless Podman the README's `chown -R 1000:1000` is
#                not merely unnecessary, it locks the operator out of their
#                own tree (compose.podman-prod.yml explains the mapping).
#   5. Up.       `scripts/podman-compose.sh --prod up -d --build`, then waits
#                for /api/ready rather than treating a green `up` as success.
#
# ── The extension runner is a DECISION, not a setup step ───────────────────
#
# Both stacks default to the isolated runner: a host service the app reaches
# over a bind-mounted unix socket. On macOS no container can connect to such
# a socket (docs/macos-local-dev.md has the evidence), so the only working
# mode is `trusted-local` — extensions run inside the app container with the
# app's full reach and NONE of the sandbox controls. The repo requires an
# explicit acknowledgement sentence for that, and this script does not
# supply it on your behalf. On macOS it shows you the consequence and asks;
# `--accept-unsandboxed-extensions` answers yes for non-interactive use.
#
# On Linux nothing is decided for you. If an existing .env.prod names a
# provisioned runner, the isolated mode is kept. Otherwise both paths are
# printed and setup stops without publishing or changing an environment file.
# Silently downgrading a Linux host to unsandboxed extensions would be exactly
# the kind of "helpful" default the acknowledgement exists to prevent.
set -eu

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Overridable so the suite can drive this script against a scratch tree and a
# stubbed engine instead of the real host. Same pattern as podman-compose.sh.
ENV_FILE="${EZ_SETUP_ENV_FILE:-.env.prod}"
ENV_EXAMPLE="${EZ_SETUP_ENV_EXAMPLE:-.env.prod.example}"
DATA_ROOT="${EZ_SETUP_DATA_ROOT:-.ezcorp}"
OS="${EZ_SETUP_OS:-$(uname -s)}"
MACHINE_CPUS="${EZ_MACHINE_CPUS:-4}"
MACHINE_MEMORY="${EZ_MACHINE_MEMORY:-8192}"
MACHINE_DISK="${EZ_MACHINE_DISK:-60}"
READY_URL="${EZ_SETUP_READY_URL:-}"
READY_TIMEOUT="${EZ_SETUP_READY_TIMEOUT:-180}"

CHECK_ONLY=0
NO_START=0
ACCEPT_UNSANDBOXED=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --no-start) NO_START=1 ;;
    --accept-unsandboxed-extensions) ACCEPT_UNSANDBOXED=1 ;;
    -h | --help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "error: unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

TRUSTED_LOCAL_COMPOSE="deploy/extension-runner/compose.trusted-local.yml"
ACK_VARIABLE="EZCORP_EXTENSIONS_UNSANDBOXED_ACK"
ACK_SENTENCE="I-understand-extensions-run-with-the-apps-full-powers"

# Every secret-bearing temporary artifact is a private sibling of the
# destination. A fresh complete candidate is installed with one atomic hard
# link that cannot replace an existing path on either BSD or GNU hosts.
env_tmp=""
secret_tmp=""
watchdog_dir=""
watchdog_fifo=""
watchdog_pid=""
watchdog_fd_open=0
ready_probe_tmp=""
readiness_active_pid=""
# shellcheck disable=SC2329 # Invoked indirectly by the EXIT trap below.
cleanup_setup_artifacts() {
  if [ -n "$readiness_active_pid" ]; then
    kill "$readiness_active_pid" 2>/dev/null || true
    wait "$readiness_active_pid" 2>/dev/null || true
    readiness_active_pid=""
  fi
  if [ "$watchdog_fd_open" = 1 ]; then
    printf '\n' >&9 2>/dev/null || true
  fi
  [ -z "$watchdog_pid" ] || wait "$watchdog_pid" 2>/dev/null || true
  if [ "$watchdog_fd_open" = 1 ]; then
    exec 9>&-
    watchdog_fd_open=0
  fi
  [ -z "$watchdog_fifo" ] || rm -f "$watchdog_fifo"
  [ -z "$watchdog_dir" ] || rmdir "$watchdog_dir" 2>/dev/null || true
  [ -z "$env_tmp" ] || rm -f "$env_tmp"
  [ -z "$secret_tmp" ] || rm -f "$secret_tmp"
  [ -z "$ready_probe_tmp" ] || rm -f "$ready_probe_tmp"
}
trap cleanup_setup_artifacts EXIT
trap 'exit 1' HUP INT TERM

# The prompt is only offered on a terminal: a pipe on stdin must not be read
# as consent. EZ_SETUP_FORCE_TTY=1 lets the suite drive the prompt itself
# through a pipe, so the y/N branch is exercised rather than trusted.
have_tty() { [ "${EZ_SETUP_FORCE_TTY:-0}" = 1 ] || [ -t 0 ]; }

say()  { printf '→ %s\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
todo() { printf '  … %s\n' "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# `do_or_report CMD...` runs the command, or under --check only prints it.
do_or_report() {
  if [ "$CHECK_ONLY" = 1 ]; then
    todo "would run: $*"
  else
    "$@"
  fi
}

# Probe the actual Compose capability, not an executable name. The production
# wrapper accepts either spelling, so setup must use the same rule on both
# operating systems and must not require Homebrew when a working client already
# exists.
COMPOSE_CLI_LABEL=""
probe_compose_cli() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    COMPOSE_CLI_LABEL="docker compose"
    return 0
  fi
  if command -v docker-compose >/dev/null 2>&1 && docker-compose version >/dev/null 2>&1; then
    COMPOSE_CLI_LABEL="docker-compose"
    return 0
  fi
  COMPOSE_CLI_LABEL=""
  return 1
}

# ── 1. Engine ──────────────────────────────────────────────────────────────
say "container engine"
case "$OS" in
  Darwin)
    podman_missing=0
    compose_missing=0
    if command -v podman >/dev/null 2>&1; then
      ok "podman installed"
    else
      podman_missing=1
    fi
    if probe_compose_cli; then
      ok "$COMPOSE_CLI_LABEL installed"
    else
      compose_missing=1
    fi
    if [ "$podman_missing" = 1 ] || [ "$compose_missing" = 1 ]; then
      command -v brew >/dev/null 2>&1 ||
        die "Homebrew is required to install missing Podman or Compose tools on macOS: https://brew.sh"
    fi
    if [ "$podman_missing" = 1 ]; then
      do_or_report brew install podman
      if [ "$CHECK_ONLY" != 1 ]; then
        command -v podman >/dev/null 2>&1 || die "Homebrew did not install a working podman executable"
      fi
    fi
    if [ "$compose_missing" = 1 ]; then
      do_or_report brew install docker-compose
      if [ "$CHECK_ONLY" != 1 ]; then
        probe_compose_cli || die "Homebrew did not install a working Compose CLI"
      fi
    fi
    if command -v podman >/dev/null 2>&1; then
      # `podman machine list` prints one row per machine; a running one shows
      # "Currently running" in the LAST UP column on every podman 4-6.
      if podman machine list 2>/dev/null | grep -q "Currently running"; then
        ok "podman machine running"
      elif podman machine list 2>/dev/null | grep -qv "^NAME"; then
        do_or_report podman machine start
      else
        # 8192m: the ollama sidecar alone declares mem_limit 4g, and the app
        # needs room beside it. The 2g default thrashes.
        do_or_report podman machine init --cpus "$MACHINE_CPUS" --memory "$MACHINE_MEMORY" --disk-size "$MACHINE_DISK"
        do_or_report podman machine start
      fi
    elif [ "$CHECK_ONLY" = 1 ]; then
      todo "would run: podman machine init --cpus $MACHINE_CPUS --memory $MACHINE_MEMORY --disk-size $MACHINE_DISK"
      todo "would run: podman machine start"
    fi
    ;;
  Linux)
    command -v podman >/dev/null 2>&1 || die "podman is required: install it from your distro, then re-run"
    if probe_compose_cli; then
      ok "$COMPOSE_CLI_LABEL installed"
    else
      die "a Compose CLI is required (docker-compose-plugin or docker-compose); it is a client only, no Docker daemon is needed"
    fi
    SOCKET="${EZ_SETUP_PODMAN_SOCKET:-/run/user/$(id -u)/podman/podman.sock}"
    if [ -S "$SOCKET" ]; then
      ok "podman socket at $SOCKET"
    elif command -v systemctl >/dev/null 2>&1; then
      do_or_report systemctl --user enable --now podman.socket
    else
      die "no podman socket at $SOCKET and no systemctl to enable one"
    fi
    ;;
  *) die "unsupported OS: $OS" ;;
esac

# ── 2. Environment and extension-runner decision ───────────────────────────
# Existing environment files are immutable. A fresh setup makes the runner
# decision against one private candidate, validates that complete candidate,
# and then publishes it once without replacement. This removes both the
# compare/rename race and the need for a setup lock.
trim_env_whitespace() {
  local trim_value="$1"
  while :; do
    case "$trim_value" in [[:space:]]*) trim_value="${trim_value#?}" ;; *) break ;; esac
  done
  while :; do
    case "$trim_value" in *[[:space:]]) trim_value="${trim_value%?}" ;; *) break ;; esac
  done
  printf '%s' "$trim_value"
}

# Decode the plain scalar forms used by this repository and accepted by
# Compose: unquoted values with an optional whitespace-prefixed comment, or a
# matching pair of single/double quotes. Never source the operator-owned file.
env_value_from() {
  local env_raw
  env_raw="$(sed -n "s|^$2=||p" "$1" | tail -1)"
  env_raw="${env_raw%$'\r'}"
  env_raw="$(trim_env_whitespace "$env_raw")"
  case "$env_raw" in
    \"*) env_raw="${env_raw#\"}"; printf '%s' "${env_raw%%\"*}" ;;
    \'*) env_raw="${env_raw#\'}"; printf '%s' "${env_raw%%\'*}" ;;
    *)
      case "$env_raw" in *[[:space:]]\#*) env_raw="${env_raw%%[[:space:]]\#*}" ;; esac
      trim_env_whitespace "$env_raw"
      ;;
  esac
}

# Compose gives exported shell values priority over --env-file. Keep setup's
# validation and user-facing URLs on that same precedence path. The whitelist
# makes Bash 3.2's indirect expansion safe without eval, and no secret is ever
# placed in a child process argument.
effective_env_value() {
  local effective_file="$1"
  local effective_name="$2"
  case "$effective_name" in
    EZCORP_ENCRYPTION_SECRET | EZCORP_ENCRYPTION_SALT | EZCORP_JWT_SECRET | \
      EZCORP_PUBLIC_URL | EZCORP_PORT_HOST | EZCORP_RUNNER_COMPOSE_FILE | \
      EZCORP_EXTENSIONS_UNSANDBOXED_ACK | EZ_RUNNER_SOCKET_DIR | \
      EZ_RUNNER_TOKEN_FILE | EZ_RUNNER_GROUP) ;;
    *) die "internal error: unsupported environment value: $effective_name" ;;
  esac
  if [ "${!effective_name+x}" = x ]; then
    printf '%s' "${!effective_name}"
    return 0
  fi
  env_value_from "$effective_file" "$effective_name"
}

required_invalid=""
check_required_value() {
  local required_file="$1"
  local required_name="$2"
  local required_placeholder="$3"
  local required_minimum="$4"
  local required_value
  local required_bad=0
  required_value="$(effective_env_value "$required_file" "$required_name")"
  [ -n "$required_value" ] || required_bad=1
  [ "${#required_value}" -ge "$required_minimum" ] || required_bad=1
  case "$required_value" in *"$required_placeholder"*) required_bad=1 ;; esac
  if [ "$required_bad" = 1 ]; then
    required_invalid="${required_invalid}${required_invalid:+, }$required_name"
  fi
}

validate_required_values() {
  required_invalid=""
  check_required_value "$1" EZCORP_ENCRYPTION_SECRET replace-with-openssl-rand-base64-32 16
  check_required_value "$1" EZCORP_ENCRYPTION_SALT replace-with-openssl-rand-base64-16 16
  check_required_value "$1" EZCORP_JWT_SECRET replace-with-openssl-rand-base64-32 16
  check_required_value "$1" EZCORP_PUBLIC_URL https://ezcorp.example.com 1
  [ -z "$required_invalid" ] || {
    printf 'error: invalid required production values: %s\n' "$required_invalid" >&2
    cat >&2 <<EOF
  Existing environment files are never changed. Exported shell values override
  $1, so correct or unset those overrides first. Then set the invalid file
  values with:
    EZCORP_ENCRYPTION_SECRET=<output of: openssl rand -base64 32>
    EZCORP_ENCRYPTION_SALT=<output of: openssl rand -base64 16>
    EZCORP_JWT_SECRET=<output of: openssl rand -base64 32>
    EZCORP_PUBLIC_URL=<the real http:// or https:// URL for this deployment>
EOF
    exit 2
  }
}

runner_configured_file() {
  local runner_file="$1"
  local runner_compose runner_socket_dir runner_token_file runner_group
  runner_compose="$(effective_env_value "$runner_file" EZCORP_RUNNER_COMPOSE_FILE)"
  if [ "$runner_compose" = "$TRUSTED_LOCAL_COMPOSE" ] &&
    [ "$(effective_env_value "$runner_file" "$ACK_VARIABLE")" = "$ACK_SENTENCE" ]; then
    return 0
  fi
  # A non-empty non-exact override is a topology this script cannot validate.
  # Never borrow stale isolated values and call that custom topology usable.
  [ -z "$runner_compose" ] || return 1
  [ "$OS" = "Linux" ] || return 1
  runner_socket_dir="$(effective_env_value "$runner_file" EZ_RUNNER_SOCKET_DIR)"
  runner_token_file="$(effective_env_value "$runner_file" EZ_RUNNER_TOKEN_FILE)"
  runner_group="$(effective_env_value "$runner_file" EZ_RUNNER_GROUP)"
  case "$runner_group" in '' | *[!0-9]*) return 1 ;; esac
  [ -S "$runner_socket_dir/runner.sock" ] && [ -s "$runner_token_file" ]
}

validate_existing_env() {
  # GNU and BSD spell stat differently. Accept only modes with no group/other
  # bits. 0400 and 0600 are both private.
  env_mode="$(stat -c %a "$ENV_FILE" 2>/dev/null || stat -f %Lp "$ENV_FILE" 2>/dev/null)" ||
    die "could not inspect permissions for $ENV_FILE"
  case "$env_mode" in
    [0-7]00 | 0[0-7]00) ;;
    *) die "$ENV_FILE has unsafe permissions ($env_mode); run: chmod 600 $ENV_FILE" ;;
  esac
  validate_required_values "$ENV_FILE"
  ok "exists with private permissions — left byte-for-byte unchanged"
}

print_consequence() {
  cat <<'EOF'

  The isolated extension runner is not available on this host, so the only
  working mode is trusted-local:

    Extensions build and run INSIDE the app container with the app's full
    reach. No filesystem, network, seccomp or cgroup limits apply. The app
    itself is the blast radius. It will say so at error level on every boot,
    show a standing banner on every page, and refuse to build any bundled
    extension until you acknowledge that exact source digest in the UI.

  If that trade is not acceptable, run the stack on a Linux host with the
  isolated runner (deploy/extension-runner/README.md) and stop here.

EOF
}

append_trusted_local() {
  {
    printf '\n# ─── Extension runner: trusted-local (written by scripts/setup-podman.sh) ──\n'
    printf '# No sandbox applies to extensions in this mode. See docs/macos-local-dev.md.\n'
    printf 'EZCORP_RUNNER_COMPOSE_FILE=%s\n' "$TRUSTED_LOCAL_COMPOSE"
    printf '%s=%s\n' "$ACK_VARIABLE" "$ACK_SENTENCE"
  } >>"$1"
}

print_manual_runner_action() {
  manual_state="$1"
  if [ "$manual_state" = existing ]; then
    printf '\n  Existing environment files are never modified. Edit %s yourself.\n' "$ENV_FILE" >&2
  else
    printf '\n  No %s was published. Create it from %s, then configure a runner.\n' "$ENV_FILE" "$ENV_EXAMPLE" >&2
  fi
  if [ "$OS" = "Darwin" ]; then
    cat >&2 <<EOF
  Add these exact lines after accepting the trusted-local risk:
    EZCORP_RUNNER_COMPOSE_FILE=$TRUSTED_LOCAL_COMPOSE
    $ACK_VARIABLE=$ACK_SENTENCE
EOF
  else
    cat >&2 <<EOF
  Isolated runner (recommended): provision it first, then set all three lines:
    EZ_RUNNER_SOCKET_DIR=/path/to/provisioned/runner-directory
    EZ_RUNNER_TOKEN_FILE=/path/to/provisioned/runner-token
    EZ_RUNNER_GROUP=<container-visible-numeric-gid>

  Or, after accepting the unsandboxed risk, set these exact lines:
    EZCORP_RUNNER_COMPOSE_FILE=$TRUSTED_LOCAL_COMPOSE
    $ACK_VARIABLE=$ACK_SENTENCE
EOF
  fi
}

select_fresh_runner() {
  candidate="$1"
  if [ "$OS" = "Linux" ] && [ "$ACCEPT_UNSANDBOXED" != 1 ]; then
    print_manual_runner_action fresh
    exit 2
  fi
  if [ "$ACCEPT_UNSANDBOXED" = 1 ]; then
    append_trusted_local "$candidate"
  elif have_tty; then
    print_consequence
    printf '  Continue with unsandboxed extensions? [y/N] '
    read -r answer
    case "$answer" in
      y | Y | yes | YES) append_trusted_local "$candidate" ;;
      *) die "stopped at your request; trusted-local was not enabled" ;;
    esac
  else
    print_consequence
    die "not a terminal, so I cannot ask. Re-run with --accept-unsandboxed-extensions to answer yes."
  fi
}

ensure_existing_runner() {
  if runner_configured_file "$ENV_FILE"; then
    ok "runner already configured — environment file left byte-for-byte unchanged"
    return 0
  fi
  if [ "$CHECK_ONLY" = 1 ]; then
    if [ "$OS" = "Darwin" ]; then
      todo "not configured; on macOS add the exact trusted-local settings manually"
    else
      todo "not configured; on Linux select an isolated runner or explicitly accept trusted-local"
    fi
    return 0
  fi
  print_manual_runner_action existing
  exit 2
}

generate_secret() {
  printf '%s=' "$1"
  openssl rand -base64 "$2"
}

build_fresh_candidate() {
  [ -f "$ENV_EXAMPLE" ] || die "$ENV_EXAMPLE is missing"
  command -v openssl >/dev/null 2>&1 || die "openssl is required to generate secrets"
  command -v mktemp >/dev/null 2>&1 || die "mktemp is required to create $ENV_FILE safely"
  env_tmp="$(umask 077 && mktemp "${ENV_FILE}.tmp.XXXXXX")" || die "could not create a private temporary environment file"
  secret_tmp="$(umask 077 && mktemp "${ENV_FILE}.secrets.XXXXXX")" || die "could not create a private secret file"
  {
    generate_secret EZCORP_ENCRYPTION_SECRET 32
    generate_secret EZCORP_ENCRYPTION_SALT 16
    generate_secret EZCORP_JWT_SECRET 32
  } >"$secret_tmp"
  chmod 600 "$secret_tmp"
  if ! awk '
    BEGIN {
      placeholder["EZCORP_ENCRYPTION_SECRET"] = "replace-with-openssl-rand-base64-32"
      placeholder["EZCORP_ENCRYPTION_SALT"] = "replace-with-openssl-rand-base64-16"
      placeholder["EZCORP_JWT_SECRET"] = "replace-with-openssl-rand-base64-32"
    }
    NR == FNR {
      separator = index($0, "=")
      name = substr($0, 1, separator - 1)
      value = substr($0, separator + 1)
      if (separator < 2 || !(name in placeholder) || value == "" || secret_seen[name]++) bad = 1
      secrets[name] = value
      next
    }
    $0 == "EZCORP_PUBLIC_URL=https://ezcorp.example.com" {
      print "EZCORP_PUBLIC_URL=http://localhost:4000"
      public_url_replaced++
      next
    }
    {
      separator = index($0, "=")
      name = ""
      value = ""
      if (separator > 1) {
        name = substr($0, 1, separator - 1)
        value = substr($0, separator + 1)
      }
      if ((name in placeholder) && value == placeholder[name]) {
        print name "=" secrets[name]
        replaced[name]++
        next
      }
      print
    }
    END {
      for (name in placeholder) {
        if (secret_seen[name] != 1 || replaced[name] != 1) bad = 1
      }
      if (public_url_replaced != 1) bad = 1
      if (bad) exit 1
    }
  ' "$secret_tmp" "$ENV_EXAMPLE" >"$env_tmp"; then
    die "placeholder substitution failed — $ENV_EXAMPLE changed shape; no $ENV_FILE was created"
  fi
  rm -f "$secret_tmp"
  secret_tmp=""
  chmod 600 "$env_tmp"
}

say "environment file ($ENV_FILE)"
if [ -f "$ENV_FILE" ]; then
  validate_existing_env
  say "extension runner"
  ensure_existing_runner
elif [ "$CHECK_ONLY" = 1 ]; then
  todo "would create one complete mode-600 file from $ENV_EXAMPLE with generated secrets"
  say "extension runner"
  if [ "$ACCEPT_UNSANDBOXED" = 1 ]; then
    todo "would add trusted-local to the private candidate after explicit acceptance"
  elif [ "$OS" = "Darwin" ]; then
    todo "fresh setup would ask before adding trusted-local to the private candidate"
  else
    todo "not configured; on Linux select an isolated runner or explicitly accept trusted-local"
  fi
else
  build_fresh_candidate
  say "extension runner"
  select_fresh_runner "$env_tmp"
  validate_required_values "$env_tmp"
  runner_configured_file "$env_tmp" || die "the private environment candidate has no usable extension runner"
  if ln "$env_tmp" "$ENV_FILE" 2>/dev/null; then
    rm -f "$env_tmp"
    env_tmp=""
    ok "published one complete mode-600 environment file with fresh secrets and trusted-local"
  elif [ -f "$ENV_FILE" ]; then
    rm -f "$env_tmp"
    env_tmp=""
    todo "another process created $ENV_FILE; validating that file from the beginning"
    validate_existing_env
    ensure_existing_runner
  else
    die "could not install $ENV_FILE without replacing an existing file"
  fi
fi

# ── 3. Bind-mount sources ──────────────────────────────────────────────────
say "bind-mount directories under $DATA_ROOT"
for d in data extensions extension-data projects; do
  if [ -d "$DATA_ROOT/$d" ]; then
    ok "$DATA_ROOT/$d"
  else
    do_or_report mkdir -p "$DATA_ROOT/$d"
  fi
done

# ── 5. Up ──────────────────────────────────────────────────────────────────
say "stack"
if [ "$CHECK_ONLY" = 1 ] || [ "$NO_START" = 1 ]; then
  todo "would run: bash scripts/podman-compose.sh --prod up -d --build"
  exit 0
fi
if [ -z "$READY_URL" ]; then
  ready_port="$(effective_env_value "$ENV_FILE" EZCORP_PORT_HOST)"
  [ -n "$ready_port" ] || ready_port=4000
  case "$ready_port" in
    *[!0-9]*) die "EZCORP_PORT_HOST must be a whole-number port so setup can check readiness" ;;
  esac
  [ "$ready_port" -gt 0 ] && [ "$ready_port" -le 65535 ] ||
    die "EZCORP_PORT_HOST must be between 1 and 65535"
  READY_URL="http://localhost:${ready_port}/api/ready"
fi
case "$READY_TIMEOUT" in
  '' | *[!0-9]*) die "EZ_SETUP_READY_TIMEOUT must be a positive whole number of seconds" ;;
esac
[ "$READY_TIMEOUT" -gt 0 ] || die "EZ_SETUP_READY_TIMEOUT must be greater than zero"

admin_url="$(effective_env_value "$ENV_FILE" EZCORP_PUBLIC_URL)"
[ -n "$admin_url" ] || admin_url="${READY_URL%/api/ready}"

EZ_COMPOSE_ENV_FILE="$ENV_FILE" bash scripts/podman-compose.sh --prod up -d --build
say "waiting for $READY_URL (up to ${READY_TIMEOUT}s)"

# Bash 3.2's `read -t` is a relative kernel timer: changing the wall clock
# cannot extend it. A private FIFO keeps the read pending until either the
# timeout expires or the parent writes one byte on success. Curl and poll
# sleeps run as owned background children so the ALRM trap can stop the active
# operation immediately instead of waiting for its individual timeout.
command -v mkfifo >/dev/null 2>&1 || die "mkfifo is required to enforce the readiness timeout"
watchdog_dir="$(umask 077 && mktemp -d "${ENV_FILE}.watchdog.XXXXXX")" ||
  die "could not create a private readiness timer directory"
watchdog_fifo="$watchdog_dir/timer"
(umask 077 && mkfifo "$watchdog_fifo") || die "could not create the readiness timer"
exec 9<>"$watchdog_fifo"
watchdog_fd_open=1
rm -f "$watchdog_fifo"
watchdog_fifo=""
rmdir "$watchdog_dir"
watchdog_dir=""

readiness_timed_out=0
# shellcheck disable=SC2329 # Invoked indirectly by the ALRM trap below.
readiness_timeout() {
  readiness_timed_out=1
  [ -z "$readiness_active_pid" ] || kill "$readiness_active_pid" 2>/dev/null || true
}
trap readiness_timeout ALRM
readiness_parent_pid="$$"
(
  if ! IFS= read -r -t "$READY_TIMEOUT" _ <&9; then
    kill -ALRM "$readiness_parent_pid"
  fi
) &
watchdog_pid="$!"

stop_readiness_watchdog() {
  if [ "$watchdog_fd_open" = 1 ]; then
    printf '\n' >&9
    wait "$watchdog_pid" 2>/dev/null || true
    watchdog_pid=""
    exec 9>&-
    watchdog_fd_open=0
  fi
  trap - ALRM
}

ready_probe_tmp="$(umask 077 && mktemp "${ENV_FILE}.ready.XXXXXX")" ||
  die "could not create a private readiness response file"
while [ "$readiness_timed_out" = 0 ]; do
  : >"$ready_probe_tmp"
  curl -fsS --max-time 5 "$READY_URL" >"$ready_probe_tmp" 2>/dev/null &
  readiness_active_pid="$!"
  probe_status=0
  wait "$readiness_active_pid" || probe_status="$?"
  readiness_active_pid=""
  if [ "$readiness_timed_out" = 0 ] && [ "$probe_status" = 0 ]; then
    body="$(cat "$ready_probe_tmp")"
  else
    body=""
  fi
  if [ "$readiness_timed_out" = 0 ] && [ -n "$body" ]; then
    stop_readiness_watchdog
    rm -f "$ready_probe_tmp"
    ready_probe_tmp=""
    ok "ready: $body"
    printf '\nOpen %s and create the admin account.\n' "$admin_url"
    exit 0
  fi
  [ "$readiness_timed_out" = 0 ] || break
  sleep 5 &
  readiness_active_pid="$!"
  wait "$readiness_active_pid" 2>/dev/null || true
  readiness_active_pid=""
done
stop_readiness_watchdog
die "the app did not report ready within ${READY_TIMEOUT}s — see: bash scripts/podman-compose.sh --prod logs app"
