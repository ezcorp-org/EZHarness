#!/usr/bin/env bash
# kind-proof-cleanup.test.sh [driver]: the driver's own step_cleanup and cleanup_residue (extracted, never restated) against a
# stateful stub podman (a binary first on PATH: never the real engine). Cases:
#   pre-install: no teardown, the log says so; install started: teardown runs;
#   kind network created by the proof and free: removed, cleanup ok; one container attached: kept, cleanup a NAMED failure (exit 70);
#   own store pair, down ok: no fallback, cleanup ok; down refused: the fallback removes the pair and the folder, and the cleanup is
#   still a NAMED failure, logged as "down failed: ...; fallback removed N; left M" (team-lead ruling, run 7);
#   a try released by need() (RELEASED=1, exit 75): the build's own stage images are handled, then the whole proof/ moves to a
#   try-scoped folder after a hash list of every file (lesson 29); a normal end keeps proof/ in place.
set -uo pipefail
DRIVER=${1:-evidence/w4h-35/repro/kind-proof.sh}
T=$(mktemp -d evidence/w4h-35/repro/.cleanuptest.XXXX)
python3 -I - "$DRIVER" > "$T/fns.sh" <<'PYX'
import re, sys
lines = open(sys.argv[1]).read().split("\n"); out = []; i = 0
while i < len(lines):
    if re.match(r"^(step_cleanup|cleanup_residue|own_stage_images|remove_own_stage_images|archive_released_try)\(\) \{", lines[i]):
        while True:
            out.append(lines[i]); i += 1
            if lines[i - 1] == "}": break
    else: i += 1
print("\n".join(out))
PYX
grep -q '^step_cleanup()' "$T/fns.sh" || { echo "FAIL: step_cleanup not found"; rm -r "$T"; exit 1; }
cat > "$T/podman" <<'STUB'
#!/usr/bin/env bash
# State in $D: kindnet (the kind network), attached (a container on it), stores (the pair's containers up).
echo "podman $*" >> "$D/calls"
case "$1 $2" in
  "network exists") [ "$3" = kind ] && [ -e "$D/kindnet" ];;
  "network rm") [ "$3" = kind ] && rm -f "$D/kindnet"; exit 0;;
  "network ls") [ -e "$D/kindnet" ] && echo kind; exit 0;;
  "ps -a") case "$*" in *network=kind*) [ -e "$D/attached" ] && echo c1;; *project=w4h35-stores*) [ -e "$D/stores" ] && echo id1;; esac; exit 0;;
  "rm -f") rm -f "$D/stores"; exit 0;;
  *) exit 0;;
esac
STUB
chmod 700 "$T/podman"
run() {  # <install started> <kind marker+net> <attached> <stores: none|ok|refused>
  local d=$T/case-$1-$2-$3-$4; mkdir -p "$d/root"; : > "$d/root/fleet.json"; : > "$d/calls"
  [ "$1" = yes ] && : > "$d/install.json"; [ "$2" = yes ] && { : > "$d/kind-network-created-by-proof"; : > "$d/kindnet"; }; [ "$3" = yes ] && : > "$d/attached"
  [ "$4" != none ] && { : > "$d/stores-created-by-proof"; : > "$d/stores"; mkdir -p "$d/xdg/w4h35-stores.AAAA"; }
  D=$d STORES=$4 PATH=$T:$PATH XDG_RUNTIME_DIR=$d/xdg bash -c '
    E=$D; P=$D; PG=w4h35-proof-pg; PGNET=w4h35-proof; NODE=w4h35-control-plane; CLUSTER=w4h35; FLEET=w4h35; TENANT=tenant-35
    ROOT=$D/root; RUNNER_ROOT=$D/runner; IMAGE=localhost/w4h35-factory:stub; KIND=true; STORAGE_NET=w4h35-stores_default; PLATFORM_NET=p
    STORES_PROJECT=w4h35-stores; SCRATCH=; CTX=
    log() { echo "LOG $*" >> "$D/calls"; }; mark() { :; }; pg_env() { :; }; fleetcmd() { echo "fleetcmd $*" >> "$D/calls"; }
    stores_dir() { ls -d "$XDG_RUNTIME_DIR"/w4h35-stores.* 2> /dev/null; }
    stores_setup() { echo "stores_setup $*" >> "$D/calls"; if [ "$STORES" = ok ]; then rm -f "$D/stores"; rm -rf "$XDG_RUNTIME_DIR"/w4h35-stores.*; return 0; fi; echo "Credential directory must be generated directly below XDG_RUNTIME_DIR."; return 1; }
    . "$D/../fns.sh"; ( step_cleanup > /dev/null 2>&1 ); rc=$?
    echo "rc=$rc teardown=$(grep -c "^fleetcmd teardown" "$D/calls") nolog=$(grep -c "teardown: no installation" "$D/calls") kindrm=$(grep -c "^podman network rm kind" "$D/calls") fallback=$(grep -c "^podman rm -f -v id1" "$D/calls") folder=$(ls -d "$XDG_RUNTIME_DIR"/w4h35-stores.* > /dev/null 2>&1 && echo kept || echo gone) named=$(grep -c "cleanup FAILED" "$D/calls") downline=$(grep -c "down failed: Credential directory must be generated directly below XDG_RUNTIME_DIR.; fallback removed 1; left 0" "$D/calls")"' 2>/dev/null
}
a=$(run no no no none); b=$(run yes no no none); c=$(run yes yes no none); d=$(run yes yes yes none); e=$(run yes no no ok); f=$(run yes no no refused)
released() {  # <RELEASED value>: proof/ under its own evidence root, as in the driver
  local d=$T/released-$1; mkdir -p "$d/e/proof/pods" "$d/e/logs" "$d/root"; : > "$d/calls"
  echo one > "$d/e/proof/proof.log"; echo two > "$d/e/proof/pods/x.describe.txt"
  D=$d REL=$1 PATH=$T:$PATH bash -c '
    E=$D/e; P=$D/e/proof; RELEASED=$REL; PG=w4h35-proof-pg; PGNET=w4h35-proof; NODE=w4h35-control-plane; CLUSTER=w4h35; FLEET=w4h35
    ROOT=$D/root; RUNNER_ROOT=$D/runner; IMAGE=localhost/w4h35-factory:stub; KIND=true; STORAGE_NET=s; PLATFORM_NET=p; STORES_PROJECT=w4h35-stores; SCRATCH=; CTX=
    log() { echo "LOG $*" >> "$D/calls"; }; mark() { :; }; pg_env() { :; }; fleetcmd() { :; }; stores_dir() { return 1; }; stores_setup() { :; }
    . "$D/../fns.sh"; ( step_cleanup > /dev/null 2>&1 ); rc=$?
    a=$(ls -d "$E"/proof-try-*-75 2> /dev/null | head -1)
    echo "rc=$rc proof=$([ -d "$P" ] && echo kept || echo moved) try=$([ -n "$a" ] && echo yes || echo no) files=$([ -n "$a" ] && find "$a" -type f | wc -l || echo 0) listed=$([ -n "$a" ] && grep -c . "$E/logs/${a##*/}-premove-shas.txt" || echo 0) stage=$([ -n "$a" ] && [ -e "$a/stage-images.txt" ] && echo yes || { [ -e "$P/stage-images.txt" ] && echo yes || echo no; }) record=$(grep -c "released try archived" "$E/logs/released-tries.txt" 2> /dev/null || echo 0)"'
}
g=$(released 1); h=$(released "")
rm -r "$T"
echo "pre-install:              $a"; echo "install started:          $b"; echo "kind net free:            $c"; echo "kind net attached:        $d"; echo "stores down ok:           $e"; echo "stores down refused:      $f"
echo "released try:              $g"; echo "normal end:               $h"
[ "$a" = "rc=0 teardown=0 nolog=1 kindrm=0 fallback=0 folder=gone named=0 downline=0" ] \
  && [ "$b" = "rc=0 teardown=1 nolog=0 kindrm=0 fallback=0 folder=gone named=0 downline=0" ] \
  && [ "$c" = "rc=0 teardown=1 nolog=0 kindrm=1 fallback=0 folder=gone named=0 downline=0" ] \
  && [ "$d" = "rc=70 teardown=1 nolog=0 kindrm=0 fallback=0 folder=gone named=1 downline=0" ] \
  && [ "$e" = "rc=0 teardown=1 nolog=0 kindrm=0 fallback=0 folder=gone named=0 downline=0" ] \
  && [ "$f" = "rc=70 teardown=1 nolog=0 kindrm=0 fallback=1 folder=gone named=1 downline=1" ] \
  && [ "$g" = "rc=0 proof=moved try=yes files=5 listed=5 stage=yes record=1" ] \
  && [ "$h" = "rc=0 proof=kept try=no files=0 listed=0 stage=yes record=0" ] && { echo PASS; exit 0; }
echo FAIL; exit 1
