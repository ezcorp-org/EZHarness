#!/usr/bin/env bash
# kind-proof-podrecord.test.sh [driver]: the driver's own record_failed_pods (extracted, never restated) on a recorded
# `kubectl get pods -A -o json` shape (synthetic now, hash asserted; replaced by run 10's recorded JSON afterwards), with a stub
# kubectl binary that the driver's KUBECTL names. Pass: only the factory's own pods (label app.kubernetes.io/part-of=ezcorp-factory,
# in the fleet and installation namespaces) that are not Succeeded and not Running with every container ready are recorded:
# describe and logs (all containers) for each, previous logs PER CONTAINER (-c) only for a container that terminated before, the events of each
# of their namespaces once; never a Ready or Succeeded pod, never a pod outside the factory; every record file written; stub hit.
# The TOTAL stub call count is asserted (validator-8 R2), so any other kubectl call (a secret get, an exec) turns it red.
set -uo pipefail
DRIVER=${1:-evidence/w4h-35/repro/kind-proof.sh}
FIX=evidence/w4h-35/repro/fixtures/synthetic/install-pods.json
[ "$(sha256sum "$FIX" | cut -d' ' -f1)" = dbefec6eba0da59fad69cbce868ff372dc9efc03b16c0bb374dc505065f4c44c ] || { echo "FAIL: fixture hash"; exit 1; }
T=$(mktemp -d evidence/w4h-35/repro/.podrecordtest.XXXX)
awk '/^select_pods\(\) \{/,/^\}/; /^pod_records\(\) \{/,/^\}/; /^record_failed_pods\(\) \{/,/^\}/' "$DRIVER" > "$T/fn.sh"
[ -s "$T/fn.sh" ] || { echo "FAIL: record_failed_pods not found"; rm -r "$T"; exit 1; }
printf '#!/usr/bin/env bash\necho "kubectl $*" >> "%s/calls"\necho "stub output for $*"\n' "$T" > "$T/kubectl"; chmod 700 "$T/kubectl"
mkdir -p "$T/p"; cp "$FIX" "$T/p/install-pods.json"
T=$T bash -c 'P=$T/p; KUBECTL=$T/kubectl; KUBECONFIG_FILE=$T/kc; log() { echo "LOG $*" >> "$T/log"; }; . "$T/fn.sh"; record_failed_pods' > /dev/null 2>&1
c() { grep -c -- "$1" "$T/calls" 2>/dev/null; }
f=ezcorp-factory-w4h35; i=ezcorp-factory-w4h35-tenant-35
pool=factory-pool-7d9dc866b8-8chhg; sup=factory-supervisor-bvj8h; inst=installation-5f6d7c8b9-k3m2n
want="$f.$pool.describe.txt $f.$pool.logs.txt $f.$pool.deliver-secrets.previous.txt $f.$sup.describe.txt $f.$sup.logs.txt $i.$inst.describe.txt $i.$inst.logs.txt $f.events.txt $i.events.txt"
files=0; for x in $want; do [ -s "$T/p/pods/$x" ] && files=$((files + 1)); done
got="total=$(wc -l < "$T/calls" 2>/dev/null | tr -d ' ') describe=$(c ' describe pod ') logs=$(c ' --all-containers=true$') previous=$(c ' -c deliver-secrets --previous') all-prev=$(c 'all-containers=true --previous') events=$(c ' get events ') ready=$(c 'factory-ingress') succeeded=$(c 'migrate-once') outside=$(c 'coredns') foreign=$(c 'other-team') files=$files selected=$(tr '\n' ';' < "$T/p/pods/selected.txt" 2>/dev/null)"
rm -r "$T"
echo "$got"
[ "$got" = "total=9 describe=3 logs=3 previous=1 all-prev=0 events=2 ready=0 succeeded=0 outside=0 foreign=0 files=9 selected=$f $pool deliver-secrets;$f $sup -;$i $inst -;" ] && { echo PASS; exit 0; }
echo FAIL; exit 1
