#!/usr/bin/env bash
# fullpath-judge.test.sh (team-lead ruling P2 and v3, validator-8 R2): run 13 expects the FULL path. The judge passes only when
# proof.exit is 0, proof/proof.log has no G8 record and holds the stopped-wave marks and "wave: exit 0", install-status.json shows all
# seven C12 steps complete (step 6 ingress and step 7 invitation included), and the stopped-wave case stopped: wave.json state
# "stopped", the canary tenant-35 rolled back, a failure named. Anything else is RED.
set -u
J=evidence/w4h-35/bin/fullpath-judge.py
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; fail=0; n=0
check() { n=$((n + 1)); python3 -I "$J" "$T/p" "$T/proof.exit" > "$T/out" 2>&1; local got=$?; [ "$got" = "$1" ] || { echo "FAIL: $2: want $1 got $got"; cat "$T/out"; fail=1; }; }
steps() { python3 -I -c 'import json,sys; names = ["database", "storage", "temporal", "secrets", "deployment", "ingress", "invitation"]; states = dict(zip(names, ["complete"] * 7)); states.update(dict(a.split("=") for a in sys.argv[2:])); json.dump({"status": {"phase": "ready", "steps": [{"step": k, "state": v} for k, v in states.items()]}}, open(sys.argv[1], "w"))' "$T/p/install-status.json" "$@"; }
wave() { printf '%s' "$1" > "$T/p/wave.json"; }
good() { rm -rf "$T/p"; mkdir -p "$T/p"; echo 0 > "$T/proof.exit"
  printf '%s\n' "[x] install: provision exit 0; phase ready" "[x] step stopped-wave start mem=15.0GiB" "[x] wave: exit 0; {}" "[x] step stopped-wave end mem=15.0GiB" > "$T/p/proof.log"; steps
  wave '{"wave": {"waveId": "w1", "state": "stopped", "upgraded": [], "rolledBack": ["tenant-35"], "untouched": [], "skipped": [], "failure": {"code": "image_unavailable"}}}'; }
good; check 0 "the full path"
good; echo "[x] G8 steps 1 to 5 proven; steps 6 and 7 not proven on this host" >> "$T/p/proof.log"; check 1 "a G8 record"
good; steps ingress=failed; check 1 "step 6 (ingress) failed"
good; steps invitation=pending; check 1 "step 7 (invitation) not complete"
good; wave '{"wave": {"waveId": "w1", "state": "completed", "upgraded": ["tenant-35"], "rolledBack": [], "untouched": [], "skipped": [], "failure": null}}'; check 1 "the wave completed (the absent image did not stop it)"
good; wave '{"wave": {"waveId": "w1", "state": "stopped", "upgraded": [], "rolledBack": [], "untouched": [], "skipped": [], "failure": {"code": "x"}}}'; check 1 "stopped without rolling the canary back"
good; rm "$T/p/wave.json"; check 1 "no wave record (the wave did not run)"
good; rm "$T/p/install-status.json"; check 1 "no install status"
good; echo 79 > "$T/proof.exit"; check 1 "proof.exit is not 0"
good; rm "$T/proof.exit"; check 1 "no proof.exit"
good; sed -i 's/wave: exit 0/wave: exit 1/' "$T/p/proof.log"; check 1 "the wave command exit is not 0"
good; sed -i '/step stopped-wave end/d' "$T/p/proof.log"; check 1 "no stopped-wave end mark"
[ "$fail" = 0 ] && echo "fullpath-judge.test.sh: $n of $n pass"
exit "$fail"
