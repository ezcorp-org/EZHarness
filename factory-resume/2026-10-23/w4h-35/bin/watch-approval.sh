#!/usr/bin/env bash
# watch-approval.sh [seconds]: a bounded watch (lesson 27). Ends when validator-8's W4H-35 verdict or plan file changes, or after
# <seconds> (default 300), and prints which; read-only on the validator's folder.
V=evidence/validator-8; T=${1:-300}
sig() { stat -c '%Y %s' "$V/verdict-w4h-35.txt" "$V/plan-w4h-35.md" 2>/dev/null | tr '\n' ' '; }
start=$(sig); end=$(( $(date +%s) + T ))
while [ "$(date +%s)" -lt "$end" ]; do sleep 15; [ "$(sig)" = "$start" ] || { echo "CHANGED $(date -u +%FT%TZ): the validator's W4H-35 record changed"; exit 0; }; done
echo "TIMEOUT $(date -u +%FT%TZ): no change in ${T} s; $(bash evidence/w00/lock-read.sh)"
