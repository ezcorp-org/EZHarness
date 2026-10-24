#!/usr/bin/env bash
# kind-proof-pg.test.sh [driver]: the driver's own step_pg and step_cleanup (extracted, never restated), with a stub own-pg.sh that,
# like the real one, sets an EXIT trap removing its database and exports PG_ENV_FILE and PG_CONTAINER, and a stub podman with state.
# 1 start: the proof network exists BEFORE own_pg_start, own_pg_start sees OWN_PG_NETWORK=w4h35-proof (team-lead ruling (A)), no
#   `network connect` runs (rootless pasta cannot join a bridge after start), the database is still up after step_pg, PG_CONTAINER
#   reaches the caller, and the EXIT trap is the proof's cleanup.
# 2 failed start: own_pg_start fails -> pg-container.log holds the container's state and log, step_pg returns 1, the trap is the cleanup.
# 3 cleanup: step_cleanup removes the proof network by name.
set -uo pipefail
DRIVER=${1:-evidence/w4h-35/repro/kind-proof.sh}
T=$(mktemp -d evidence/w4h-35/repro/.pgtest.XXXX)
cat > "$T/own-pg.sh" <<STUB
own_pg_start() {
  echo "net=\${OWN_PG_NETWORK:-unset} netexisted=\$([ -e "$T/net-w4h35-proof" ] && echo yes || echo no)" > "$T/start-seen"
  [ -e "$T/fail-start" ] && { echo "own-pg: STOP: start"; return 3; }
  touch "$T/pg-alive"; own_pg_stop() { rm -f "$T/pg-alive"; }; trap own_pg_stop EXIT
  export PG_ENV_FILE=$T/pg.env PG_CONTAINER=\$1; echo "own-pg: \$1 (stub)"
}
STUB
cat > "$T/podman-stub.sh" <<STUB
podman() {
  echo "podman \$*" >> "$T/calls"
  case "\$1 \$2" in
    "network exists") [ -e "$T/net-\$3" ];;
    "network create") touch "$T/net-\$3";;
    "network rm") rm -f "$T/net-\$3";;
    "network connect") echo 'Error: "pasta" is not supported: invalid network mode' >&2; return 125;;
    "ps -a") echo "w4h35-proof-pg Exited (1)";;
    "logs w4h35-proof-pg") echo "FATAL: stub";;
  esac
}
STUB
awk '/^step_pg\(\) \{/,/^\}/' "$DRIVER" | sed "s#evidence/w00/own-pg.sh#$T/own-pg.sh#" > "$T/step_pg.sh"
awk '/^step_cleanup\(\) \{/,/^\}/' "$DRIVER" > "$T/step_cleanup.sh"
[ -s "$T/step_pg.sh" ] && grep -q "$T/own-pg.sh" "$T/step_pg.sh" && [ -s "$T/step_cleanup.sh" ] || { echo "FAIL: step_pg, its own-pg source line, or step_cleanup not found"; rm -r "$T"; exit 1; }
run_pg() { T=$T bash -c '
  P=$T; PG=w4h35-proof-pg; PGNET=w4h35-proof
  log() { :; }; mark() { :; }; ip_on() { echo <IP>; }
  . "$T/podman-stub.sh"; . "$T/step_pg.sh"
  step_pg > /dev/null 2>&1; rc=$?
  echo "rc=$rc alive=$([ -e "$T/pg-alive" ] && echo yes || echo no) container=${PG_CONTAINER:-unset} $(cat "$T/start-seen" 2>/dev/null) connect=$(grep -c "network connect" "$T/calls") log=$(tr "\n" "|" < "$T/pg-container.log" 2>/dev/null) trap=$(trap -p EXIT | grep -o step_cleanup)"' 2>/dev/null; }
start=$(run_pg)
rm -f "$T/net-w4h35-proof" "$T/calls" "$T/pg-alive" "$T/start-seen" "$T/pg-container.log"; touch "$T/fail-start"
failed=$(run_pg)
touch "$T/net-w4h35-proof"; : > "$T/calls"
cleanup=$(T=$T bash -c '
  E=$T; P=$T; PG=w4h35-proof-pg; PGNET=w4h35-proof; NODE=w4h35-control-plane; CLUSTER=w4h35; FLEET=w4h35; TENANT=tenant-35
  ROOT=$T/root; RUNNER_ROOT=$T/runner; IMAGE=localhost/w4h35-factory:stub; KIND=true; STORAGE_NET=s; PLATFORM_NET=p
  log() { :; }; mark() { :; }; fleetcmd() { :; }; pg_env() { :; }; stores_dir() { return 1; }
  cleanup_residue() { echo "containers=0 volumes=0 networks=0 credentials=0 scratch=0"; }   # this case checks the proof network only
  . "$T/podman-stub.sh"; . "$T/step_cleanup.sh"
  ( step_cleanup > /dev/null 2>&1 )
  echo "network-rm=$(grep -c "^podman network rm w4h35-proof" "$T/calls") net-left=$([ -e "$T/net-w4h35-proof" ] && echo yes || echo no)"' 2>/dev/null)
echo "start:   $start"; echo "failed:  $failed"; echo "cleanup: $cleanup"
rm -r "$T"
ok=1
[ "$start" = "rc=0 alive=yes container=w4h35-proof-pg net=w4h35-proof netexisted=yes connect=0 log= trap=step_cleanup" ] || ok=0
[[ "$failed" == "rc=1 alive=no container=unset net=w4h35-proof netexisted=yes connect=0 log=w4h35-proof-pg Exited (1)|FATAL: stub| trap=step_cleanup" ]] || ok=0
[ "$cleanup" = "network-rm=1 net-left=no" ] || ok=0
[ "$ok" = 1 ] && { echo PASS; exit 0; }; echo FAIL; exit 1
