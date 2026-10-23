#!/usr/bin/env bash
# locked-g10.sh (gated-flock only; G10 as approved): the mock_pass form. Web build, then ONE W19a graph pass in mode mock
# (the test provider; no real model) on the cpu-only resource profile. The stack drops its databases on a passing stop; a failed
# pass keeps its product database by design, named in the record (retainedProductDatabase), for inspection and a named drop.
# The verdict is read from the run record, not from a log line.
set -uo pipefail
E=evidence/w4h-35; W=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35; D=$E/g10; mkdir -p "$D"; S=$D/legs.log
. evidence/w00/lock-veto.sh; lock_veto integrator-2
. evidence/w00/resource-gate.sh; RESOURCE_GATE_MAX_WAIT_S=0
resource_gate w4h35-g10 "$S" || { echo "release: gate red" >> "$S"; exit 75; }
. evidence/w00/bun-pin.sh; bun_pin "$W" > /dev/null
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE; cd "$W" || exit 1
EZCORP_FACTORY_STORAGE_SECRETS_DIR=$(ls -d /run/user/$(id -u)/ezcorp-factory-storage.* | head -1); export EZCORP_FACTORY_STORAGE_SECRETS_DIR
echo "head $(git rev-parse --short HEAD) $(date -u +%FT%TZ)" >> "$S"
bun run --cwd web build > "$D/web-build.log" 2>&1; rc=$?; echo "web-build exit $rc" >> "$S"; [ "$rc" = 0 ] || exit "$rc"
# The orchestrator reads its workflow bundle from dist/ (deploy/factory/Dockerfile builds it after build:packages);
# the worktree build does not, so the leg builds it from this head and checks it before any stack starts (G10 try 2).
bun run --cwd packages/@ezcorp/factory-orchestrator build:workflow-bundle > "$D/workflow-bundle.log" 2>&1; rc=$?; echo "workflow-bundle exit $rc" >> "$S"; [ "$rc" = 0 ] || exit "$rc"
bash "$E/bin/check-workflow-bundle.sh" >> "$S" 2>&1 || exit 66
W19A_OUT="$D" scripts/factory-graph-proof/run.sh pass mock none w4h35-cpu-only > "$D/pass.log" 2>&1; rc=$?; echo "graph-mock-pass exit $rc $(date -u +%FT%TZ)" >> "$S"
python3 - "$D/w4h35-cpu-only.json" > "$D/verdict.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
nodes = (r.get("evidence") or {}).get("nodes") or {}
def ops(n): return [o for o in (n.get("operations") or []) if o.get("kind") == "model"]
model_ops = {k: {"model": v.get("model"), "operations": [{"state": o.get("state"), "usage": o.get("usage")} for o in ops(v)]} for k, v in nodes.items()}
usage = [o.get("usage") for v in nodes.values() for o in ops(v)]
costs = [u.get("costMicros") or u.get("cost") for u in usage if isinstance(u, dict)]
print(json.dumps({"outcome": r.get("outcome"), "mode": r.get("mode"), "installationModelProvider": r.get("installationModelProvider"), "pin": r.get("pin"), "resourceProfile": r.get("resourceProfile"), "modelOperationsByNode": model_ops, "modelUsageRows": usage, "modelUsageCosts": costs, "failure": r.get("failure"), "retainedProductDatabase": r.get("retainedProductDatabase")}, indent=2))
PY
echo "verdict $(tr -d '\n ' < "$D/verdict.json" | cut -c1-400)" >> "$S"
exit "$rc"
