#!/usr/bin/env bash
# kind-proof-previous.test.sh [driver]: the driver's own select_pods, pod_records and record_failed_pods (extracted, never
# restated) on run 10's REAL install-pods.json (a byte copy, hash asserted), with a stub kubectl binary first (asserted hit).
# Run 10 lost the main containers' previous logs: `logs --all-containers=true --previous` fails as a whole when one container
# (the Completed deliver-secrets init container) has no earlier instance. Pass: previous logs are asked PER CONTAINER (-c), only
# for the containers whose lastState is terminated (pool and supervisor, never deliver-secrets), each into its own file
# <ns>.<pod>.<container>.previous.txt; never --all-containers with --previous; the exact total of stub calls is 7.
set -uo pipefail
DRIVER=${1:-evidence/w4h-35/repro/kind-proof.sh}
FIX=evidence/w4h-35/repro/fixtures/run10/install-pods.json
[ "$(sha256sum "$FIX" | cut -d' ' -f1)" = e9a84adb3dd2c25ea7f6116114022cb45c21861909e1f65672391b34065edbb5 ] || { echo "FAIL: fixture is not run 10's record"; exit 1; }
T=$(mktemp -d evidence/w4h-35/repro/.previoustest.XXXX)
awk '/^select_pods\(\) \{/,/^\}/; /^pod_records\(\) \{/,/^\}/; /^record_failed_pods\(\) \{/,/^\}/' "$DRIVER" > "$T/fn.sh"
printf '#!/usr/bin/env bash\necho "kubectl $*" >> "%s/calls"\necho "stub output for $*"\n' "$T" > "$T/kubectl"; chmod 700 "$T/kubectl"
mkdir -p "$T/p"; cp "$FIX" "$T/p/install-pods.json"
T=$T bash -c 'P=$T/p; KUBECTL=$T/kubectl; KUBECONFIG_FILE=$T/kc; log() { :; }; . "$T/fn.sh"; record_failed_pods' > /dev/null 2>&1
c() { grep -c -- "$1" "$T/calls" 2>/dev/null; }
ns=ezcorp-factory-w4h35; pool=factory-pool-544b7d99cf-zjh74; sup=factory-supervisor-dw7gr
files=0; for x in "$pool.pool" "$sup.supervisor"; do [ -s "$T/p/pods/$ns.$x.previous.txt" ] && files=$((files + 1)); done
got="total=$(wc -l < "$T/calls" | tr -d ' ') prev-pool=$(c " $pool -c pool --previous") prev-sup=$(c " $sup -c supervisor --previous") prev-init=$(c '-c deliver-secrets --previous') all-prev=$(c 'all-containers=true --previous') files=$files"
rm -r "$T"
echo "$got"
[ "$got" = "total=7 prev-pool=1 prev-sup=1 prev-init=0 all-prev=0 files=2" ] && { echo PASS; exit 0; }
echo FAIL; exit 1
