#!/usr/bin/env bash
# kind-proof-records.test.sh [driver]: (a) the kubeconfig and the build context are placed outside the evidence tree;
# (b) step_all (extracted, never restated) records the wave as "not run" when install fails and "exit N" when it ran;
# (c) no run folder under the evidence tree holds a kubeconfig or key material.
set -uo pipefail
DRIVER=${1:-evidence/w4h-35/repro/kind-proof.sh}; E=evidence/w4h-35
T=$(mktemp -d $E/repro/.recordstest.XXXX)
# One scratch root outside the evidence tree holds the build context and the kubeconfig (team-lead ruling, run 6).
root=$(grep -oE 'SCRATCH=\$\(mktemp -d [^)]*\)' "$DRIVER" | head -1); kc=$(grep -oE 'KUBECONFIG_FILE=[^ ;]+' "$DRIVER" | grep -v 'KUBECONFIG_FILE=$' | head -1)
ctx=$(grep -oE 'mktemp -d [^)]*ctx[^)]*' "$DRIVER" | head -1)
place=ok
[[ "$root" == *"/tmp/"* && "$root" != *'$E'* && "$root" != *"$E"* ]] || place="scratch root not a mktemp outside the evidence tree ($root)"
[ "$kc" = 'KUBECONFIG_FILE=$SCRATCH/kubeconfig' ] || place="kubeconfig not in the scratch root ($kc)"
[[ "$ctx" == *'${SCRATCH'* ]] || place="build context not in the scratch root ($ctx)"
awk '/^step_all\(\) \{/,/^\}/' "$DRIVER" > "$T/step_all.sh"
wave() {  # <install rc> <wave rc> [<preinstall rc>]
  T=$T IRC=$1 WRC=$2 PRC=${3:-0} bash -c '
    P=$T; mktemp() { command mktemp -d "$T/scratch.XXXX"; }   # the scratch root stays inside the test folder
    log() { echo "$*" >> "$T/log"; }; mark() { :; }; mem() { echo 1; }; low() { :; }; sampler() { :; }; trap() { :; }
    step_preflight() { :; }; step_image() { :; }; step_pg() { :; }; step_stores() { :; }; step_cluster() { :; }; step_fleet() { :; }
    step_preinstall() { return $PRC; }; step_install() { return $IRC; }; step_wave() { return $WRC; }
    : > "$T/log"; . "$T/step_all.sh"; step_all > /dev/null 2>&1; grep -oE "all: (preinstall|install) .*" "$T/log"' 2>/dev/null
}
w1=$(wave 1 0); w2=$(wave 0 0); w3=$(wave 0 2); w4=$(wave 0 0 1)
# The narrow allow list (team-lead ruling 2026-10-21): exactly the 4 merge-plan copies of tests/postgres/factory-provisioning.test.ts,
# by path AND sha256 (their one match is the refusal fixture "bad" key value, the same line as the committed test file); pinned here.
. "$E/repro/key-sweep-allow.sh"
[ "$(sha256sum "$E/repro/key-sweep-allowed.txt" | cut -c1-16)" = a563d1b6f9b272d2 ] || { echo "FAIL: the key-sweep allow list is not a563d1b6f9b272d2"; exit 1; }
found=$(find "$E" -path "$E/repro" -prune -o -type f \( -name kubeconfig -o -name '*.kubeconfig' \) -print 2>/dev/null; grep -rlE 'client-key-data|BEGIN [A-Z ]*PRIVATE KEY|"(accessKey|secretKey)" *:' "$E" --exclude-dir=repro 2>/dev/null | key_sweep_unlisted "$E/repro/key-sweep-allowed.txt")
rm -r "$T"
left=$(find /tmp -maxdepth 1 -name 'w4h35-scratch.*' -newer "$DRIVER" 2>/dev/null | wc -l)
echo "scratch roots left in /tmp by this test: $left"
echo "placement: $place"; echo "install fails:      $w1"; echo "install and wave ok: $w2"; echo "wave fails:         $w3"; echo "preinstall fails:   $w4"; echo "key files in evidence: [$found]"
[ "$left" = 0 ] && [ "$place" = ok ] && [ "$w1" = "all: preinstall exit 0, install exit 1, wave not run" ] && [ "$w2" = "all: preinstall exit 0, install exit 0, wave exit 0" ] && [ "$w3" = "all: preinstall exit 0, install exit 0, wave exit 2" ] && [ "$w4" = "all: preinstall exit 1, install not run, wave not run" ] && [ -z "$found" ] && { echo PASS; exit 0; }
echo FAIL; exit 1
