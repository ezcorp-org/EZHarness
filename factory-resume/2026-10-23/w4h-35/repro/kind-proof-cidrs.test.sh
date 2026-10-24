#!/usr/bin/env bash
# kind-proof-cidrs.test.sh [driver]: the driver's own subnet helpers and spec() (extracted, never restated), with a stub podman whose
# `network inspect --format` output follows the real template rules (no separator unless the template prints one).
# Pass: a dual-stack kind network gives nodeCidrs ["<PODMAN-NET>/24"] (one IPv4 entry); egressCidrs has one entry per CIDR; a network
# with no IPv4 subnet makes spec() fail. (Run 5: "fc00:f853:ccd:e793::/64<PODMAN-NET>/24".)
set -uo pipefail
DRIVER=${1:-evidence/w4h-35/repro/kind-proof.sh}
T=$(mktemp -d evidence/w4h-35/repro/.cidrtest.XXXX)
grep -E '^(subnet|subnets|cidrs_json)\(\)' "$DRIVER" > /dev/null || { echo "FAIL: no subnet helper"; rm -r "$T"; exit 1; }
python3 -I - "$DRIVER" > "$T/helpers.sh" <<'PYX'
import re, sys
lines = open(sys.argv[1]).read().split("\n"); out = []; i = 0
while i < len(lines):
    if re.match(r"^(subnet|subnets|cidrs_json)\(\) \{", lines[i]):
        if lines[i].rstrip().endswith("}"): out.append(lines[i]); i += 1; continue
        while True:
            out.append(lines[i]); i += 1
            if lines[i - 1] == "}": break
    else: i += 1
print("\n".join(out))
PYX
awk '/^  spec\(\) \{/,/^  \}/' "$DRIVER" > "$T/spec.sh"
[ -s "$T/spec.sh" ] || { echo "FAIL: spec() not found"; rm -r "$T"; exit 1; }
run() {  # <kind subnets, space separated>
  T=$T KINDNETS="$1" bash -c '
    set -euo pipefail
    P=$T; R=$T; ROOT=$T/root; KUBECTL=k; KUBECONFIG_FILE=c; FLEET=w4h35; RUNNER_ROOT=/r; RUN_AS_USER=10001; NODEPORT=30443; PG=w4h35-proof-pg; PGNET=w4h35-proof; STORAGE_NET=storage-net; STORE_ORDINARY=o; STORE_ARCHIVE=a; STORE_PORTS=(37333 37334 37343 37344)
    log() { :; }; ip_on() { echo <IP>; }; bun() { :; }
    podman() {
      [ "$1 $2" = "network inspect" ] || return 0
      local nets; case "$3" in kind) nets=$KINDNETS;; storage-net) nets=<PODMAN-NET>/24;; w4h35-proof) nets=<PODMAN-NET>/24;; *) nets=<PODMAN-NET>/24;; esac
      local fmt=$5 n; for n in $nets; do if [[ "$fmt" == *"\"\\n\""* ]]; then printf "%s\n" "$n"; else printf "%s" "$n"; fi; done
    }
    . "$T/helpers.sh"; . "$T/spec.sh"
    rm -f "$T/hosted-spec.json"; rc=0; spec "<IP>/24" "<IP>" > /dev/null 2>&1 || rc=$?
    nodes=$(python3 -I -c "import json,sys; d=json.load(open(sys.argv[1])); print(json.dumps(d[\"nodeCidrs\"]), json.dumps(d[\"egressCidrs\"]))" "$T/hosted-spec.json" 2>/dev/null || echo "invalid-json")
    echo "rc=$rc $nodes"' 2>"$T/err"
}
dual=$(run "fc00:f853:ccd:e793::/64 <PODMAN-NET>/24"); [ -n "$dual" ] || cat "$T/err" >&2
v6only=$(run "fc00:f853:ccd:e793::/64")
rm -r "$T"
echo "dual-stack: $dual"; echo "ipv6-only:  $v6only"
[ "$dual" = 'rc=0 ["<PODMAN-NET>/24"] ["<PODMAN-NET>/24", "<PODMAN-NET>/24", "<IP>/24"]' ] && [[ "$v6only" == rc=1* ]] && { echo PASS; exit 0; }; echo FAIL; exit 1
