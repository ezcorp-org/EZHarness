#!/usr/bin/env bash
# watch-lock-cycle.sh [seconds]: a bounded watch (lesson 27) for another session's job on the heavy lock: ends when the lock was seen
# busy and is then free on two reads 30 s apart, or after <seconds> (default 300). Reads only w00/lock-read.sh.
T=${1:-300}; end=$(( $(date +%s) + T )); seen=no; last=
while [ "$(date +%s)" -lt "$end" ]; do
  r=$(bash evidence/w00/lock-read.sh); last=$r
  case $r in *lock=busy*|*gated=[1-9]*|*holders=[1-9]*) seen=yes ;; esac
  if [ "$seen" = yes ] && [[ $r == *"lock=free gated=0 holders=0"* ]]; then sleep 30; r2=$(bash evidence/w00/lock-read.sh)
    [[ $r2 == *"lock=free gated=0 holders=0"* ]] && { echo "CYCLE DONE $(date -u +%FT%TZ): the lock was busy and is free again ($r2)"; exit 0; }; fi
  sleep 15
done
echo "TIMEOUT $(date -u +%FT%TZ): busy seen=$seen; last read $last"
