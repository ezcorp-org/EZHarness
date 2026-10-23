#!/usr/bin/env bash
# node-probe.sh (gated-flock only; on team-lead's word): confirm run 8's root cause on a real kind node, and record the REAL output
# shapes for the driver's stubs. A kind cluster w4h35-probe (pinned kind, node image, the /lib/modules shim) imports the pinned nginx
# image with the driver's own import line; the probe records crictl and ctr output (digests and names only) before and after
# `ctr images tag <tag> <repo>@sha256:<index digest>`, then removes everything it made, by name, and checks 0 left.
set -uo pipefail
E=evidence/w4h-35; R=$E/repro; D=$E/probe-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$D"; chmod 700 "$D"; L=$D/probe.log
KIND=/tmp/factory-tools/kind-0.32.0/kind; KUBECTL=/tmp/factory-tools/kubectl-1.37.1/kubectl; export KIND_EXPERIMENTAL_PROVIDER=podman
CLUSTER=w4h35-probe; NODE=$CLUSTER-control-plane; PODMAN_BIN=$(command -v podman)
NGINX=docker.io/library/nginx@sha256:2f4e10193b0c4f61472245e9d26cea78e7df7af266c7e7cf5e67353ee2731b51; NGINX_TAG=localhost/w4h35-probe-nginx:probe
W=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35; REV=$(git -C "$W" rev-parse HEAD); FACTORY_TAG=localhost/w4h35-probe-factory:${REV:0:12}   # a probe-only name, never the driver's
SCRATCH=$(mktemp -d /tmp/w4h35-scratch.XXXX)
say() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$L"; }
cleanup() {
  set +e
  "$KIND" delete cluster --name "$CLUSTER" > "$D/kind-delete.log" 2>&1
  [ -f "$D/kind-network-created-by-probe" ] && [ -z "$(podman ps -a -q --filter network=kind)" ] && podman network rm kind > /dev/null 2>&1 && say "cleanup: network kind removed (created by the probe)"
  podman image exists "$NGINX_TAG" && podman untag "$NGINX" "$NGINX_TAG"   # the name only: the pinned nginx image stays
  podman image exists "$FACTORY_TAG" && podman rmi "$FACTORY_TAG" > /dev/null 2>&1
  rm -rf -- "$SCRATCH"
  local left="containers=$(podman ps -a --format '{{.Names}}' | grep -c w4h35) networks=$(podman network ls --format '{{.Name}}' | grep -cE 'w4h35|^kind$') images=$(podman images --format '{{.Repository}}' | grep -c w4h35) volumes=$(podman volume ls --format '{{.Name}}' | grep -c w4h35) scratch=$(ls -d "$SCRATCH" 2> /dev/null | wc -l)"
  say "cleanup: left: $left"
  [ "$left" = "containers=0 networks=0 images=0 volumes=0 scratch=0" ] || { say "cleanup FAILED"; exit 70; }
  exit "$RESULT_RC"
}
# P4: every result starts "not run"; the exit value comes from the factory image's result (named values), nginx is recorded too.
RESULT_RC=79   # 79: the probe did not reach the factory result
declare -A RES=([factory]="not run" [nginx]="not run")
results() { for k in factory nginx; do say "result $k: ${RES[$k]}"; done; say "probe exit $RESULT_RC (0 tag resolves, same id; 81 tag refused; 82 not resolved after the tag; 83 image id differs; 84 already resolved before the tag; 79 not reached)"; }
trap 'results; cleanup' EXIT
for f in "$KIND=50030de23cf40a18505f20426f6a8506bedf13c6e509244bd1fa9463721b0f54" "$KUBECTL=65691ff77eb6fa44c908b77a1082c9f092c3b9733b5cefabec0d1104890e21a8"; do
  [ "$(sha256sum "${f%%=*}" | cut -d' ' -f1)" = "${f##*=}" ] || { say "STOP: ${f%%=*} hash"; RESULT_RC=3; exit 3; }; done
podman image exists "$NGINX" || { say "STOP: $NGINX not on the host (no pull)"; RESULT_RC=3; exit 3; }
NODE_IMAGE=$(grep -oE 'docker\.io/kindest/node:[^ ]+@sha256:[a-f0-9]{64}' "$W/deploy/factory/kubernetes/kind-proof.yml")
podman image exists "$NODE_IMAGE" || { say "STOP: the pinned kind node image $NODE_IMAGE is not on the host (no pull)"; RESULT_RC=3; exit 3; }
podman network exists kind || : > "$D/kind-network-created-by-probe"
sed '/^#/d' /home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35/deploy/factory/kubernetes/kind-proof.yml > "$D/kind-config.yml"
PATH="$R/kind-podman-shim:$PATH" REAL_PODMAN="$PODMAN_BIN" "$KIND" create cluster --name "$CLUSTER" --config "$D/kind-config.yml" --kubeconfig "$SCRATCH/kubeconfig" > "$D/kind-create.log" 2>&1 || { say "STOP: kind create failed (kind-create.log)"; RESULT_RC=1; exit 1; }
say "cluster $CLUSTER up"
# The factory image, built as the driver builds it: from a clean git archive of the head (removed by name at cleanup).
ctx=$(mktemp -d "$SCRATCH/ctx.XXXX"); git -C "$W" archive "$REV" | tar -x -C "$ctx"
podman build --pull=never -f "$ctx/deploy/factory/Dockerfile" --build-arg "REVISION=$REV" -t "$FACTORY_TAG" "$ctx" > "$D/factory-build.log" 2>&1 || { say "STOP: factory build failed"; RESULT_RC=1; exit 1; }
rm -rf -- "$ctx"; say "built $FACTORY_TAG (Podman's digest $(podman image inspect "$FACTORY_TAG" --format '{{.Digest}}'))"
podman tag "$NGINX" "$NGINX_TAG"
images_json() { podman exec "$NODE" crictl images --digests -o json; }   # RAW, unfiltered: the fixture for the driver's resolver test
# The image id (config digest) CRI reports for a reference, or "none" when it does not resolve (team-lead condition 2).
image_id() { podman exec "$NODE" crictl inspecti -o json "$1" 2> /dev/null | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["status"]["id"])' 2> /dev/null || echo none; }
probe() {  # <tag> <name for the records>
  local tag=$1 n=$2 repo=${1%:*} idx ref before tagrc after
  podman save --format oci-archive "$tag" | podman exec -i "$NODE" ctr --namespace=k8s.io images import --all-platforms --digests --snapshotter=overlayfs - > "$D/$n-ctr-import.log" 2>&1
  idx=$(podman exec "$NODE" ctr -n k8s.io images ls "name==$tag" | awk 'NR == 2 { print $3 }')
  say "$n: imported $tag; the node's index digest: $idx"
  podman exec "$NODE" ctr -n k8s.io images ls > "$D/$n-ctr-images-before.txt" 2>&1; images_json > "$D/$n-crictl-images-before.json" 2>&1
  ref=$repo@$idx
  local tagid_before refid_before tagid_after refid_after
  tagid_before=$(image_id "$tag"); refid_before=$(image_id "$ref")
  say "$n: image id before: tag $tagid_before; $ref $refid_before"
  podman exec "$NODE" crictl inspecti "$ref" > /dev/null 2>&1; before=$?
  say "$n: RED check, crictl inspecti $ref before the tag: exit $before"
  podman exec "$NODE" ctr -n k8s.io images tag "$tag" "$ref" > "$D/$n-ctr-tag.log" 2>&1; tagrc=$?
  say "$n: ctr images tag: exit $tagrc ($(tail -1 "$D/$n-ctr-tag.log" | cut -c1-160))"
  podman exec "$NODE" crictl inspecti "$ref" > /dev/null 2>&1; after=$?
  say "$n: GREEN check, crictl inspecti $ref after the tag: exit $after"
  tagid_after=$(image_id "$tag"); refid_after=$(image_id "$ref")
  say "$n: image id after: tag $tagid_after; $ref $refid_after; $( [ "$tagid_after" = "$refid_after" ] && [ "$tagid_after" = "$tagid_before" ] && echo same || echo DIFFERENT)"
  podman exec "$NODE" ctr -n k8s.io images ls > "$D/$n-ctr-images-after.txt" 2>&1; images_json > "$D/$n-crictl-images-after.json" 2>&1
  local same; [ "$tagid_after" = "$refid_after" ] && [ "$tagid_after" = "$tagid_before" ] && same=yes || same=no
  RES[$n]="before=$before tag=$tagrc after=$after same-id=$same"
  say "$n: result ${RES[$n]}"
  if [ "$n" = factory ]; then
    if [ "$before" = 0 ]; then RESULT_RC=84; elif [ "$tagrc" != 0 ]; then RESULT_RC=81; elif [ "$after" != 0 ]; then RESULT_RC=82; elif [ "$same" != yes ]; then RESULT_RC=83; else RESULT_RC=0; fi
  fi
}
probe "$FACTORY_TAG" factory
probe "$NGINX_TAG" nginx
