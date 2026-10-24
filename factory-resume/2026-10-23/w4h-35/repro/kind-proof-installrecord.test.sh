#!/usr/bin/env bash
# kind-proof-installrecord.test.sh [driver]: the driver's own step_install and record_failed_pods (extracted, never restated),
# with a stub kubectl binary first (asserted hit) and a stub fleet command. Pass: every run records `kubectl get pods -A -o json`
# into install-pods.json (team-lead, run-9 route: so the next stub comes from a recorded real shape); a successful provision
# returns 0 and records no pod; a failed provision records the failing pods BEFORE it returns (and so before cleanup) and returns
# 74, its own stop value. On EVERY run, success included (team-lead R3, run 10), the pool's and the supervisor's pods (label
# app.kubernetes.io/name AND app.kubernetes.io/part-of=ezcorp-factory; a same-name pod of another product in the fixture is never
# touched) get describe and logs (all containers) in pods-ready/, and nothing else is called on success.
set -uo pipefail
DRIVER=${1:-evidence/w4h-35/repro/kind-proof.sh}
FIX=evidence/w4h-35/repro/fixtures/synthetic/install-pods.json
T=$(mktemp -d evidence/w4h-35/repro/.installrecordtest.XXXX)
awk '/^select_pods\(\) \{/,/^\}/; /^pod_records\(\) \{/,/^\}/; /^record_failed_pods\(\) \{/,/^\}/; /^record_system_pods\(\) \{/,/^\}/; /^step_install\(\) \{/,/^\}/' "$DRIVER" > "$T/fn.sh"
grep -q '^step_install() {' "$T/fn.sh" || { echo "FAIL: step_install not found"; rm -r "$T"; exit 1; }
printf '#!/usr/bin/env bash\necho "kubectl $*" >> "%s/calls"\ncase "$*" in *"get pods -A -o json"*) cat "%s";; *) echo "stub output for $*";; esac\n' "$T" "$FIX" > "$T/kubectl"; chmod 700 "$T/kubectl"
run() {  # <fleet provision rc> <dir>
  mkdir -p "$2"
  T=$T P=$2 FRC=$1 bash -c 'KUBECTL=$T/kubectl; KUBECONFIG_FILE=$T/kc; TENANT=tenant-35; POLLER=
    log() { :; }; mark() { :; }; pg_env() { :; }; stores_dir() { echo "$T/stores"; }; c12_poll() { sleep 30; }; bun() { echo x; }
    fleetcmd() { echo "{}"; return $FRC; }
    . "$T/fn.sh"; step_install' > /dev/null 2>&1
  echo $?
}
ok=$(run 0 "$T/ok"); okcalls=$(wc -l < "$T/calls" | tr -d ' '); bad=$(run 1 "$T/bad")
ready() { local n=0 x; for x in factory-pool-7d9dc866b8-8chhg factory-supervisor-bvj8h; do for k in describe logs; do [ -s "$1/pods-ready/ezcorp-factory-w4h35.$x.$k.txt" ] && n=$((n + 1)); done; done; echo "$n$(ls "$1/pods-ready" 2>/dev/null | grep -c -v -E '^ezcorp-factory-w4h35\.factory-(pool-7d9dc866b8-8chhg|supervisor-bvj8h)\.(describe|logs)\.txt$|^select' | sed 's/^0$//; s/^[1-9].*/+other/')"; }
same() { cmp -s "$FIX" "$1" && echo yes || echo no; }
got="ok=$ok okcalls=$okcalls foreign=$(grep -c 'other-team' "$T/calls") ready=$(ready "$T/ok") json=$(same "$T/ok/install-pods.json") pods=$([ -e "$T/ok/pods" ] && echo yes || echo no) bad=$bad ready=$(ready "$T/bad") json=$(same "$T/bad/install-pods.json") selected=$(grep -c . "$T/bad/pods/selected.txt" 2>/dev/null) jsoncalls=$(grep -c 'get pods -A -o json' "$T/calls") order=$([ "$(grep -n -m1 ' describe pod installation-' "$T/calls" | cut -d: -f1)" -gt "$(grep -n 'get pods -A -o json' "$T/calls" | tail -1 | cut -d: -f1)" ] 2>/dev/null && echo json-first || echo wrong)"
rm -r "$T"
echo "$got"
[ "$got" = "ok=0 okcalls=6 foreign=0 ready=4 json=yes pods=no bad=74 ready=4 json=yes selected=3 jsoncalls=2 order=json-first" ] && { echo PASS; exit 0; }
echo FAIL; exit 1
