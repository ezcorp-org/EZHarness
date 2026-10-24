#!/usr/bin/env bash
# kind-proof-low.test.sh [driver]: tests the driver's own mem() and low() (extracted from the driver, never restated):
# the first sample is written, a lower sample replaces a higher one, a higher sample keeps the lower one.
# A planted mutant (low() that always writes) must fail the third case. Exit 0 only when real passes and the mutant fails.
set -uo pipefail
DRIVER=${1:-evidence/w4h-35/repro/kind-proof.sh}
T=$(mktemp -d evidence/w4h-35/repro/.lowtest.XXXX)
grep -E '^(mem|low)\(\)' "$DRIVER" > "$T/fns.sh"
[ "$(wc -l < "$T/fns.sh")" = 2 ] || { echo "FAIL: mem() and low() not found once each"; exit 1; }
sed 's/; then echo "\$m" > "\$P\/mem-lowest"; fi; }/; then :; fi; echo "$m" > "$P\/mem-lowest"; }/' "$T/fns.sh" > "$T/mutant.sh"
cmp -s "$T/fns.sh" "$T/mutant.sh" && { echo "FAIL: the mutant did not change low()"; exit 1; }
cases() {  # <functions file> -> "first lowered kept" verdicts
  P=$T/run; mkdir -p "$P"; : > "$P/mem-lowest"; rm -f "$P/mem-lowest"
  ( . "$1"; low; [ -s "$P/mem-lowest" ] && echo -n "first:ok " || echo -n "first:FAIL "
    echo 999 > "$P/mem-lowest"; low; awk -v v="$(cat "$P/mem-lowest")" 'BEGIN{exit !(v<999)}' && echo -n "lowered:ok " || echo -n "lowered:FAIL "
    echo 0.5 > "$P/mem-lowest"; low; [ "$(cat "$P/mem-lowest")" = 0.5 ] && echo "kept:ok" || echo "kept:FAIL" )
}
real=$(cases "$T/fns.sh"); mutant=$(cases "$T/mutant.sh")
echo "real:   $real"; echo "mutant: $mutant"
rm -r "$T"
[ "$real" = "first:ok lowered:ok kept:ok" ] && [[ "$mutant" == *"kept:FAIL"* ]] && { echo "PASS"; exit 0; }
echo "FAIL"; exit 1
