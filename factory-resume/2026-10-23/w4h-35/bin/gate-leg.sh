# gate-leg.sh (sourced; team-lead condition on N1, 2026-10-20): with the expected set EMPTY, a gate-integrity leg is green only when
# the tool exits 0 AND its output is the 0-findings form. Exit 0 alone is not enough: scripts/gate-integrity.ts:1557-1563 exits 0
# with findings when GATE_CHANGE_APPROVED is set ("BYPASSED").
#   gate_leg_ok <log> <label> <legs log>: true only when <log> has the PASSED line (gate-integrity.ts:1553) and no FAILED, BYPASSED,
#   "(bypassed)" or ERROR line; otherwise it names the red in <legs log> and returns 1. The caller still judges the exit code.
gate_leg_ok() {
  local log=$1 label=$2 legs=$3
  if [ -f "$log" ] && grep -qx 'Gate integrity PASSED: no gate-weakening or test-cheating changes detected.' "$log" \
    && ! grep -qE '^Gate integrity (FAILED|ERROR)|^Gate integrity: .*BYPASSED|^ *\(bypassed\) ' "$log"; then return 0; fi
  echo "RED: $label: the gate-integrity output is not the 0-findings form ($log)" >> "$legs"
  return 1
}
