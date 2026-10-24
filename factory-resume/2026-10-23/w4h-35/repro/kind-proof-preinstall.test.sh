#!/usr/bin/env bash
# kind-proof-preinstall.test.sh [driver]: the driver's own step_preinstall (extracted, never restated) with a stub image list
# naming two images, a stub node resolver, and a ruled exemption record (team-lead ruling, 2026-10-17 06:4xZ). Pass:
#   both resolve: ok, "exempt by ruling: none"; B unresolved and exempt: proceeds, the record line names B as exempt;
#   B unresolved and not exempt: refused naming B; A unresolved (B exempt): refused naming exactly A.
set -uo pipefail
DRIVER=${1:-evidence/w4h-35/repro/kind-proof.sh}
T=$(mktemp -d evidence/w4h-35/repro/.preinstalltest.XXXX)
awk '/^step_preinstall\(\) \{/,/^\}/' "$DRIVER" > "$T/fn.sh"
[ -s "$T/fn.sh" ] || { echo "FAIL: step_preinstall not found"; rm -r "$T"; exit 1; }
A=localhost/w4h35-factory@sha256:45ea7b10b8c70f0a44f4dc6f1c3b84735d34eca00f518a747bbf507ddfd09346
B=docker.io/library/nginx@sha256:2f4e10193b0c4f61472245e9d26cea78e7df7af266c7e7cf5e67353ee2731b51
run() {  # <references the node resolves> <exempted reference>
  local d=$T/case-$RANDOM; mkdir -p "$d/r" "$d/p"; printf '%s (ruled reason)\n' "$2" > "$d/r/known-unresolvable.txt"
  D=$d A=$A B=$B OK="$1" bash -c '
    W=$D; R=$D/r; P=$D/p; ROOT=$D; NODE=n; log() { echo "LOG $*" >> "$D/log"; }; mark() { :; }
    bun() { printf "%s\n%s\n" "$A" "$B"; }
    podman() { [ "$1 $2 $3 $4" = "exec n crictl inspecti" ] && [[ " $OK " == *" $5 "* ]]; }
    . "$D/../fn.sh"; step_preinstall > /dev/null 2>&1; echo "rc=$? copied=$([ -f "$D/p/known-unresolvable.txt" ] && echo yes || echo no) log=$(tr "\n" "|" < "$D/log")"' 2>/dev/null
}
both=$(run "$A $B" "$B"); exempt=$(run "$A" "$B"); notexempt=$(run "$A" "docker.io/library/other@sha256:00"); factory=$(run "$B" "$B")
rm -r "$T"
echo "both resolve:        $both"; echo "B unresolved, exempt: $exempt"; echo "B not exempt:        $notexempt"; echo "A unresolved:        $factory"
[ "$both" = "rc=0 copied=yes log=LOG preinstall: 2 hosted image references; resolved in the node: 2; exempt by coordinator ruling (known-unresolvable.txt): none|" ] \
  && [ "$exempt" = "rc=0 copied=yes log=LOG preinstall: 2 hosted image references; resolved in the node: 1; exempt by coordinator ruling (known-unresolvable.txt): $B|" ] \
  && [ "$notexempt" = "rc=71 copied=yes log=LOG preinstall: refused: unresolved in the node: $B|" ] \
  && [ "$factory" = "rc=71 copied=yes log=LOG preinstall: refused: unresolved in the node: $A|" ] && { echo PASS; exit 0; }
echo FAIL; exit 1
