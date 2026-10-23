#!/usr/bin/env bash
# check-workflow-bundle.sh: the orchestrator's workflow bundle record exists and names a readable bundle (G10 prerequisite).
B=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35/packages/@ezcorp/factory-orchestrator/dist/factory-workflow.bundle.json
[ -r "$B" ] || { echo "workflow-bundle MISSING $B"; exit 66; }
python3 -I -c 'import json,sys,os; r=json.load(open(sys.argv[1])); print("workflow-bundle ok", {k: r[k] for k in list(r)[:4]})' "$B"
