#!/usr/bin/env bash
# run10-launch.sh: team-lead's word on validator-8's run-10 OK by hash (driver b19073b7 at bda171d19 (rebased on integ cf1de889b); team-lead run-9 route ruling and rebase rule). One launch at most; every check in logs/run10-launch.log.
. evidence/w00/coord-word.sh || exit 4
coord_word evidence/w4h-35/logs/run10-launch.log w4h35-run10 || exit 4   # FIRST: the team guard, fixed path, no override (lesson 21)
set -uo pipefail
E=evidence/w4h-35; R=$E/repro; W=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35
L=$E/logs/run10-launch.log
say() { echo "[$(date -u +%FT%TZ)] $*" >> "$L"; }
say "run-10 launch script start"
for f in "$R/kind-proof.sh=b19073b7376ce752" "$R/known-unresolvable.txt=ef3f997454d201d6" "$R/hosted-images.ts=c1e6b91f78106a9a" "$R/hosted-settings.ts=54fd6ae163aa1fa2" "$R/kind-podman-shim/podman=3dc765045abfee6c" "evidence/w00/coord-word.sh=34d9989d558e3b61"; do
  h=$(sha256sum "${f%%=*}" | cut -c1-16); [ "$h" = "${f##*=}" ] || { say "STOP: ${f%%=*} is $h, not ${f##*=}"; exit 3; }
done
[ "$(git -C "$W" rev-parse --short HEAD)" = bda171d19 ] && [ -z "$(git -C "$W" status --short)" ] || { say "STOP: worktree is not a clean bda171d19"; exit 3; }
say "hashes ok (driver b19073b7376ce752, known-unresolvable ef3f997454d201d6, hosted-images c1e6b91f78106a9a, hosted-settings 54fd6ae163aa1fa2, shim 3dc765045abfee6c, w00/coord-word.sh 34d9989d558e3b61); head bda171d19 clean"
[ ! -e "$E/proof" ] && [ ! -e "$E/proof.exit" ] || { say "STOP: proof/ or proof.exit present before the preflight"; exit 3; }
left="fleet=$([ -e "$HOME/.w4h35-fleet" ] && echo yes || echo no) runner=$([ -e "$HOME/.w4h35-runner" ] && echo yes || echo no) containers=$(podman ps -a --format '{{.Names}}' | grep -c w4h35) networks=$(podman network ls --format '{{.Name}}' | grep -cE 'w4h35|^kind$') volumes=$(podman volume ls --format '{{.Name}}' | grep -c w4h35) storedirs=$(ls -d "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"/w4h35-stores.* 2> /dev/null | wc -l) scratch=$(ls -d /tmp/w4h35-scratch.* 2> /dev/null | wc -l)"
say "clean-state check: $left"
[ "$left" = "fleet=no runner=no containers=0 networks=0 volumes=0 storedirs=0 scratch=0" ] || { say "STOP: not a clean state"; exit 3; }
pf=$(bash "$R/kind-proof.sh" preflight 2>&1 | tail -1); prc=${PIPESTATUS[0]}; say "preflight: $pf (exit $prc)"
[ -d "$E/proof" ] && mv "$E/proof" "$E/proof-preflight-check-$(date -u +%Y%m%dT%H%M%SZ)"
[ "$prc" = 0 ] || { say "STOP: preflight failed"; exit 3; }
read_state() { bash evidence/w00/lock-read.sh; }   # the shared reader (w00 only): never counts its own ancestors
ok() { awk -v m="$(echo "$1" | sed 's/.*mem=\([0-9.]*\).*/\1/')" 'BEGIN{exit !(m>=15)}' && [[ "$1" == *"lock=free gated=0 holders=0 yield=no" ]]; }
while :; do a=$(read_state); sleep 60; b=$(read_state)
  if ok "$a" && ok "$b"; then say "lock condition: read1 $a | read2 $b: ok"; break; fi
  say "lock condition: read1 $a | read2 $b: wait"; sleep 60; done
[ ! -e "$E/proof" ] && [ ! -e "$E/proof.exit" ] || { say "STOP: proof/ not absent at launch"; exit 3; }
# The launch (launch-kind-proof.sh folded in, so this launcher's own gated-flock branch carries the guard): the preflight once
# more outside the lock, before the start gate (team-lead ruling R2-2), then ONE gated-flock job, label w4h35-kind-proof.
cd "$W" || exit 1
bash "$R/kind-proof.sh" preflight >> "$L" 2>&1 || { say "preflight failed outside the lock; not launched"; exit 66; }
say "launched on team-lead's word $COORD_WORD (head $(git rev-parse --short HEAD); driver $(sha256sum "$R/kind-proof.sh" | cut -c1-16))"
GATED_FLOCK_BUN_REPO=$W GATED_FLOCK_MEM_MARGIN_GIB=3 GATED_FLOCK_START_MEM_GIB=12 GATED_FLOCK_YIELD_FILE=evidence/w4h-28/proof/real-run.pending GATED_FLOCK_EXIT_FILE=$E/proof.exit \
  setsid nohup bash evidence/w00/gated-flock.sh w4h35-kind-proof "$L" timeout -k 600 3600 bash "$R/kind-proof.sh" all > "$E/logs/kind-proof-launch.nohup" 2>&1 < /dev/null &
until [ -e "$E/proof.exit" ]; do sleep 30; done
say "proof.exit $(cat "$E/proof.exit")"
