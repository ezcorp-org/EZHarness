#!/usr/bin/env bash
# retry-launch-step.sh <launch command...> (integrator-5, 2026-10-23; team-lead's ruling: the hold and publish launches use a bounded retry
# run by the integrator; the word- and step-parameterized form of retry-launch.sh 86888f035229de0d, which stays an unused record).
# The command is given as VISIBLE arguments and must be exactly `bash <this folder>/launch.sh <hold|publish>`; COORD_WORD (8 hex, the
# coordinator's word for THIS step) is in the environment of the start line. Pre-wait: until /proc/locks shows no holder of the heavy
# lock's inode for one read, bounded at 30 min (then exit 92, no try). Then up to 40 tries, 60 s apart. Exit 5 (REFUSED, no job): hash
# <step>-gate.log, mv it to <step>-gate.log.refused-<N>-<hash16>, append one line to <step>-refused-tries.txt, sleep 60. Any other exit
# stops the loop (no retry after a job may have started; the word is spent only when a job enters gated-flock).
set -u
D=$(cd "$(dirname "$0")" && pwd); L=/tmp/ezcorp-validation-heavy.lock
[[ "${COORD_WORD:-}" =~ ^[0-9a-f]{8}$ ]] || { echo "REFUSED: COORD_WORD is not 8 hex"; exit 2; }
case "$*" in "bash $D/launch.sh hold") S=hold ;; "bash $D/launch.sh publish") S=publish ;; *) echo "REFUSED: the command is not the ruled form: $*"; exit 2 ;; esac
G=$D/$S-gate.log; R=$D/$S-refused-tries.txt
ino=$(stat -c %i "$L") || exit 2; end=$(( $(date +%s) + 1800 ))
while awk -v i=":$ino" '$6 ~ i"$" {f=1} END {exit !f}' /proc/locks; do
  [ "$(date +%s)" -lt "$end" ] || { echo "pre-wait $S $(date -u +%FT%TZ): a holder for 30 min: exit 92, no try" | tee -a "$R"; exit 92; }
  sleep 30
done
echo "pre-wait $S $(date -u +%FT%TZ): no /proc/locks holder of $L (inode $ino); word $COORD_WORD" | tee -a "$R"
n=$(ls "$G".refused-* 2>/dev/null | wc -l)
for t in $(seq 1 40); do
  cd /tmp || exit 2
  "$@"; rc=$?
  if [ "$rc" != 5 ]; then echo "try $t $(date -u +%FT%TZ): exit $rc: STOP (no retry)" | tee -a "$R"; exit "$rc"; fi
  n=$((n + 1)); h=$(sha256sum "$G" | cut -c1-16)
  mv "$G" "$G.refused-$n-$h"
  echo "try $t $(date -u +%FT%TZ): exit 5 REFUSED (no job): $(basename "$G").refused-$n-$h $(tail -1 "$G.refused-$n-$h" | cut -c1-160)" | tee -a "$R"
  sleep 60
done
echo "GAVE UP after 40 tries $(date -u +%FT%TZ)" | tee -a "$R"; exit 91
