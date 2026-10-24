#!/usr/bin/env bash
# w00/lock-read.sh (shared; W4H-35's bin/lock-read.sh ea0aaeea5a5798d8 promoted by team-lead's ruling 2026-10-17): ONE read of the heavy-lock
# condition, printed as ONE line in a fixed format:
#   mem=<MemAvailable GiB, 1 decimal> lock=<free|busy> gated=<n> holders=<n> yield=<yes|no>
# (W4H-35's fields and order, plus lock=; a "*gated=0 holders=0 yield=no" suffix match still works).
#  lock     busy when /proc/locks has a FLOCK entry on the lock file's device:inode (read-only; never takes the lock); free otherwise,
#           also when the lock file does not exist;
#  gated    processes whose command line starts "bash evidence/w00/gated-flock.sh";
#  holders  processes whose command line starts "flock --close /tmp/ezcorp-validation-heavy.lock" (holders AND queued waiters);
#  both counts EXCLUDE every ancestor of this reader (the caller's own shell, and a gated job that runs this read inside the lock);
#  yield    yes when the yield file exists.
# Test-only overrides (defaults are the real paths): LOCK_READ_MEMINFO, LOCK_READ_PROC_LOCKS, LOCK_READ_LOCKFILE, LOCK_READ_YIELD_FILE.
set -u
MI=${LOCK_READ_MEMINFO:-/proc/meminfo} PL=${LOCK_READ_PROC_LOCKS:-/proc/locks}
LF=${LOCK_READ_LOCKFILE:-/tmp/ezcorp-validation-heavy.lock} YF=${LOCK_READ_YIELD_FILE:-evidence/w4h-28/proof/real-run.pending}
anc=" "; p=$$; while [ "${p:-0}" -gt 1 ]; do anc="$anc$p "; p=$(awk '{print $4}' "/proc/$p/stat" 2>/dev/null) || break; done
count() { local n=0 q; for q in $(pgrep -f -- "$1"); do case "$anc" in *" $q "*) ;; *) n=$((n + 1)) ;; esac; done; echo $n; }
lock=free
if [ -e "$LF" ]; then d=$(stat -c %d "$LF") i=$(stat -c %i "$LF")
  key=$(printf '%02x:%02x:%d' $(( (d >> 8) & 0xfff )) $(( (d & 0xff) | ((d >> 12) & 0xfff00) )) "$i")
  awk -v k="$key" '$2 == "FLOCK" && $6 == k {f=1} END {exit !f}' "$PL" && lock=busy; fi
echo "mem=$(awk '/^MemAvailable:/{printf "%.1f", $2/1048576}' "$MI") lock=$lock gated=$(count '^bash evidence/w00/gated-flock[.]sh') holders=$(count '^flock --close /tmp/ezcorp-validation-heavy[.]lock') yield=$([ -e "$YF" ] && echo yes || echo no)"
