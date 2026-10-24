#!/usr/bin/env bash
# gate-leg.test.sh (team-lead condition on N1, 2026-10-20): gate_leg_ok passes only the 0-findings form of scripts/gate-integrity.ts
# (the PASSED line of gate-integrity.ts:1553, no finding, bypass or error line); it reds a planted finding (FAILED, exit 1 at :1565-1570),
# the bypass form that exits 0 with findings (GATE_CHANGE_APPROVED, :1557-1563), the fail-closed error (:1576-1583), and an empty log.
set -u
. "${GATE_LEG_LIB:-evidence/w00/gate-leg.sh}"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; fail=0; n=0
check() { n=$((n + 1)); local want=$1 label=$2; gate_leg_ok "$T/in" "$label" "$T/legs"; local got=$?; [ "$got" = "$want" ] || { echo "FAIL: $label: want $want got $got"; fail=1; }; }
cp evidence/w00/gate-leg-fixtures/passed-session5-default.log "$T/in"; check 0 "the session-5 default leg (PASSED)"
printf 'Gate integrity PASSED: no gate-weakening or test-cheating changes detected.\n' > "$T/in"; check 0 "the PASSED line"
printf 'Gate integrity FAILED (1 finding(s)):\n  scripts/merge-lcov.ts: a planted finding\n\nIf a change here is legitimate, ...\n' > "$T/in"; check 1 "a planted finding"
printf 'Gate integrity: 1 finding(s) BYPASSED via GATE_CHANGE_APPROVED (maintainer label):\n  (bypassed) scripts/x.ts: y\n' > "$T/in"; check 1 "the bypass form (exit 0 with a finding)"
printf 'Gate integrity ERROR (fail-closed): git failed\n' > "$T/in"; check 1 "the fail-closed error"
printf 'Gate integrity PASSED: no gate-weakening or test-cheating changes detected.\n  (bypassed) scripts/x.ts: y\n' > "$T/in"; check 1 "PASSED with a bypassed finding line"
printf 'Gate integrity PASSED: no gate-weakening or test-cheating changes detected.\nGate integrity: 1 finding(s) BYPASSED via GATE_CHANGE_APPROVED (maintainer label):\n' > "$T/in"; check 1 "PASSED with a BYPASSED summary line (integrator-5 case)"
printf 'Gate integrity PASSED: no gate-weakening or test-cheating changes detected.\nGate integrity FAILED (1 finding(s)):\n' > "$T/in"; check 1 "PASSED with a FAILED line (integrator-5 case)"
: > "$T/in"; check 1 "an empty log"
rm -f "$T/in"; check 1 "a missing log"
[ "$(grep -c '^RED: ' "$T/legs")" = 8 ] || { echo "FAIL: eight named reds expected"; fail=1; }
[ "$fail" = 0 ] && echo "gate-leg.test.sh: $n of $n pass"
exit "$fail"
