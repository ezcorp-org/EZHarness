#!/usr/bin/env bash
# run13-driver.test.sh [driver] [exemption] (team-lead ruling P2/P3 on the user's run-13 word, 2026-10-21): run 13 expects the FULL
# path (the kubelet pulls the one allowed nginx digest; C12 step 6 ready), so the driver writes no G8 record (no g8_record function or
# call, no "G8 steps 1 to 5 proven" line); the preinstall still skips that one reference (it is not staged before the install), read
# from the exemption record, whose new version names it as resolvable by the user's word; and no host Podman pull exists.
set -u
D=${1:-evidence/w4h-35/repro/kind-proof.sh}
X=${2:-evidence/w4h-35/repro/known-unresolvable.txt}
NGINX=docker.io/library/nginx@sha256:2f4e10193b0c4f61472245e9d26cea78e7df7af266c7e7cf5e67353ee2731b51
fail=0; n=0
ok() { n=$((n + 1)); [ "$1" = "$2" ] || { echo "FAIL: $3: want $2 got $1"; fail=1; }; }
grep -q 'g8_record' "$D"; ok $? 1 "no g8_record function or call"
grep -q 'G8 steps 1 to 5 proven' "$D"; ok $? 1 "no G8 record line"
grep -qE '(^|[^a-z_])podman (image )?pull\b|--pull\b' "$D"; ok $? 1 "no host Podman pull in the driver"
grep -qF '"$P/known-unresolvable.txt"; then exempt+=("$ref")' "$D"; ok $? 0 "the preinstall still skips the exempt reference"
[ "$(awk 'NR == 1 { print $1 }' "$X")" = "$NGINX" ]; ok $? 0 "the exemption record's first field is the one nginx digest"
grep -q 'resolvable by the user word of 2026-10-21 for run 13' "$X"; ok $? 0 "the exemption record names the user's word"
grep -q 'the pull is allowed only in the kind node' "$X"; ok $? 0 "the exemption record limits the pull to the kind node"
[ "$(grep -c . "$X")" = 1 ]; ok $? 0 "the exemption record holds exactly one reference"
# validator-8 / team-lead v3 (1): the wave code reaches proof.exit. step_wave returns 79 unless the wave command exits 0 AND the wave
# stopped (the forced failure's expected outcome; a stopped wave exits 0, fleet-cli.ts:61-71); step_all returns the wave code.
eval "$(sed -n '/^step_wave() {/,/^}/p' "$D")"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; P=$T; W=$T; REV=r; TENANT=tenant-35
pg_env() { :; }; stores_dir() { :; }; mark() { echo "step $*" >> "$T/proof.log"; }; log() { echo "$*" >> "$T/proof.log"; }
fleetcmd() { case "$1 $2" in "upgrade register") echo '{}' ;; "upgrade wave") echo "$WAVE_OUT"; return "$WAVE_RC" ;; *) echo '{}' ;; esac; }
WAVE_RC=0 WAVE_OUT='{"wave": {"state": "stopped", "rolledBack": ["tenant-35"], "failure": {"code": "x"}}}'; step_wave 2> /dev/null; ok $? 0 "a stopped wave, command exit 0"
WAVE_RC=0 WAVE_OUT='{"wave": {"state": "completed", "rolledBack": [], "failure": null}}'; step_wave 2> /dev/null; ok $? 79 "the wave completed (it did not stop)"
WAVE_RC=1 WAVE_OUT='{"wave": {"state": "stopped"}}'; step_wave 2> /dev/null; ok $? 79 "the wave command failed"
WAVE_RC=0 WAVE_OUT='not json'; step_wave 2> /dev/null; ok $? 79 "no readable wave result"
awk '/^step_all\(\) \{/,/^}/' "$D" | grep -q '\[ "\$wave" = 0 \] || return "\$wave"'; ok $? 0 "step_all returns the wave code"
# team-lead's run-13 ruling (a): the wave names its absent canary for the pull judge, from its one variable, in the driver's form.
rm -f "$T/wave-absent-ref.txt"; WAVE_RC=0 WAVE_OUT='{"wave": {"state": "stopped"}}'; step_wave 2> /dev/null
ok "$(cat "$T/wave-absent-ref.txt" 2> /dev/null)" "localhost/w4h35-factory@sha256:$(printf '0%.0s' $(seq 63))1" "step_wave writes the absent canary ref to wave-absent-ref.txt"
[ "$fail" = 0 ] && echo "run13-driver.test.sh: $n of $n pass ($D, $X)"
exit "$fail"
