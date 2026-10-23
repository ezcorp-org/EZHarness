#!/usr/bin/env bash
# run13-launch.sh <head>: team-lead's run-13 word on validator-8's OK by hash: the kind proof at <head> = 3698c8e84, the merged W4H-35
# head (commit 07 on commit 06 631e60da2: the orchestrator's Node graph; commit 05: the hosted harness data directories), with patch
# 04's port shape in repro/hosted-images.ts.
# Made from run12-launch.sh;
# changed: pins, the head and chain check, the log, and the launch condition (disk >= 127G of the build filesystem in both clear reads,
# beside mem >= 15 GiB; team-lead's run-13 ruling; the driver's 112G floors stay). One launch at most; every check in logs/run13-launch.log.
. evidence/w00/coord-word.sh || exit 4
coord_word evidence/w4h-35/logs/run13-launch.log w4h35-run13 || exit 4   # FIRST: the team guard, fixed path, no override (lesson 21)
set -uo pipefail
E=evidence/w4h-35; R=$E/repro; W=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35
L=$E/logs/run13-launch.log; HEAD_WANT=${1:?the run-13 head}
say() { echo "[$(date -u +%FT%TZ)] $*" >> "$L"; }
disk() { df -BG --output=avail /home | tail -1 | tr -dc 0-9; }   # the build filesystem, as the driver's need() reads it
# The user's run-13 ruling (option (a), 2026-10-21): exactly ONE Docker Hub pull, the exempt ingress nginx by this digest (the kubelet's
# IfNotPresent pull in the kind node). After proof.exit, bin/pull-judge.py on proof/ and on each try folder this launch made; any other.
NGINX_ALLOWED=docker.io/library/nginx@sha256:2f4e10193b0c4f61472245e9d26cea78e7df7af266c7e7cf5e67353ee2731b51
# P3: no host pull of docker.io: a docker.io image the host holds after the run that it did not hold before is RED.
host_images() { podman images --digests --format '{{.Repository}}@{{.Digest}}' | sort -u; }
host_pull_check() { local new; new=$(comm -13 <(sort -u "$1") <(sort -u "$2") | grep '^docker\.io/'); [ -z "$new" ] || { say "RED: new docker.io image(s) on the host: $new"; return 1; }; }
judge_pulls() { local d st=0; for d in "$E/proof" $(comm -13 <(printf '%s\n' $1 | sort) <(ls -d "$E"/proof-try-* 2> /dev/null | sort)); do [ -d "$d" ] || continue; python3 -I "$E/bin/pull-judge.py" "$d" "$NGINX_ALLOWED" > "$d/pull-judgement.txt" 2>&1 || st=1; say "pull judge $(basename "$d"): $(cat "$d/pull-judgement.txt")"; done; return "$st"; }
say "run-13 launch script start (head $HEAD_WANT)"
for f in "$R/kind-proof.sh=dec1114866ad9437" "$E/bin/pull-judge.py=c66bac5b92fd0df9" "$E/bin/fullpath-judge.py=610c0e99acda4798" "$R/known-unresolvable.txt=32710881dc19f7c0" "$R/hosted-images.ts=ed58ce03460d9f4e" "$R/hosted-settings.ts=54fd6ae163aa1fa2" "$R/kind-podman-shim/podman=3dc765045abfee6c" "evidence/w00/coord-word.sh=34d9989d558e3b61"; do
  h=$(sha256sum "${f%%=*}" | cut -c1-16); [ "$h" = "${f##*=}" ] || { say "STOP: ${f%%=*} is $h, not ${f##*=}"; exit 3; }
done
[ "$(git -C "$W" rev-parse --short HEAD)" = "$HEAD_WANT" ] && [ -z "$(git -C "$W" status --short)" ] || { say "STOP: worktree is not a clean $HEAD_WANT"; exit 3; }
[ "$HEAD_WANT" = 3698c8e84 ] && [ "$(git -C "$W" log -1 --format=%s)" = "$(head -1 "$E/merge-prep/msg-code17.txt")" ] && [ "$(git -C "$W" rev-parse --short HEAD~1)" = 631e60da2 ] || { say "STOP: $HEAD_WANT is not commit 07 (3698c8e84) on 631e60da2"; exit 3; }
say "hashes ok (driver dec1114866ad9437, pull-judge c66bac5b92fd0df9, fullpath-judge 610c0e99acda4798, known-unresolvable 32710881dc19f7c0, hosted-images ed58ce03460d9f4e, hosted-settings 54fd6ae163aa1fa2, shim 3dc765045abfee6c, w00/coord-word.sh 34d9989d558e3b61); head $HEAD_WANT clean, commit 07 on 631e60da2"
[ ! -e "$E/proof" ] && [ ! -e "$E/proof.exit" ] || { say "STOP: proof/ or proof.exit present before the preflight"; exit 3; }
left="fleet=$([ -e "$HOME/.w4h35-fleet" ] && echo yes || echo no) runner=$([ -e "$HOME/.w4h35-runner" ] && echo yes || echo no) containers=$(podman ps -a --format '{{.Names}}' | grep -c w4h35) networks=$(podman network ls --format '{{.Name}}' | grep -cE 'w4h35|^kind$') volumes=$(podman volume ls --format '{{.Name}}' | grep -c w4h35) storedirs=$(ls -d "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"/w4h35-stores.* 2> /dev/null | wc -l) scratch=$(ls -d /tmp/w4h35-scratch.* 2> /dev/null | wc -l)"
say "clean-state check: $left"
[ "$left" = "fleet=no runner=no containers=0 networks=0 volumes=0 storedirs=0 scratch=0" ] || { say "STOP: not a clean state"; exit 3; }
pf=$(bash "$R/kind-proof.sh" preflight 2>&1 | tail -1); prc=${PIPESTATUS[0]}; say "preflight: $pf (exit $prc); disk $(disk)G free on /home (the build filesystem)"
[ -d "$E/proof" ] && mv "$E/proof" "$E/proof-preflight-check-$(date -u +%Y%m%dT%H%M%SZ)"
[ "$prc" = 0 ] || { say "STOP: preflight failed"; exit 3; }
read_state() { echo "$(bash evidence/w00/lock-read.sh) disk=$(disk)G"; }   # the shared reader (w00 only) plus the disk
ok() { awk -v m="$(echo "$1" | sed 's/.*mem=\([0-9.]*\).*/\1/')" -v d="$(echo "$1" | sed -n 's/.* disk=\([0-9]*\)G$/\1/p')" 'BEGIN{exit !(m>=15 && d!="" && d>=127)}' && [[ "$1" == *"lock=free gated=0 holders=0 yield=no disk="* ]]; }
while :; do a=$(read_state); sleep 60; b=$(read_state)
  if ok "$a" && ok "$b"; then say "lock condition: read1 $a | read2 $b: ok"; break; fi
  say "lock condition: read1 $a | read2 $b: wait"; sleep 60; done
[ ! -e "$E/proof" ] && [ ! -e "$E/proof.exit" ] || { say "STOP: proof/ not absent at launch"; exit 3; }
# The launch (launch-kind-proof.sh folded in, so this launcher's own gated-flock branch carries the guard): the preflight once
# more outside the lock, before the start gate (team-lead ruling R2-2), then ONE gated-flock job, label w4h35-kind-proof.
cd "$W" || exit 1
tries_before=$(ls -d "$E"/proof-try-* 2> /dev/null)
host_images > "$E/logs/run13-host-images-before.txt"
bash "$R/kind-proof.sh" preflight >> "$L" 2>&1 || { say "preflight failed outside the lock; not launched"; exit 66; }
say "launched on team-lead's word $COORD_WORD (head $(git rev-parse --short HEAD); driver $(sha256sum "$R/kind-proof.sh" | cut -c1-16))"
GATED_FLOCK_BUN_REPO=$W GATED_FLOCK_MEM_MARGIN_GIB=3 GATED_FLOCK_START_MEM_GIB=12 GATED_FLOCK_YIELD_FILE=evidence/w4h-28/proof/real-run.pending GATED_FLOCK_EXIT_FILE=$E/proof.exit \
  setsid nohup bash evidence/w00/gated-flock.sh w4h35-kind-proof "$L" timeout -k 600 3600 bash "$R/kind-proof.sh" all > "$E/logs/kind-proof-launch.nohup" 2>&1 < /dev/null &
until [ -e "$E/proof.exit" ]; do sleep 30; done
say "proof.exit $(cat "$E/proof.exit")"
# team-lead's run-13 ruling (b): ALL three judges run and each verdict is logged; one exit at the end, 1 if any was red.
verdict=0
judge_pulls "$tries_before" || { say "RED: a pull other than the allowed nginx digest (the user's run-13 ruling)"; verdict=1; }
host_images > "$E/logs/run13-host-images-after.txt"
host_pull_check "$E/logs/run13-host-images-before.txt" "$E/logs/run13-host-images-after.txt" || verdict=1
# team-lead ruling P2 and v3 / validator-8 R2: the FULL path (proof.exit 0; no G8 record; C12 steps 1-7 complete; the stopped wave
# stopped with its marks and wave exit 0).
python3 -I "$E/bin/fullpath-judge.py" "$E/proof" "$E/proof.exit" > "$E/proof/fullpath-judgement.txt" 2>&1 || { say "RED: $(cat "$E/proof/fullpath-judgement.txt")"; verdict=1; }
say "run 13 judged: $([ "$verdict" = 0 ] && echo PASS || echo RED): $(cat "$E/proof/fullpath-judgement.txt"); the pull and host checks as logged above"
exit "$verdict"
