#!/usr/bin/env bash
# kind-proof-preflight.test.sh [driver]: the driver's own preflight, on copies whose proof directory is a temp directory.
# real: exit 0. planted: the kind binary path points to a missing file -> exit 66 and the failure names that binary.
set -uo pipefail
DRIVER=${1:-evidence/w4h-35/repro/kind-proof.sh}
T=$(mktemp -d evidence/w4h-35/repro/.pftest.XXXX)
sed "s#^E=evidence/w4h-35; R=\$E/repro; P=\$E/proof;#E=evidence/w4h-35; R=\$E/repro; P=$T/proof;#" "$DRIVER" > "$T/real.sh"
grep -q "P=$T/proof;" "$T/real.sh" || { echo "FAIL: proof directory line not found"; rm -r "$T"; exit 1; }
sed 's#^KIND=/tmp/factory-tools/kind-0.32.0/kind;#KIND=/tmp/factory-tools/kind-0.32.0/kind-planted-missing;#' "$T/real.sh" > "$T/planted.sh"
cmp -s "$T/real.sh" "$T/planted.sh" && { echo "FAIL: the planted binary line did not change"; rm -r "$T"; exit 1; }
bash "$T/real.sh" preflight > "$T/real.out" 2>&1; real=$?
bash "$T/planted.sh" preflight > "$T/planted.out" 2>&1; planted=$?
echo "real: exit $real: $(tail -1 "$T/real.out" | cut -c23-)"
echo "planted: exit $planted: $(grep -m1 'preflight FAIL' "$T/planted.out")"
ok=0; [ "$real" = 0 ] && [ "$planted" = 66 ] && grep -q 'preflight FAIL: binary /tmp/factory-tools/kind-0.32.0/kind-planted-missing' "$T/planted.out" && ok=1
rm -r "$T"
[ "$ok" = 1 ] && { echo PASS; exit 0; }; echo FAIL; exit 1
