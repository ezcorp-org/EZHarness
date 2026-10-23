#!/usr/bin/env bash
# run12-static-launch.sh: ONLY on team-lead's word, by message id (COORD_WORD). Checks that the tree is 62aae196b plus exactly the
# run-12 files and that its patch (git diff, then the one new file) is the worded patch 5cb1a51ca0b1befe; checks every script and
# message by hash; waits lock-free for two reads 60 s apart (lock=free, gated 0, holders 0, no yield, MemAvailable >= 15 GiB); then
# ONE gated session: locked-rows-fix-c9.sh (rows commit, fix commit, fast stage and C9 at the new head, base cf1de889b).
. evidence/w00/coord-word.sh || exit 4
coord_word evidence/w4h-35/logs/gated-run12-static.log w4h35-run12-static || exit 4   # FIRST: the team guard, fixed path, no override
set -u
E=evidence/w4h-35; W=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35
L=$E/logs/gated-run12-static.log
say() { echo "[$(date -u +%FT%TZ)] $*" >> "$L"; }
NEW=src/__tests__/helpers/kubernetes-private-paths.ts
FIX="docs/factory-deployment.md src/factory/host-launch-client.test.ts src/factory/pool/process.test.ts src/factory/private-files.ts src/factory/provisioning/fleet-profile.test.ts src/factory/provisioning/fleet-profile.ts src/factory/provisioning/fleet.test.ts src/factory/provisioning/fleet.ts src/factory/provisioning/host.test.ts src/factory/provisioning/host.ts src/factory/provisioning/kubernetes-paths.ts src/factory/provisioning/kubernetes-profile.test.ts src/factory/provisioning/kubernetes-profile.ts src/factory/provisioning/kubernetes-target.test.ts src/factory/provisioning/kubernetes-target.ts src/factory/runner/host-tombstones.test.ts src/factory/runner/host-tombstones.ts src/factory/runner/supervisor-process.test.ts src/factory/runner/supervisor-process.ts src/factory/runner/supervisor-services.test.ts src/factory/runner/supervisor-services.ts src/factory/runtime-composition.test.ts src/factory/runtime-composition.ts src/factory/runtime-workers.ts src/factory/service-probes.test.ts src/factory/service-probes.ts src/factory/service-readiness.test.ts src/factory/service-readiness.ts $NEW"
WANT="docs/plans/2026-09-12-composable-factory-platform-contracts.md $FIX"
for f in "$E/bin/locked-rows-fix-c9.sh=23985b6dcab5d5cf" "$E/bin/locked-commit-fix.sh=fb0862e33993e346" "$E/bin/locked-fast-c9.sh=5507d0953edb775f" "$E/bin/locked-static-c9.sh=cd13c81bcad9a25e" "$E/bin/merge-fast-checks.w4h35.sh=e94acfe0da9e687d" "$E/msg-run12-rows.txt=1de23f12c0d8c318" "$E/msg-run12-fix.txt=63859563cba3bef6" "evidence/w00/coord-word.sh=34d9989d558e3b61"; do
  h=$(sha256sum "${f%%=*}" | cut -c1-16); [ "$h" = "${f##*=}" ] || { say "STOP: ${f%%=*} is $h, not ${f##*=}"; exit 3; }
done
[ "$(git -C "$W" rev-parse --short HEAD)" = 62aae196b ] && [ "$(git -C "$W" status --short | awk '{print $2}' | sort | tr '\n' ' ')" = "$(echo $WANT | tr ' ' '\n' | sort | tr '\n' ' ')" ] || { say "STOP: the tree is not 62aae196b plus exactly the run-12 files"; exit 3; }
[ "$( { git -C "$W" diff; cat "$W/$NEW"; } | sha256sum | cut -d' ' -f1)" = 5cb1a51ca0b1befe4cf2ca02185188c1c13372a05439c20f4410411b6ae692a8 ] || { say "STOP: the tree's patch is not the worded patch 5cb1a51ca0b1befe"; exit 3; }
clear() { [[ "$1" == *"lock=free gated=0 holders=0 yield=no" ]] && awk -v m="$(echo "$1" | sed 's/mem=\([0-9.]*\).*/\1/')" 'BEGIN{exit !(m>=15)}'; }
while :; do
  a=$(bash evidence/w00/lock-read.sh); sleep 60; b=$(bash evidence/w00/lock-read.sh)
  if clear "$a" && clear "$b"; then say "read1 $a | read2 $b: ok"; break; fi
  say "read1 $a | read2 $b: wait"; sleep 60
done
cd "$W" && GATED_FLOCK_BUN_REPO=$W GATED_FLOCK_MEM_MARGIN_GIB=3 GATED_FLOCK_YIELD_FILE=evidence/w4h-28/proof/real-run.pending GATED_FLOCK_EXIT_FILE=$E/run12-static.exit.$(date -u +%Y%m%dT%H%M%SZ) \
  bash evidence/w00/gated-flock.sh w4h35-run12-static "$L" timeout 5400 bash "$E/bin/locked-rows-fix-c9.sh" 62aae196b "$E/msg-run12-rows.txt" "$E/msg-run12-fix.txt" cf1de889b $FIX
say "run12-static done; exit record $(ls -t "$E"/run12-static.exit.* 2>/dev/null | head -1) = $(cat "$(ls -t "$E"/run12-static.exit.* 2>/dev/null | head -1)" 2>/dev/null)"
