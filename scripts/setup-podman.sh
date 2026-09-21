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
#   2. Env.      .env.prod is created from the example with real secrets and a
#                localhost URL. Existing values and secrets are never replaced.
#                The only later update this script can make is an atomic append
#                of the trusted-local choice after explicit acceptance.
#   3. Dirs.     The four ./.ezcorp bind sources are pre-created. Plain mkdir:
#                under rootless Podman the README's `chown -R 1000:1000` is
#                not merely unnecessary, it locks the operator out of their
#                own tree (compose.podman-prod.yml explains the mapping).
#   4. Runner.   The extension-runner mode — see the long note below.
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
# On Linux nothing is decided for you. If .env.prod already names a
# provisioned runner (EZ_RUNNER_SOCKET_DIR) the isolated mode is kept. If it
# names nothing, you are shown both paths and the script stops — silently
# downgrading a Linux host to unsandboxed extensions would be exactly the
# kind of "helpful" default the acknowledgement exists to prevent.
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
READY_URL="${EZ_SETUP_READY_URL:-http://localhost:4000/api/ready}"
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

# Every temporary artifact is a sibling of the destination, so the final
# rename stays on one filesystem and is atomic on both BSD and GNU hosts.
# The lock serializes concurrent setup processes. It is intentionally a plain
# mkdir/rmdir lock: both operations and every utility below ship on macOS.
env_tmp=""
trusted_tmp=""
env_lock=""
# shellcheck disable=SC2329 # Invoked indirectly by the EXIT trap below.
cleanup_setup_artifacts() {
  [ -z "$env_tmp" ] || rm -f "$env_tmp"
  [ -z "$trusted_tmp" ] || rm -f "$trusted_tmp"
  [ -z "$env_lock" ] || rmdir "$env_lock" 2>/dev/null || true
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

# ── 1. Engine ──────────────────────────────────────────────────────────────
say "container engine"
case "$OS" in
  Darwin)
    command -v brew >/dev/null 2>&1 || die "Homebrew is required on macOS: https://brew.sh"
    for pkg in podman docker-compose; do
      if command -v "$pkg" >/dev/null 2>&1; then
        ok "$pkg installed"
      else
        do_or_report brew install "$pkg"
      fi
    done
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
    fi
    ;;
  Linux)
    command -v podman >/dev/null 2>&1 || die "podman is required: install it from your distro, then re-run"
    # Match podman-compose.sh: a `docker` executable is not proof that its
    # optional Compose plugin exists. Probe the subcommand before accepting it.
    if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
      ok "docker compose installed"
    elif command -v docker-compose >/dev/null 2>&1 && docker-compose version >/dev/null 2>&1; then
      ok "docker-compose installed"
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

# ── 2. Env file ────────────────────────────────────────────────────────────
say "environment file ($ENV_FILE)"
if [ -f "$ENV_FILE" ]; then
  # GNU and BSD spell stat differently. Try both, then accept only modes with
  # no group/other bits. 0400 and 0600 are both private; the trusted-local
  # atomic rewrite publishes mode 0600 so the operator can edit it afterward.
  env_mode="$(stat -c %a "$ENV_FILE" 2>/dev/null || stat -f %Lp "$ENV_FILE" 2>/dev/null)" ||
    die "could not inspect permissions for $ENV_FILE"
  case "$env_mode" in
    [0-7]00 | 0[0-7]00) ;;
    *) die "$ENV_FILE has unsafe permissions ($env_mode); run: chmod 600 $ENV_FILE" ;;
  esac
  ok "exists with private permissions — existing values will be preserved"
elif [ "$CHECK_ONLY" = 1 ]; then
  todo "would create from $ENV_EXAMPLE with generated secrets"
else
  [ -f "$ENV_EXAMPLE" ] || die "$ENV_EXAMPLE is missing"
  command -v openssl >/dev/null 2>&1 || die "openssl is required to generate secrets"
  command -v mktemp >/dev/null 2>&1 || die "mktemp is required to create $ENV_FILE safely"
  secret32="$(openssl rand -base64 32)"
  salt16="$(openssl rand -base64 16)"
  jwt32="$(openssl rand -base64 32)"
  # Build the complete file privately beside its destination. A hard link is
  # then an atomic, no-clobber install: concurrent setup runs cannot replace
  # one another, and an interruption cannot leave a partial final file.
  env_tmp="$(umask 077 && mktemp "${ENV_FILE}.tmp.XXXXXX")" || die "could not create a private temporary environment file"
  # `|` as the sed delimiter: base64 contains `/` and `+`, never `|`.
  sed \
    -e "s|^EZCORP_ENCRYPTION_SECRET=replace-with-openssl-rand-base64-32|EZCORP_ENCRYPTION_SECRET=$secret32|" \
    -e "s|^EZCORP_ENCRYPTION_SALT=replace-with-openssl-rand-base64-16|EZCORP_ENCRYPTION_SALT=$salt16|" \
    -e "s|^EZCORP_JWT_SECRET=replace-with-openssl-rand-base64-32|EZCORP_JWT_SECRET=$jwt32|" \
    -e "s|^EZCORP_PUBLIC_URL=https://ezcorp.example.com|EZCORP_PUBLIC_URL=http://localhost:4000|" \
    "$ENV_EXAMPLE" >"$env_tmp"
  chmod 600 "$env_tmp"
  # Prove each expected substitution happened. Merely checking that no
  # placeholder remains would accept an example that removed a line.
  if ! grep -Fqx "EZCORP_ENCRYPTION_SECRET=$secret32" "$env_tmp" ||
    ! grep -Fqx "EZCORP_ENCRYPTION_SALT=$salt16" "$env_tmp" ||
    ! grep -Fqx "EZCORP_JWT_SECRET=$jwt32" "$env_tmp" ||
    ! grep -Fqx "EZCORP_PUBLIC_URL=http://localhost:4000" "$env_tmp"; then
    die "placeholder substitution failed — $ENV_EXAMPLE changed shape; no $ENV_FILE was created"
  fi
  if ln "$env_tmp" "$ENV_FILE" 2>/dev/null; then
    rm -f "$env_tmp"
    env_tmp=""
    ok "created with fresh secrets, mode 600, EZCORP_PUBLIC_URL=http://localhost:4000"
  elif [ -f "$ENV_FILE" ]; then
    rm -f "$env_tmp"
    env_tmp=""
    ok "another setup created $ENV_FILE — left untouched"
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

# ── 4. Extension-runner mode ───────────────────────────────────────────────
say "extension runner"
# "Configured" means USABLE, not merely present. .env.prod.example ships the
# isolated runner's two host paths pre-filled and EZ_RUNNER_GROUP empty, so a
# fresh copy always contains EZ_RUNNER_SOCKET_DIR= — and compose.prod.yml's
# `${EZ_RUNNER_GROUP:?}` then aborts the deploy. Testing for the variable's
# presence skipped the decision on every fresh install; testing for all three
# values, or for the trusted-local override, does not.
env_value() { sed -n "s|^$1=||p" "$ENV_FILE" | tail -1; }
runner_configured() {
  [ -f "$ENV_FILE" ] || return 1
  if [ "$(env_value EZCORP_RUNNER_COMPOSE_FILE)" = "$TRUSTED_LOCAL_COMPOSE" ] &&
    [ "$(env_value "$ACK_VARIABLE")" = "$ACK_SENTENCE" ]; then
    return 0
  fi
  # The isolated bind-mounted socket works only on Linux. Treating these
  # values as usable on macOS skips the required trusted-local decision and
  # produces a stack that cannot reach its runner.
  [ "$OS" = "Linux" ] || return 1
  [ -n "$(env_value EZ_RUNNER_SOCKET_DIR)" ] &&
    [ -n "$(env_value EZ_RUNNER_TOKEN_FILE)" ] &&
    [ -n "$(env_value EZ_RUNNER_GROUP)" ]
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
write_trusted_local() {
  # Serialize setup processes before re-checking. A second process that was
  # already on its way here must observe the first process's complete update,
  # not append a duplicate block or replace it with an older snapshot.
  lock_path="${ENV_FILE}.setup.lock"
  lock_waited=0
  while ! mkdir "$lock_path" 2>/dev/null; do
    if runner_configured; then
      ok "trusted-local was configured by another setup process"
      return 0
    fi
    [ "$lock_waited" -lt 30 ] || die "timed out waiting for another setup process to update $ENV_FILE"
    sleep 1
    lock_waited=$((lock_waited + 1))
  done
  env_lock="$lock_path"

  if runner_configured; then
    rmdir "$env_lock"
    env_lock=""
    ok "trusted-local already configured in $ENV_FILE"
    return 0
  fi
  [ ! -L "$ENV_FILE" ] || die "cannot atomically update symbolic-link environment file $ENV_FILE; update its target manually"
  trusted_tmp="$(umask 077 && mktemp "${ENV_FILE}.trusted-local.XXXXXX")" ||
    die "could not create a private temporary environment file"
  {
    cat "$ENV_FILE"
    printf '\n# ─── Extension runner: trusted-local (written by scripts/setup-podman.sh) ──\n'
    printf '# No sandbox applies to extensions in this mode. See docs/macos-local-dev.md.\n'
    printf 'EZCORP_RUNNER_COMPOSE_FILE=%s\n' "$TRUSTED_LOCAL_COMPOSE"
    printf '%s=%s\n' "$ACK_VARIABLE" "$ACK_SENTENCE"
  } >"$trusted_tmp"
  chmod 600 "$trusted_tmp"
  mv -f "$trusted_tmp" "$ENV_FILE"
  trusted_tmp=""
  rmdir "$env_lock"
  env_lock=""
  ok "trusted-local selected in $ENV_FILE"
}

if runner_configured; then
  ok "already configured in $ENV_FILE — left as is"
elif [ "$CHECK_ONLY" = 1 ]; then
  if [ "$OS" = "Darwin" ]; then
    todo "not configured; on macOS this script would ask before selecting trusted-local"
  else
    todo "not configured; on Linux select an isolated runner or explicitly accept trusted-local"
  fi
elif [ "$OS" = "Darwin" ]; then
  if [ "$ACCEPT_UNSANDBOXED" = 1 ]; then
    write_trusted_local
  elif have_tty; then
    print_consequence
    printf '  Continue with unsandboxed extensions? [y/N] '
    read -r answer
    case "$answer" in
      y | Y | yes | YES) write_trusted_local ;;
      *) die "stopped at your request; trusted-local was not enabled" ;;
    esac
  else
    print_consequence
    die "not a terminal, so I cannot ask. Re-run with --accept-unsandboxed-extensions to answer yes."
  fi
else
  # Linux. Both paths work here; neither is chosen for you.
  cat <<EOF >&2

  $ENV_FILE names no extension runner, and compose.prod.yml requires one.
  Two options — pick one and re-run:

    A. Isolated runner (recommended on Linux). Provision it per
       deploy/extension-runner/README.md, then set EZ_RUNNER_SOCKET_DIR,
       EZ_RUNNER_TOKEN_FILE and EZ_RUNNER_GROUP in $ENV_FILE.

    B. trusted-local — extensions unsandboxed, with the app's full powers:
       bash scripts/setup-podman.sh --accept-unsandboxed-extensions

EOF
  if [ "$ACCEPT_UNSANDBOXED" = 1 ]; then
    write_trusted_local
  else
    exit 2
  fi
fi

# ── 5. Up ──────────────────────────────────────────────────────────────────
say "stack"
if [ "$CHECK_ONLY" = 1 ] || [ "$NO_START" = 1 ]; then
  todo "would run: bash scripts/podman-compose.sh --prod up -d --build"
  exit 0
fi
EZ_COMPOSE_ENV_FILE="$ENV_FILE" bash scripts/podman-compose.sh --prod up -d --build

say "waiting for $READY_URL (up to ${READY_TIMEOUT}s)"
case "$READY_TIMEOUT" in
  '' | *[!0-9]*) die "EZ_SETUP_READY_TIMEOUT must be a positive whole number of seconds" ;;
esac
[ "$READY_TIMEOUT" -gt 0 ] || die "EZ_SETUP_READY_TIMEOUT must be greater than zero"
now="$(date +%s)" || die "could not read the system clock"
deadline=$((now + READY_TIMEOUT))
while [ "$now" -lt "$deadline" ]; do
  remaining=$((deadline - now))
  curl_timeout=5
  [ "$remaining" -ge "$curl_timeout" ] || curl_timeout="$remaining"
  if body="$(curl -fsS --max-time "$curl_timeout" "$READY_URL" 2>/dev/null)" && [ -n "$body" ]; then
    ok "ready: $body"
    printf '\nOpen http://localhost:4000 and create the admin account.\n'
    exit 0
  fi
  now="$(date +%s)" || die "could not read the system clock"
  [ "$now" -lt "$deadline" ] || break
  remaining=$((deadline - now))
  sleep_for=5
  [ "$remaining" -ge "$sleep_for" ] || sleep_for="$remaining"
  sleep "$sleep_for"
  now="$(date +%s)" || die "could not read the system clock"
done
die "the app did not report ready within ${READY_TIMEOUT}s — see: bash scripts/podman-compose.sh --prod logs app"
