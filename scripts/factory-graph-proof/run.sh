#!/usr/bin/env bash
# The W19a graph proof on the real started application.
#
#   scripts/factory-graph-proof/run.sh all
#       builds the web server once, then runs three passes in mode `ollama`,
#       three in mode `mock`, the two negative-control passes, and the summary.
#   scripts/factory-graph-proof/run.sh pass <ollama|mock> <none|no-pin|missing-model> <label>
#       one pass against the current build.
#   scripts/factory-graph-proof/run.sh hold <deployment-dir> <label> [minutes]
#       start ONE persistent deployment (folder under /run/user/<uid>/; see deployment.ts),
#       pinned to the reference model, print its URL, and stop it on SIGTERM or after at most
#       30 minutes. The deployment's database and key files stay for the next start.
#   scripts/factory-graph-proof/run.sh probe <deployment-dir> <evidence.json>
#       the reference code provider probe against that deployment (W10c sign-in check).
#
# Every pass boots a fresh installation on fresh pool and product databases,
# runs the graph through public HTTP, and writes <label>.json into W19A_OUT.
# A pass that fails keeps its product database for inspection and says so.
#
# Environment (read, never printed):
#   W19A_OUT                          records directory (default /tmp/factory-platform-evidence/w19a/proof)
#   EZCORP_FACTORY_STORAGE_SECRETS_DIR the shared S3 credential directory (a tmpfs path; never hard-coded)
#   /tmp/factory-platform-evidence/postgres.env   POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB
#
# Run it under the shared heavy lock, with the timeout inside the lock:
#   flock --close /tmp/ezcorp-validation-heavy.lock timeout 5400 scripts/factory-graph-proof/run.sh all
set -uo pipefail
# The mock mode opens the test surface, which also requires NODE_ENV not to be
# "production"; other code paths change under "test", so it is left unset.
unset NODE_ENV
REPO=$(cd "$(dirname "$0")/../.." && pwd)
. "$REPO/scripts/lib/pinned-bun.sh"
use_pinned_bun || exit 4
export W19A_REPO=$REPO
export W19A_OUT=${W19A_OUT:-/tmp/factory-platform-evidence/w19a/proof}
mkdir -p "$W19A_OUT"

if [ -z "${EZCORP_FACTORY_STORAGE_SECRETS_DIR:-}" ] || [ ! -d "$EZCORP_FACTORY_STORAGE_SECRETS_DIR" ]; then
  echo "EZCORP_FACTORY_STORAGE_SECRETS_DIR is unset or not a directory; refusing to run" >&2
  exit 2
fi
# The PostgreSQL URL is assembled here and exported, never placed in argv.
set -a; . /tmp/factory-platform-evidence/postgres.env; set +a
PGPORT=$(podman port factory-platform-proof-postgres 5432 | head -1 | sed 's/.*://')
export FACTORY_TEST_POSTGRES_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${PGPORT}/${POSTGRES_DB}"
unset POSTGRES_PASSWORD

one_pass() {
  local mode=$1 control=$2 label=$3
  rm -f "$W19A_OUT/$label.json"
  W19A_MODE=$mode W19A_CONTROL=$control W19A_LABEL=$label timeout 900 bun "$REPO/scripts/factory-graph-proof/proof.ts" > "$W19A_OUT/$label.log" 2>&1
  local code=$?
  tail -1 "$W19A_OUT/$label.log"
  [ -f "$W19A_OUT/$label.json" ] || echo "{\"label\":\"$label\",\"outcome\":\"no-record\",\"exitCode\":$code}" > "$W19A_OUT/$label.json"
  return $code
}

case "${1:-}" in
  pass)
    one_pass "$2" "$3" "$4"
    ;;
  hold)
    [ -n "${2:-}" ] && [ -n "${3:-}" ] || { echo "usage: run.sh hold <deployment-dir> <label> [minutes]" >&2; exit 2; }
    W19A_DEPLOYMENT_DIR=$2 W19A_LABEL=$3 W19A_HOLD_MINUTES=${4:-30} timeout 2400 bun "$REPO/scripts/factory-graph-proof/hold.ts"
    ;;
  probe)
    [ -n "${2:-}" ] || { echo "usage: run.sh probe <deployment-dir> <evidence.json>" >&2; exit 2; }
    W19A_DEPLOYMENT_DIR=$2 bun "$REPO/scripts/factory-graph-proof/deployment-probe.ts" "${3:-}"
    ;;
  all)
    # The server runs its built output, so it is rebuilt from this tree first.
    bun run --cwd "$REPO/web" build > "$W19A_OUT/web-build.log" 2>&1 || { echo "web build failed; see $W19A_OUT/web-build.log" >&2; exit 1; }
    status=0
    for mode in ollama mock; do
      for pass in 1 2 3; do one_pass "$mode" none "$mode-$pass" || status=1; done
    done
    one_pass mock no-pin control-no-pin || status=1
    one_pass ollama missing-model control-missing-model || status=1
    # Fails on purpose; what it leaves behind is the control.
    one_pass mock forced-failure control-forced-failure
    bun "$REPO/scripts/factory-graph-proof/verify-diagnostics.ts" "$W19A_OUT" control-forced-failure || status=1
    bun "$REPO/scripts/factory-graph-proof/summarize.ts" "$W19A_OUT" || status=1
    # The guest images are built per pass; remove the untagged layers they leave.
    podman image prune -f > "$W19A_OUT/image-prune.log" 2>&1
    exit $status
    ;;
  *)
    sed -n '2,20p' "$0" >&2
    exit 2
    ;;
esac
