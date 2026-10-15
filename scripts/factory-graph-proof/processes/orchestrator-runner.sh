#!/usr/bin/env bash
# The Node orchestrator under the restart loop a deployment gives a daemon.
# Its readiness requires the product's private service and it exits when that
# peer goes away, so a process supervisor brings it back. The loop ends when
# the process group is signalled. Ported from the W09b real-server harness.
# Env: W19A_REPO, W19A_ORCHESTRATOR_CONFIG.
set -u
trap 'exit 0' TERM INT
while true; do
  node "$W19A_REPO/src/factory/orchestration-process.ts" "$W19A_ORCHESTRATOR_CONFIG"
  echo "[orchestrator-runner] the orchestrator exited; restarting in 2s"
  sleep 2
done
