#!/usr/bin/env bash
# kind-proof-exitcode.test.sh [driver]: under the driver's own `set -euo pipefail`, step_all (extracted, never restated) exits with
# the resolver's own value when step_cluster refuses: 72 or 73 reach the run's exit record, never a generic 1 (team-lead, run 8).
set -uo pipefail
DRIVER=${1:-evidence/w4h-35/repro/kind-proof.sh}
T=$(mktemp -d evidence/w4h-35/repro/.exittest.XXXX)
awk '/^step_all\(\) \{/,/^\}/' "$DRIVER" > "$T/step_all.sh"
run() {  # <step_cluster rc> [<preinstall rc> <install rc>]
  T=$T CRC=$1 PRC=${2:-0} IRC=${3:-0} bash -c '
    set -euo pipefail
    P=$T; log() { :; }; mark() { :; }; mem() { echo 1; }; low() { :; }; sampler() { :; }; trap() { :; }; mktemp() { command mktemp -d "$T/s.XXXX"; }
    step_preflight() { :; }; step_image() { :; }; step_pg() { :; }; step_stores() { :; }; step_cluster() { return $CRC; }; step_fleet() { :; }
    step_preinstall() { return $PRC; }; step_install() { return $IRC; }; step_wave() { :; }; g8_record() { :; }
    . "$T/step_all.sh"; step_all' > /dev/null 2>&1
  echo $?
}
a=$(run 72); b=$(run 73); f=$(run 77); c=$(run 0 71 0); d=$(run 0 0 74); e=$(run 0 0 0)
rm -r "$T"
echo "step_cluster 72 -> run exit $a"; echo "step_cluster 73 -> run exit $b"; echo "step_cluster 77 (runner root not prepared) -> run exit $f"; echo "preinstall 71 -> run exit $c"; echo "install 74 -> run exit $d"; echo "all ok -> run exit $e"
[ "$a" = 72 ] && [ "$b" = 73 ] && [ "$f" = 77 ] && [ "$c" = 71 ] && [ "$d" = 74 ] && [ "$e" = 0 ] && { echo PASS; exit 0; }; echo FAIL; exit 1
