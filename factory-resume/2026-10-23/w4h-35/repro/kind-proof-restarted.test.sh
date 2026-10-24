#!/usr/bin/env bash
# kind-proof-restarted.test.sh [driver]: L3. The driver's own select_pods, pod_records and record_restarted_pods (extracted, never
# restated) on the REAL run-13 install-pods.json (fixtures/run13, a copy of proof/install-pods.json 706514e464ebbeff), with a stub
# kubectl (asserted hit). Pass: exactly the installation pod is selected, with previous = orchestrator (restartCount 2; no other factory
# container restarted; kube-system pods are never touched), and `kubectl logs <pod> -c orchestrator --previous` is called and kept in
# pods-restarted/<ns>.<pod>.orchestrator.previous.txt, beside describe and logs.
set -uo pipefail
DRIVER=${1:-evidence/w4h-35/repro/kind-proof.sh}
FIX=evidence/w4h-35/repro/fixtures/run13/install-pods.json
T=$(mktemp -d evidence/w4h-35/repro/.restartedtest.XXXX)
awk '/^select_pods\(\) \{/,/^\}/; /^pod_records\(\) \{/,/^\}/; /^record_restarted_pods\(\) \{/,/^\}/' "$DRIVER" > "$T/fn.sh"
grep -q '^record_restarted_pods() {' "$T/fn.sh" || { echo "FAIL: record_restarted_pods not found"; rm -r "$T"; exit 1; }
printf '#!/usr/bin/env bash\necho "kubectl $*" >> "%s/calls"\necho "stub output for $*"\n' "$T" > "$T/kubectl"; chmod 700 "$T/kubectl"
mkdir -p "$T/P"; cp "$FIX" "$T/P/install-pods.json"
T=$T bash -c 'KUBECTL=$T/kubectl; KUBECONFIG_FILE=$T/kc; P=$T/P; log() { echo "$*" >> "$T/log"; }; . "$T/fn.sh"; record_restarted_pods' > /dev/null 2>&1
d=$T/P/pods-restarted; pod=installation-756bcfbd7c-t94hz; ns=ezcorp-factory-w4h35-tenant-35
got="selected=[$(tr '\n' ';' < "$d/selected.txt")] prev=$(grep -c -- "-n $ns logs $pod -c orchestrator --previous" "$T/calls") file=$([ -s "$d/$ns.$pod.orchestrator.previous.txt" ] && echo yes || echo no) describe=$([ -s "$d/$ns.$pod.describe.txt" ] && echo yes || echo no) kube_system=$(grep -c 'kube-system' "$T/calls") calls=$(wc -l < "$T/calls" | tr -d ' ') logline=$(grep -c 'recorded 1 pod(s) with a restarted container' "$T/log")"
rm -r "$T"
echo "$got"
[ "$got" = "selected=[$ns $pod orchestrator;] prev=1 file=yes describe=yes kube_system=0 calls=3 logline=1" ] && { echo PASS; exit 0; }
echo FAIL; exit 1
