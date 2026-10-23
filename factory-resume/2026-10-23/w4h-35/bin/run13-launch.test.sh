#!/usr/bin/env bash
# run13-launch.test.sh [launcher] (team-lead's run-13 disk ruling): the launcher's clear-read judge ok() passes a read only with
# MemAvailable >= 15 GiB, lock=free gated=0 holders=0 yield=no, AND disk >= 127G (the build filesystem's free GB, appended to the
# read as " disk=<n>G"); it refuses 126G, a read with no disk field, 14.9 GiB, and a busy lock. Default launcher: bin/run13-launch.sh.
set -u
L=${1:-evidence/w4h-35/bin/run13-launch.sh}
eval "$(grep -m1 '^ok() {' "$L")" || { echo "FAIL: no one-line ok() in $L"; exit 1; }
fail=0; n=0
check() { n=$((n + 1)); ok "$2"; local got=$?; [ "$got" = "$1" ] || { echo "FAIL: $3: want $1 got $got"; fail=1; }; }
check 0 "mem=15.0 lock=free gated=0 holders=0 yield=no disk=127G" "15 GiB and 127G"
check 0 "mem=17.2 lock=free gated=0 holders=0 yield=no disk=140G" "more of both"
check 1 "mem=15.0 lock=free gated=0 holders=0 yield=no disk=126G" "126G is under the start floor"
check 1 "mem=15.0 lock=free gated=0 holders=0 yield=no" "a read with no disk field"
check 1 "mem=14.9 lock=free gated=0 holders=0 yield=no disk=130G" "14.9 GiB"
check 1 "mem=16.0 lock=busy gated=0 holders=0 yield=no disk=130G" "a busy lock"
# The user's run-13 ruling (option (a)): after proof.exit, judge_pulls runs bin/pull-judge.py on proof/ and on every try folder made by
# this launch (not on older ones); any other pull than the allowed nginx digest is red.
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; mkdir -p "$T/bin" "$T/proof" "$T/proof-try-old-75" "$T/logs"; cp evidence/w4h-35/bin/pull-judge.py "$T/bin/"
eval "$(grep -m1 '^NGINX_ALLOWED=' "$L")"; eval "$(grep -m1 '^judge_pulls() {' "$L")" || { echo "FAIL: no one-line judge_pulls() in $L"; exit 1; }
E=$T; say() { echo "$*" >> "$T/logs/say"; }; before=$(ls -d "$T"/proof-try-* 2> /dev/null)
img() { printf '{"images": [%s]}' "$1" > "$2"; }
img '{"id": "sha256:1", "repoDigests": ["localhost/w4h35-factory@sha256:x"]}' "$T/proof/node-images-after.json"
img "{\"id\": \"sha256:1\", \"repoDigests\": [\"localhost/w4h35-factory@sha256:x\"]}, {\"id\": \"sha256:2\", \"repoDigests\": [\"$NGINX_ALLOWED\"]}" "$T/proof/node-images-final.json"
echo '{"items": []}' > "$T/proof/node-pull-events.json"
cp "$T/proof/node-images-after.json" "$T/proof-try-old-75/node-images-after.json"   # an older try with a broken record: not this launch's
judge_pulls "$before"; check_rc=$?; n=$((n + 1)); [ "$check_rc" = 0 ] || { echo "FAIL: proof/ with only the allowed nginx: want 0 got $check_rc"; fail=1; }
mkdir -p "$T/proof-try-new-75"; cp "$T/proof/node-images-after.json" "$T/proof-try-new-75/"; echo '{"items": []}' > "$T/proof-try-new-75/node-pull-events.json"
img '{"id": "sha256:1", "repoDigests": ["localhost/w4h35-factory@sha256:x"]}, {"id": "sha256:3", "repoDigests": ["docker.io/library/busybox@sha256:b"]}' "$T/proof-try-new-75/node-images-final.json"
judge_pulls "$before"; check_rc=$?; n=$((n + 1)); [ "$check_rc" = 1 ] || { echo "FAIL: a new try of this launch with another pull: want 1 got $check_rc"; fail=1; }
# team-lead ruling P2 / validator-8 R2: after proof.exit the launcher runs bin/fullpath-judge.py on proof/ (G8 record, C12 steps 1-7,
# the stopped wave; its own test) and exits 1 on red. P3: host_pull_check reds a docker.io image the host holds after the run that it
# did not hold before.
# team-lead's run-13 ruling (b): after proof.exit the launcher runs ALL three judges (pull, host, full path), logs each verdict, and
# exits once, at the end, with 1 if any was red: no exit between the proof.exit line and the final `exit "$verdict"`.
tail_block=$(sed -n '/^say "proof.exit /,$p' "$L")
n=$((n + 1)); [ "$(printf '%s\n' "$tail_block" | grep -c -E '(^|[;{&|]) *exit( |$)')" = 1 ] && printf '%s\n' "$tail_block" | tail -1 | grep -qx 'exit "\$verdict"' || { echo "FAIL: the launcher exits before all three judges ran, or not once at the end with the verdict"; fail=1; }
for judge in 'judge_pulls "$tries_before"' 'host_pull_check "$E/logs/run13-host-images-before.txt"' 'python3 -I "$E/bin/fullpath-judge.py" "$E/proof" "$E/proof.exit"'; do
  n=$((n + 1)); printf '%s\n' "$tail_block" | grep -F "$judge" | grep -q 'verdict=1' || { echo "FAIL: a red of $judge does not set verdict=1"; fail=1; }
done
eval "$(grep -m1 '^host_pull_check() {' "$L")" || { echo "FAIL: no one-line host_pull_check() in $L"; exit 1; }
printf '%s\n' docker.io/kindest/node@sha256:k localhost/w4h35-factory@sha256:f > "$T/hb"; printf '%s\n' docker.io/kindest/node@sha256:k localhost/w4h35-factory@sha256:f localhost/w4h35-factory@sha256:g > "$T/ha"
host_pull_check "$T/hb" "$T/ha"; r=$?; n=$((n + 1)); [ "$r" = 0 ] || { echo "FAIL: only a new local image: want 0 got $r"; fail=1; }
echo "docker.io/library/nginx@sha256:2f4e" >> "$T/ha"; host_pull_check "$T/hb" "$T/ha"; r=$?; n=$((n + 1)); [ "$r" = 1 ] || { echo "FAIL: a new docker.io image on the host: want 1 got $r"; fail=1; }
n=$((n + 1)); printf '%s\n' "$tail_block" | grep '^say ' | tail -1 | grep -q '^say "run 13 judged: ' || { echo "FAIL: the launcher's last say is not the judgment"; fail=1; }
[ "$fail" = 0 ] && echo "run13-launch.test.sh: $n of $n pass ($L)"
exit "$fail"
