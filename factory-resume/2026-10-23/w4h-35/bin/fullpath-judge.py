#!/usr/bin/env python3
# fullpath-judge.py <proof dir> <proof.exit> (team-lead ruling P2 and v3, validator-8 R2, 2026-10-21): run 13 expects the FULL path,
# the kubelet pulling the one allowed nginx digest (bin/pull-judge.py requires it in the node once step 6 is complete). Exit 0 only
# when proof.exit is 0, proof.log has no G8 record and holds the stopped-wave marks and "wave: exit 0" (the driver's step_wave), and
# install-status.json shows all seven C12 steps complete
# (step 6 ingress and step 7 invitation included), and the stopped-wave case stopped: wave.json state "stopped" with the canary
# tenant-35 rolled back and a failure named (fleet-upgrade.ts:231). Exit 1 RED otherwise, by name.
import json, os, sys

STEPS = ("database", "storage", "temporal", "secrets", "deployment", "ingress", "invitation")
CANARY = "tenant-35"


def load(path):
    try:
        return json.load(open(path))
    except (OSError, ValueError):
        return None


def main(proof, exit_file):
    reds = []
    code = open(exit_file).read().strip() if os.path.isfile(exit_file) else "missing"
    if code != "0":
        reds.append(f"proof.exit is {code}, not 0")
    log = open(os.path.join(proof, "proof.log")).read() if os.path.isfile(os.path.join(proof, "proof.log")) else ""
    if "G8 steps 1 to 5 proven" in log:
        reds.append("a G8 record in proof.log")
    for line in ("step stopped-wave start", "wave: exit 0;", "step stopped-wave end"):
        if line not in log:
            reds.append(f'no "{line}" in proof.log')
    status = load(os.path.join(proof, "install-status.json"))
    states = {e.get("step"): e.get("state") for e in ((status or {}).get("status") or {}).get("steps") or []}
    not_complete = [f"{s}={states.get(s, 'missing')}" for s in STEPS if states.get(s) != "complete"]
    if status is None:
        reds.append("no install-status.json")
    elif not_complete:
        reds.append(f"C12 steps not complete: {', '.join(not_complete)}")
    wave = (load(os.path.join(proof, "wave.json")) or {}).get("wave")
    if not wave:
        reds.append("no wave record (wave.json)")
    elif not (wave.get("state") == "stopped" and CANARY in (wave.get("rolledBack") or []) and wave.get("failure")):
        reds.append(f"the stopped-wave case did not stop: state {wave.get('state')}, rolledBack {wave.get('rolledBack')}, failure {wave.get('failure')}")
    print(f"full-path judge: {'RED: ' + '; '.join(reds) if reds else 'PASS: all seven C12 steps complete, no G8 record, the wave stopped with ' + CANARY + ' rolled back'}")
    return 1 if reds else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
