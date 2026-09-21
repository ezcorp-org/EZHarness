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
EFFECTIVE_ENV_NAMES="EZCORP_ENCRYPTION_SECRET EZCORP_ENCRYPTION_SALT EZCORP_JWT_SECRET EZCORP_PUBLIC_URL EZCORP_PORT_HOST EZCORP_RUNNER_COMPOSE_FILE EZCORP_EXTENSIONS_UNSANDBOXED_ACK EZ_RUNNER_SOCKET_DIR EZ_RUNNER_TOKEN_FILE EZ_RUNNER_GROUP"

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
resolved_env_tmp=""
resolved_env_error_tmp=""
runner_header_tmp=""
runner_probe_tmp=""
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
  [ -z "$resolved_env_tmp" ] || rm -f "$resolved_env_tmp"
  [ -z "$resolved_env_error_tmp" ] || rm -f "$resolved_env_error_tmp"
  [ -z "$runner_header_tmp" ] || rm -f "$runner_header_tmp"
  [ -z "$runner_probe_tmp" ] || rm -f "$runner_probe_tmp"
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
    SOCKET="${PODMAN_SOCKET:-/run/user/$(id -u)/podman/podman.sock}"
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

# GNU and BSD stat use different format flags. Keep that portability detail in
# one place because both the environment file and runner credential depend on
# metadata checks.
portable_stat_value() {
  local gnu_format="$1"
  local bsd_format="$2"
  local stat_path="$3"
  stat -c "$gnu_format" "$stat_path" 2>/dev/null || stat -f "$bsd_format" "$stat_path" 2>/dev/null
}

# EZCORP_PUBLIC_URL is passed directly to SvelteKit as ORIGIN. It must be a
# canonical origin, never a base URL. Curl's maintained URL parser validates
# schemes and IPv6 without a network request (the deliberately absent Unix
# socket makes the transfer fail after parsing). The small AWK check adds the
# DNS/IPv4 rules that curl intentionally leaves to name resolution.
valid_public_url() {
  local public_url="$1"
  local parsed_url public_authority public_host public_port="" remainder
  command -v curl >/dev/null 2>&1 || die "curl is required to validate EZCORP_PUBLIC_URL"
  case "$public_url" in
    http://*) public_authority="${public_url#http://}" ;;
    https://*) public_authority="${public_url#https://}" ;;
    *) return 1 ;;
  esac
  case "$public_authority" in
    '' | *[/?#@[:space:][:cntrl:]]*) return 1 ;;
  esac
  parsed_url="$(curl -sS -o /dev/null --connect-timeout 1 --max-time 1 \
    --proto '=http,https' --unix-socket /__ezcorp_origin_validation_no_socket__ \
    -w '%{url_effective}' "$public_url" 2>/dev/null || true)"
  [ "$parsed_url" = "$public_url/" ] || return 1
  case "$public_authority" in
    \[*\]*)
      public_host="${public_authority%%]*}"
      public_host="${public_host#\[}"
      # Curl accepts RFC 6874 zone identifiers, but the WHATWG URL parser used
      # by Bun/SvelteKit rejects them. ORIGIN must work in the application, not
      # merely in curl's broader URL grammar.
      case "$public_host" in *%*) return 1 ;; esac
      remainder="${public_authority#*]}"
      case "$remainder" in '') ;; :*) public_port="${remainder#:}" ;; *) return 1 ;; esac
      # Curl has already parsed this as IPv6. No DNS-label check applies.
      public_host=""
      ;;
    *:*)
      public_host="${public_authority%:*}"
      public_port="${public_authority##*:}"
      case "$public_host" in *:*) return 1 ;; esac
      ;;
    *) public_host="$public_authority" ;;
  esac
  if [ -n "$public_port" ]; then
    case "$public_port" in *[!0-9]*) return 1 ;; esac
    [ "$public_port" -gt 0 ] && [ "$public_port" -le 65535 ] || return 1
  fi
  [ -z "$public_host" ] || awk -v hostname="$public_host" '
    BEGIN {
      if (hostname == "" || length(hostname) > 253 || hostname ~ /^\./ || hostname ~ /\.$/) exit 1
      if (hostname ~ /^[0-9.]+$/) {
        count = split(hostname, octets, ".")
        if (count != 4) exit 1
        for (i = 1; i <= 4; i++) {
          if (octets[i] !~ /^[0-9]+$/ || octets[i] + 0 > 255 ||
              (length(octets[i]) > 1 && substr(octets[i], 1, 1) == "0")) exit 1
        }
        exit 0
      }
      count = split(hostname, labels, ".")
      for (i = 1; i <= count; i++) {
        label = labels[i]
        if (label == "" || length(label) > 63 || label !~ /^[0-9A-Za-z-]+$/ ||
            label !~ /^[0-9A-Za-z]/ || label !~ /[0-9A-Za-z]$/) exit 1
      }
    }
  '
}

# An explicit readiness target may include a path or query, but it is still an
# HTTP endpoint. `--url` makes the value data even if it starts with a dash;
# the deliberately absent Unix socket lets curl parse it without a network
# request. Exit 7 is the expected connection failure after successful parsing.
valid_readiness_url() {
  local readiness_url="$1"
  local parsed_url curl_status=0
  case "$readiness_url" in
    http://* | https://*) ;;
    *) return 1 ;;
  esac
  case "$readiness_url" in
    *[[:space:][:cntrl:]]* | *@*) return 1 ;;
  esac
  parsed_url="$(curl -sS -o /dev/null --connect-timeout 1 --max-time 1 \
    --proto '=http,https' --unix-socket /__ezcorp_readiness_validation_no_socket__ \
    -w '%{url_effective}' --url "$readiness_url" 2>/dev/null)" || curl_status="$?"
  case "$curl_status" in 0 | 7) ;; *) return 1 ;; esac
  [ -n "$parsed_url" ]
}

# `config --environment` is deliberately line-oriented and does not escape
# newlines inside resolved values. Reject the two ways a whitelisted shell or
# dotenv value can become multiline before a valid first line is mistaken for
# the complete value. Compose still owns all quoting and interpolation rules;
# this check only narrows accepted values to the output format we can read
# without exposing secrets to argv or logs.
validate_exported_effective_values() {
  local env_name env_value
  local LC_ALL=C
  for env_name in $EFFECTIVE_ENV_NAMES; do
    if [ -n "${!env_name+x}" ]; then
      env_value="${!env_name}"
      case "$env_value" in
        *[[:cntrl:]]*) die "$env_name must not contain newline or control characters" ;;
      esac
    fi
  done
}

validate_env_source_line_safety() {
  local resolve_file="$1"
  LC_ALL=C awk '
    function reject() { bad = 1; exit }
    {
      line = $0
      sub(/\r$/, "", line)
      sub(/^[[:space:]]*/, "", line)
      if (line == "" || substr(line, 1, 1) == "#") next
      sub(/^export[[:space:]]+/, "", line)
      separator = index(line, "=")
      if (separator < 2) next
      value = substr(line, separator + 1)
      sub(/^[[:space:]]*/, "", value)
      quote = substr(value, 1, 1)
      if (quote == "\047") {
        if (index(substr(value, 2), "\047") == 0) reject()
        next
      }
      if (quote != "\"") next
      escaped = 0
      closed = 0
      for (i = 2; i <= length(value); i++) {
        character = substr(value, i, 1)
        if (escaped) {
          if (character == "n" || character == "r" || character == "t") reject()
          escaped = 0
        } else if (character == "\\") {
          escaped = 1
        } else if (character == "\"") {
          closed = 1
          break
        }
      }
      if (!closed) reject()
    }
    END { if (bad) exit 1 }
  ' "$resolve_file" || die "$resolve_file contains a multiline or control-character value that setup cannot validate safely"
}

validate_resolved_environment_shape() {
  LC_ALL=C awk '
    {
      separator = index($0, "=")
      name = substr($0, 1, separator - 1)
      if (separator < 2 || name !~ /^[A-Za-z_][A-Za-z0-9_]*$/ ||
          $0 ~ /[[:cntrl:]]/ || seen[name]++) bad = 1
    }
    END { if (bad) exit 1 }
  ' "$resolved_env_tmp" || die "resolved Compose environment contains a multiline, control-character, or ambiguous value"
}

# Compose owns .env quoting, comments, interpolation and shell precedence. Ask
# the selected real Compose client for its resolved environment instead of
# maintaining a second, inevitably divergent parser here. The output contains
# secrets, so both stdout and stderr stay in private files and are never shown.
resolve_compose_environment() {
  local resolve_file="$1"
  validate_exported_effective_values
  validate_env_source_line_safety "$resolve_file"
  command -v mktemp >/dev/null 2>&1 || die "mktemp is required to validate $resolve_file safely"
  [ -z "$resolved_env_tmp" ] || rm -f "$resolved_env_tmp"
  [ -z "$resolved_env_error_tmp" ] || rm -f "$resolved_env_error_tmp"
  resolved_env_tmp="$(umask 077 && mktemp "${ENV_FILE}.resolved.XXXXXX")" ||
    die "could not create a private resolved-environment file"
  resolved_env_error_tmp="$(umask 077 && mktemp "${ENV_FILE}.resolve-error.XXXXXX")" ||
    die "could not create a private Compose error file"
  if [ "$COMPOSE_CLI_LABEL" = "docker compose" ]; then
    if ! docker compose --env-file "$resolve_file" -f - config --environment >"$resolved_env_tmp" 2>"$resolved_env_error_tmp" <<'EOF'
services:
  setup_env_probe:
    image: scratch
EOF
    then
      die "$resolve_file is not valid Compose environment syntax; run the production Compose config command for details"
    fi
  elif ! docker-compose --env-file "$resolve_file" -f - config --environment >"$resolved_env_tmp" 2>"$resolved_env_error_tmp" <<'EOF'
services:
  setup_env_probe:
    image: scratch
EOF
  then
    die "$resolve_file is not valid Compose environment syntax; run the production Compose config command for details"
  fi
  validate_resolved_environment_shape
  rm -f "$resolved_env_error_tmp"
  resolved_env_error_tmp=""
}

# Read only the fixed setup whitelist from Compose's private resolved output.
# Compose emits one NAME=value line for each effective interpolation value.
effective_env_value() {
  local effective_name="$1"
  case " $EFFECTIVE_ENV_NAMES " in
    *" $effective_name "*) ;;
    *) die "internal error: unsupported environment value: $effective_name" ;;
  esac
  sed -n "s|^$effective_name=||p" "$resolved_env_tmp" | tail -1
}

required_invalid=""
check_required_value() {
  local required_name="$1"
  local required_placeholder="$2"
  local required_minimum="$3"
  local required_value
  local required_bad=0
  required_value="$(effective_env_value "$required_name")"
  [ -n "$required_value" ] || required_bad=1
  [ "${#required_value}" -ge "$required_minimum" ] || required_bad=1
  case "$required_value" in *"$required_placeholder"*) required_bad=1 ;; esac
  if [ "$required_name" = EZCORP_PUBLIC_URL ] && ! valid_public_url "$required_value"; then
    required_bad=1
  fi
  if [ "$required_bad" = 1 ]; then
    required_invalid="${required_invalid}${required_invalid:+, }$required_name"
  fi
}

validate_required_values() {
  required_invalid=""
  check_required_value EZCORP_ENCRYPTION_SECRET replace-with-openssl-rand-base64-32 16
  check_required_value EZCORP_ENCRYPTION_SALT replace-with-openssl-rand-base64-16 16
  check_required_value EZCORP_JWT_SECRET replace-with-openssl-rand-base64-32 16
  check_required_value EZCORP_PUBLIC_URL https://ezcorp.example.com 1
  [ -z "$required_invalid" ] || {
    printf 'error: invalid required production values: %s\n' "$required_invalid" >&2
    cat >&2 <<EOF
  Existing environment files are never changed. Exported shell values override
  $ENV_FILE, so correct or unset those overrides first. Then set the invalid file
  values with:
    EZCORP_ENCRYPTION_SECRET=<output of: openssl rand -base64 32>
    EZCORP_ENCRYPTION_SALT=<output of: openssl rand -base64 16>
    EZCORP_JWT_SECRET=<output of: openssl rand -base64 32>
    EZCORP_PUBLIC_URL=<the real http:// or https:// URL for this deployment>
EOF
    exit 2
  }
}

runner_configuration_error=""
validated_runner_token=""
runner_configured() {
  local runner_compose runner_socket_dir runner_token_file runner_group
  runner_configuration_error=""
  validated_runner_token=""
  runner_compose="$(effective_env_value EZCORP_RUNNER_COMPOSE_FILE)"
  if [ "$runner_compose" = "$TRUSTED_LOCAL_COMPOSE" ] &&
    [ "$(effective_env_value "$ACK_VARIABLE")" = "$ACK_SENTENCE" ]; then
    return 0
  fi
  # A non-empty non-exact override is a topology this script cannot validate.
  # Never borrow stale isolated values and call that custom topology usable.
  if [ -n "$runner_compose" ]; then
    runner_configuration_error="EZCORP_RUNNER_COMPOSE_FILE does not select a supported runner topology"
    return 1
  fi
  [ "$OS" = "Linux" ] || return 1
  runner_socket_dir="$(effective_env_value EZ_RUNNER_SOCKET_DIR)"
  runner_token_file="$(effective_env_value EZ_RUNNER_TOKEN_FILE)"
  runner_group="$(effective_env_value EZ_RUNNER_GROUP)"
  case "$runner_group" in
    '' | *[!0-9]*)
      runner_configuration_error="EZ_RUNNER_GROUP must be the numeric group mapped from the live runner socket"
      return 1
      ;;
  esac
  if ! runner_group_matches_socket "$runner_socket_dir/runner.sock" "$runner_group"; then
    runner_configuration_error="EZ_RUNNER_GROUP does not match the live runner socket's rootless Podman group mapping"
    return 1
  fi
  if ! runner_credential_usable "$runner_token_file"; then
    runner_configuration_error="EZ_RUNNER_TOKEN_FILE is not a production-valid runner credential"
    return 1
  fi
  if ! runner_socket_usable "$runner_socket_dir/runner.sock"; then
    runner_configuration_error="the runner socket did not accept EZ_RUNNER_TOKEN_FILE on the canonical authenticated endpoint"
    return 1
  fi
}

runner_group_matches_socket() {
  local runner_socket="$1"
  local configured_group="$2"
  local runner_socket_dir mapped_group
  [ -S "$runner_socket" ] || return 1
  runner_socket_dir="$(dirname "$runner_socket")"
  mapped_group="$(EZ_RUNNER_SOCKET_DIR="$runner_socket_dir" \
    "$BASH" "$REPO_ROOT/scripts/resolve-runner-group.sh" --podman 2>/dev/null)" || return 1
  [ "$configured_group" = "$mapped_group" ]
}

runner_socket_usable() {
  local runner_socket="$1"
  local runner_status runner_probe_body
  [ -S "$runner_socket" ] || return 1
  [ -n "$validated_runner_token" ] || return 1
  command -v mktemp >/dev/null 2>&1 || return 1
  runner_header_tmp="$(umask 077 && mktemp "${ENV_FILE}.runner-header.XXXXXX")" || return 1
  runner_probe_tmp="$(umask 077 && mktemp "${ENV_FILE}.runner-probe.XXXXXX")" || return 1
  printf 'Authorization: Bearer %s\n' "$validated_runner_token" >"$runner_header_tmp" || return 1
  runner_status="$(curl -sS -o "$runner_probe_tmp" -w '%{http_code}' --max-time 2 --noproxy '*' \
    --unix-socket "$runner_socket" -H "@$runner_header_tmp" -H 'content-type: application/json' \
    --data-binary '{"id":"setup-podman-probe"}' http://localhost/v4/inspect 2>/dev/null)" || {
    rm -f "$runner_header_tmp" "$runner_probe_tmp"
    runner_header_tmp=""
    runner_probe_tmp=""
    return 1
  }
  runner_probe_body="$(cat "$runner_probe_tmp")" || return 1
  rm -f "$runner_header_tmp" "$runner_probe_tmp"
  runner_header_tmp=""
  runner_probe_tmp=""
  [ "$runner_status" = 200 ] &&
    [ "$runner_probe_body" = '{"id":"setup-podman-probe","state":"unknown","diagnostics":[]}' ]
}

# Mirror src/extensions/runner-connection.ts without sourcing the credential or
# exposing it in a child argv/log: absolute regular non-symlink, at most 4096
# bytes, no group/other write bits, and a trimmed token of at least 32
# whitespace/control-free ASCII characters. Production accepts a wider Unicode
# set, but setup deliberately provisions the portable credential subset whose
# byte and character counts are identical across Linux and macOS locales.
runner_credential_usable() {
  local runner_token_file="$1"
  local runner_token_mode runner_token_size runner_token_value
  case "$runner_token_file" in /*) ;; *) return 1 ;; esac
  [ -f "$runner_token_file" ] && [ ! -L "$runner_token_file" ] || return 1
  runner_token_mode="$(portable_stat_value %a %Lp "$runner_token_file")" || return 1
  case "$runner_token_mode" in
    *[2367][0-7] | *[0-7][2367]) return 1 ;;
  esac
  runner_token_size="$(portable_stat_value %s %z "$runner_token_file")" || return 1
  case "$runner_token_size" in '' | *[!0-9]*) return 1 ;; esac
  [ "$runner_token_size" -le 4096 ] || return 1
  # Bash variables cannot retain NUL bytes. Compare the file to a NUL-stripped
  # stream before reading it so one cannot disappear and make an invalid token
  # look valid. Neither command prints the credential.
  # shellcheck disable=SC2094 # cmp only reads the file; no command writes it.
  LC_ALL=C tr -d '\000' <"$runner_token_file" | cmp -s - "$runner_token_file" || return 1
  runner_token_value="$(cat "$runner_token_file")" || return 1
  runner_token_value="$(trim_env_whitespace "$runner_token_value")"
  [ "${#runner_token_value}" -ge 32 ] || return 1
  (LC_ALL=C; export LC_ALL; case "$runner_token_value" in *[!\ -~]*) exit 1 ;; esac) || return 1
  case "$runner_token_value" in *[[:space:][:cntrl:]]*) return 1 ;; esac
  validated_runner_token="$runner_token_value"
}

validate_existing_env() {
  # GNU and BSD spell stat differently. Accept only modes with no group/other
  # bits. 0400 and 0600 are both private.
  env_mode="$(portable_stat_value %a %Lp "$ENV_FILE")" ||
    die "could not inspect permissions for $ENV_FILE"
  case "$env_mode" in
    [0-7]00 | 0[0-7]00) ;;
    *) die "$ENV_FILE has unsafe permissions ($env_mode); run: chmod 600 $ENV_FILE" ;;
  esac
  resolve_compose_environment "$ENV_FILE"
  validate_required_values
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
  if runner_configured; then
    ok "runner already configured — environment file left byte-for-byte unchanged"
    return 0
  fi
  [ -z "$runner_configuration_error" ] || printf 'error: %s\n' "$runner_configuration_error" >&2
  print_manual_runner_action existing
  exit 2
}

generate_secret() {
  printf '%s=' "$1"
  openssl rand -base64 "$2"
}

build_fresh_candidate() {
  local candidate_kind="${1:-real}"
  [ -f "$ENV_EXAMPLE" ] || die "$ENV_EXAMPLE is missing"
  command -v mktemp >/dev/null 2>&1 || die "mktemp is required to create $ENV_FILE safely"
  command -v link >/dev/null 2>&1 || die "the POSIX link utility is required to publish $ENV_FILE safely"
  env_tmp="$(umask 077 && mktemp "${ENV_FILE}.tmp.XXXXXX")" || die "could not create a private temporary environment file"
  secret_tmp="$(umask 077 && mktemp "${ENV_FILE}.secrets.XXXXXX")" || die "could not create a private secret file"
  if [ "$candidate_kind" = real ]; then
    command -v openssl >/dev/null 2>&1 || die "openssl is required to generate secrets"
    {
      generate_secret EZCORP_ENCRYPTION_SECRET 32
      generate_secret EZCORP_ENCRYPTION_SALT 16
      generate_secret EZCORP_JWT_SECRET 32
    } >"$secret_tmp"
  else
    # Dry-run values exercise the exact substitution and Compose-resolution
    # path without generating credentials or placing a real secret anywhere.
    {
      printf '%s\n' 'EZCORP_ENCRYPTION_SECRET=check-only-encryption-secret-0001'
      printf '%s\n' 'EZCORP_ENCRYPTION_SALT=check-only-salt-01'
      printf '%s\n' 'EZCORP_JWT_SECRET=check-only-session-secret-000001'
    } >"$secret_tmp"
  fi
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

existing_env_is_regular() {
  if [ -L "$ENV_FILE" ]; then
    die "$ENV_FILE must be a regular file, not a symbolic link"
  fi
  if [ -e "$ENV_FILE" ]; then
    [ -f "$ENV_FILE" ] || die "$ENV_FILE exists but is not a regular file"
    return 0
  fi
  return 1
}

publish_fresh_candidate() {
  local candidate="$1"
  local candidate_parent candidate_name candidate_absolute
  local target_parent target_name target_parent_absolute target_absolute
  candidate_parent="$(dirname "$candidate")"
  candidate_name="$(basename "$candidate")"
  candidate_parent="$(cd "$candidate_parent" && pwd -P)" || die "could not resolve the candidate directory"
  candidate_absolute="$candidate_parent/$candidate_name"
  target_parent="$(dirname "$ENV_FILE")"
  target_name="$(basename "$ENV_FILE")"
  target_parent_absolute="$(cd "$target_parent" && pwd -P)" || die "could not resolve the environment-file directory"
  target_absolute="$target_parent_absolute/$target_name"

  # Unlike `ln SOURCE TARGET`, POSIX `link SOURCE TARGET` never treats an
  # existing TARGET directory as a destination directory. It calls link(2) on
  # this exact basename and therefore fails without creating a nested secret.
  if (cd "$target_parent_absolute" && link "$candidate_absolute" "./$target_name" 2>/dev/null); then
    [ -f "$target_absolute" ] && [ ! -L "$target_absolute" ] &&
      [ "$candidate_absolute" -ef "$target_absolute" ] ||
      die "could not verify the exact published environment file"
    return 0
  fi
  return 1
}

say "environment file ($ENV_FILE)"
if existing_env_is_regular; then
  validate_existing_env
  say "extension runner"
  ensure_existing_runner
elif [ "$CHECK_ONLY" = 1 ]; then
  build_fresh_candidate check
  todo "would create one complete mode-600 file from $ENV_EXAMPLE with generated secrets"
  say "extension runner"
  if [ "$ACCEPT_UNSANDBOXED" = 1 ]; then
    append_trusted_local "$env_tmp"
    todo "would add trusted-local to the private candidate after explicit acceptance"
  elif [ "$OS" = "Darwin" ]; then
    todo "blocked until trusted-local risk is accepted; no environment file or stack would be created"
    exit 2
  else
    todo "not configured; on Linux select an isolated runner or explicitly accept trusted-local"
    exit 2
  fi
  resolve_compose_environment "$env_tmp"
  validate_required_values
  runner_configured || die "the private environment candidate has no usable extension runner"
else
  build_fresh_candidate real
  say "extension runner"
  select_fresh_runner "$env_tmp"
  resolve_compose_environment "$env_tmp"
  validate_required_values
  runner_configured || die "the private environment candidate has no usable extension runner"
  if publish_fresh_candidate "$env_tmp"; then
    rm -f "$env_tmp"
    env_tmp=""
    ok "published one complete mode-600 environment file with fresh secrets and trusted-local"
  elif existing_env_is_regular; then
    rm -f "$env_tmp"
    env_tmp=""
    todo "another process created $ENV_FILE; validating that file from the beginning"
    validate_existing_env
    ensure_existing_runner
  else
    die "could not install $ENV_FILE without replacing an existing file"
  fi
fi

# Validate every non-mutating start precondition before --check can report
# success or a real run creates bind-mount directories.
validate_readiness_configuration() {
  if [ -z "$READY_URL" ]; then
    ready_port="$(effective_env_value EZCORP_PORT_HOST)"
    [ -n "$ready_port" ] || ready_port=4000
    case "$ready_port" in
      *[!0-9]*) die "EZCORP_PORT_HOST must be a whole-number port so setup can check readiness" ;;
    esac
    [ "$ready_port" -gt 0 ] && [ "$ready_port" -le 65535 ] ||
      die "EZCORP_PORT_HOST must be between 1 and 65535"
    READY_URL="http://localhost:${ready_port}/api/ready"
  elif ! valid_readiness_url "$READY_URL"; then
    die "EZ_SETUP_READY_URL must be a valid http:// or https:// endpoint without credentials or control characters"
  fi
  case "$READY_TIMEOUT" in
    '' | *[!0-9]*) die "EZ_SETUP_READY_TIMEOUT must be a positive whole number of seconds" ;;
  esac
  [ "$READY_TIMEOUT" -gt 0 ] || die "EZ_SETUP_READY_TIMEOUT must be greater than zero"
  admin_url="$(effective_env_value EZCORP_PUBLIC_URL)"
  [ -n "$admin_url" ] || admin_url="${READY_URL%/api/ready}"
}
if [ "$CHECK_ONLY" = 1 ] || [ "$NO_START" != 1 ]; then
  validate_readiness_configuration
fi

# ── 3. Bind-mount sources ──────────────────────────────────────────────────
say "bind-mount directories under $DATA_ROOT"
if [ -L "$DATA_ROOT" ]; then
  die "$DATA_ROOT must be a real directory, not a symbolic link"
elif [ -e "$DATA_ROOT" ] && [ ! -d "$DATA_ROOT" ]; then
  die "$DATA_ROOT exists but is not a directory"
fi
for d in data extensions extension-data projects; do
  if [ -L "$DATA_ROOT/$d" ]; then
    die "$DATA_ROOT/$d must be a real directory, not a symbolic link"
  elif [ -d "$DATA_ROOT/$d" ]; then
    ok "$DATA_ROOT/$d"
  elif [ -e "$DATA_ROOT/$d" ]; then
    die "$DATA_ROOT/$d exists but is not a directory"
  else
    do_or_report mkdir -p "$DATA_ROOT/$d"
    if [ "$CHECK_ONLY" != 1 ]; then
      [ ! -L "$DATA_ROOT" ] && [ -d "$DATA_ROOT" ] &&
        [ ! -L "$DATA_ROOT/$d" ] && [ -d "$DATA_ROOT/$d" ] ||
        die "$DATA_ROOT/$d was replaced while setup created it"
    fi
  fi
done

# ── 5. Up ──────────────────────────────────────────────────────────────────
say "stack"
if [ "$CHECK_ONLY" = 1 ]; then
  todo "would run: bash scripts/podman-compose.sh --prod up -d --build"
  exit 0
fi
if [ "$NO_START" = 1 ]; then
  todo "start skipped (--no-start)"
  exit 0
fi

PODMAN_SOCKET="${PODMAN_SOCKET:-${SOCKET:-}}" EZ_COMPOSE_ENV_FILE="$ENV_FILE" bash scripts/podman-compose.sh --prod up -d --build
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
