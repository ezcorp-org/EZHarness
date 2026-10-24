#!/usr/bin/env bash
# Sourced helper for every heavy-lock wrapper (lead ruling 2026-09-27, after four pre-emptions in one hour: flock is
# not FIFO and an owner in a long turn reads its inbox too late). The coordinator never kills a job; instead it can
# write a veto file for a lane, and the lane's own wrapper refuses to start the moment it acquires the lock.
#   lock_veto <lane>   -> if evidence/w00/lock-veto/<lane> exists: print its text, exit 98 (lock
#                         released, nothing run). Call it FIRST inside the flock'd script, after the lock is taken.
# Only the coordinator writes or removes veto files; an owner that finds one re-queues after the coordinator's word.
lock_veto() {
  local f=evidence/w00/lock-veto/$1
  if [ -e "$f" ]; then echo "LOCK VETO for lane $1 at $(date -u +%FT%TZ): $(cat "$f")"; exit 98; fi
}
