#!/usr/bin/env bash
# kind-proof-cluster.test.sh [driver]: the driver's own step_cluster (extracted, never restated) with a stub kind that records the
# podman it would run. Pass: `kind create cluster` sees the shim's podman first on PATH and REAL_PODMAN set to the real podman, so
# kind's /lib/modules mount is rewritten for this host (W4H-35 run 4: "statfs /lib/modules: no such file or directory").
set -uo pipefail
DRIVER=${1:-evidence/w4h-35/repro/kind-proof.sh}
T=$(mktemp -d evidence/w4h-35/repro/.clustertest.XXXX)
printf '#!/usr/bin/env bash\n[ "$1" = create ] && echo "podman=$(command -v podman) real=${REAL_PODMAN:-unset}" > "%s/kind-saw"\nexit 0\n' "$T" > "$T/kind"; chmod 700 "$T/kind"
awk '/^step_cluster\(\) \{/,/^\}/' "$DRIVER" > "$T/step_cluster.sh"
[ -s "$T/step_cluster.sh" ] || { echo "FAIL: step_cluster not found"; rm -r "$T"; exit 1; }
real=$(command -v podman)
marker_case() {  # <kind network exists before create: 0|1> -> marker written: yes|no
  rm -f "$T/kind-network-created-by-proof"
  T=$T DRIVER=$DRIVER NETEXISTS=$1 bash -c '
    W=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35; E=evidence/w4h-35; R=$E/repro; P=$T
    KIND=$T/kind; KUBECTL=true; CLUSTER=w4h35; NODE=w4h35-control-plane; NODEPORT=30443; INGRESS_PORT=39005; SOCKET=/run/user/1001/podman/podman.sock
    RUNNER_ROOT=$T/runner; SCRATCH=$T/scratch; mkdir -p "$SCRATCH"; KUBECONFIG_FILE=$SCRATCH/kubeconfig; IMAGE=localhost/w4h35-factory:stub
    eval "$(grep -E "^PODMAN_BIN=" "$DRIVER")"
    log() { :; }; mark() { :; }; need() { :; }; podman() { [ "$1 $2" = "network exists" ] && return $(( 1 - NETEXISTS )); return 0; }
    . "$T/step_cluster.sh"; step_cluster > /dev/null 2>&1'
  [ -e "$T/kind-network-created-by-proof" ] && echo yes || echo no
}
created=$(marker_case 0); existed=$(marker_case 1)
T=$T DRIVER=$DRIVER bash -c '
  W=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35; E=evidence/w4h-35; R=$E/repro; P=$T
  KIND=$T/kind; KUBECTL=true; CLUSTER=w4h35; NODE=w4h35-control-plane; NODEPORT=30443; INGRESS_PORT=39005; SOCKET=/run/user/1001/podman/podman.sock
  RUNNER_ROOT=$T/runner; SCRATCH=$T/scratch; mkdir -p "$SCRATCH"; KUBECONFIG_FILE=$SCRATCH/kubeconfig; IMAGE=localhost/w4h35-factory:stub
  eval "$(grep -E "^PODMAN_BIN=" "$DRIVER")"
  log() { :; }; mark() { :; }; need() { :; }; podman() { :; }
  . "$T/step_cluster.sh"; step_cluster > /dev/null 2>&1' 
saw=$(cat "$T/kind-saw" 2>/dev/null || echo "kind create not run")
rm -r "$T"
want="podman=evidence/w4h-35/repro/kind-podman-shim/podman real=$real"
echo "kind saw: $saw"; echo "want:     $want"
echo "marker when kind network was absent: $created (want yes); when present: $existed (want no)"
[ "$saw" = "$want" ] && [ "$created" = yes ] && [ "$existed" = no ] && { echo PASS; exit 0; }; echo FAIL; exit 1
