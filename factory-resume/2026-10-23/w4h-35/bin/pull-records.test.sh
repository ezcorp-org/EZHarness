#!/usr/bin/env bash
# pull-records.test.sh [driver] (the user's run-13 ruling, option (a)): the driver records, at the start of its cleanup and so before
# the teardown and the kind delete, the node's final images (crictl, digests) and the cluster's events, for bin/pull-judge.py; with
# no node it writes nothing and says so. Default driver: repro/kind-proof.sh.
set -u
D=${1:-evidence/w4h-35/repro/kind-proof.sh}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; fail=0; n=0
ok() { n=$((n + 1)); [ "$1" = "$2" ] || { echo "FAIL: $3: want $2 got $1"; fail=1; }; }
eval "$(sed -n '/^record_node_pulls() {/,/^}/p' "$D")"
P=$T; NODE=w4h35-control-plane; KUBECTL=kubectl; KUBECONFIG_FILE=$T/kubeconfig
log() { echo "$*" >> "$T/log"; }; note() { echo "note $*" >> "$T/log"; }
podman() { case "$1 $2" in "container exists") return "$NODE_RC" ;; "exec $NODE") echo '{"images": []}' ;; *) return 9 ;; esac; }
kubectl() { [[ " $* " == *" get events -A -o json "* ]] && echo '{"items": []}' || return 9; }
NODE_RC=0; record_node_pulls 2> /dev/null; ok $? 0 "record_node_pulls runs"
[ -s "$T/node-images-final.json" ]; ok $? 0 "the node's final images are recorded"
[ -s "$T/node-pull-events.json" ]; ok $? 0 "the cluster's events are recorded"
rm -f "$T"/node-*.json; NODE_RC=1; record_node_pulls 2> /dev/null; ok $? 0 "no node: runs"
ls "$T"/node-*.json > /dev/null 2>&1; ok $? 2 "no node: no record written"
grep -q 'no node, no node pull records' "$T/log"; ok $? 0 "no node: said so"
c=$(grep -n '^step_cleanup() {' "$D" | cut -d: -f1); r=$(grep -n '^  record_node_pulls$' "$D" | head -1 | cut -d: -f1); t=$(grep -n 'fleetcmd teardown' "$D" | head -1 | cut -d: -f1)
[ -n "$c" ] && [ -n "$r" ] && [ -n "$t" ] && [ "$c" -lt "$r" ] && [ "$r" -lt "$t" ]; ok $? 0 "the records come first in the cleanup, before the teardown"
[ "$fail" = 0 ] && echo "pull-records.test.sh: $n of $n pass ($D)"
exit "$fail"
