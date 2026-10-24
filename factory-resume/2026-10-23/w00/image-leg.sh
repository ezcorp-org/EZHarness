#!/usr/bin/env bash
# image-leg.sh <rev> <image: full|fullnocache|dev|test|factory|boot>: one container-image leg of a merge hold, built from a CLEAN
# snapshot of <rev> (`git archive`, the committed files only, as the hosted checkout has them: no ignored dist/, no node_modules),
# never from a worktree (W4G-1: a worktree build passed only because ignored dist/ folders were copied in). Commands as the owner
# documented them (w4f-3, 2026-10-01). Tags are localhost/integrator3-img-<image>:<rev12>; this script removes only its own tags
# and containers, and never prunes (other sessions' images are not ours to delete).
set -uo pipefail
REV=${1:?rev} IMG=${2:?image}
REPO=/home/<USER>/work/EZCorp/EZHarness-worktrees/composable-factory-platform/.worktrees/w00-integration
H=$(git -C "$REPO" rev-parse "$REV") || exit 2; S=${H:0:12}
CTX=$(mktemp -d /tmp/integrator3-imgctx.XXXXXX); trap 'rm -rf "$CTX"' EXIT
git -C "$REPO" archive "$H" | tar -x -C "$CTX"
echo "context = git archive $H: $(find "$CTX" -type f | wc -l) files; dist dirs under packages: $(find "$CTX/packages" -type d -name dist | wc -l)"
CREATED=$(date -u +%Y-%m-%dT%H:%M:%SZ); P=localhost/integrator3-img
show() { podman image inspect --format "image $1 id {{.Id}} digest {{.Digest}}" "$1"; }
# build_own <podman build args...> (team-lead's queued item 1, ledger 74c, 2026-10-17; v2 after validator-8's refusal of v1): a multi-stage
# build leaves its builder stage untagged ("dangling"), and removing the final tag does not remove it (ten such images, 3.4-6 GB each, were
# found on the host). Ownership (the image-ownership rule, plan-gate.md): an id is removed only when it is BOTH new-dangling between the
# reads before and after this build AND printed by this build as a stage line "--> <12-hex>" (prefix of the full id). The build output is
# teed into the leg log and into a temp file OUTSIDE the build context (removed after the read). Any other new dangling id is logged
# "not this build: kept" and never removed. One `podman rmi <id>` per id, no force, the full output printed into the leg log; never a
# prune. The build's own exit code is returned.
dangling() { podman images -q --no-trunc -f dangling=true | sort -u; }
build_own() { local before after id h mine rc out; out=$(mktemp /tmp/integrator3-buildout.XXXXXX); before=$(dangling)
  podman build "$@" 2>&1 | tee "$out"; rc=${PIPESTATUS[0]}; after=$(dangling)
  mine=$(sed -nE 's/^--> ([0-9a-f]{12})[[:space:]]*$/\1/p' "$out" | sort -u); rm -f "$out"
  for id in $(comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$after")); do h=${id#sha256:}
    if grep -qxF -- "${h:0:12}" <<< "$mine"; then
      echo "image-leg: removing this build's dangling stage $id"; podman rmi "$id" 2>&1; echo "image-leg: podman rmi $id exit=$?"
    else echo "image-leg: new dangling $id: not this build: kept"; fi; done
  return $rc; }
case "$IMG" in
  full|fullnocache)
    t=$P-production:$S; nc=; [ "$IMG" = fullnocache ] && { nc=--no-cache; t=$P-production-nocache:$S; }
    build_own $nc -f "$CTX/Dockerfile" --build-arg "VERSION=ci-$S" --build-arg "REVISION=$H" --build-arg "CREATED=$CREATED" -t "$t" "$CTX" && show "$t"; rc=$?
    [ "$IMG" = fullnocache ] && podman rmi "$t" > /dev/null 2>&1; exit $rc ;;
  dev)
    t=$P-dev:$S; mkdir -p "$CTX/.dev-image-empty-context-probe"
    build_own -f "$CTX/Dockerfile.dev" --build-arg "EZCORP_BUILD_COMMIT=$H" --build-arg EZCORP_BUILD_SOURCE_STATE=dirty -t "$t" "$CTX" && show "$t" || exit 1
    ( cd "$CTX" && EZCORP_CONTAINER_ENGINE=podman VERIFY_DEV_PROVENANCE_IMAGE=$t VERIFY_DEV_PROVENANCE_REVISION=$H VERIFY_DEV_PROVENANCE_SOURCE_STATE=dirty \
        VERIFY_DEV_PROVENANCE_CONTEXT_DIR=.dev-image-empty-context-probe bash scripts/verify-dev-image-provenance.sh --no-build ); rc=$?
    podman rmi "$t" > /dev/null 2>&1; exit $rc ;;
  test)    t=$P-test:$S; build_own -f "$CTX/Dockerfile.test" -t "$t" "$CTX" && show "$t"; rc=$?; podman rmi "$t" > /dev/null 2>&1; exit $rc ;;
  factory) t=$P-factory:$S; build_own -f "$CTX/deploy/factory/Dockerfile" --build-arg "REVISION=$H" -t "$t" "$CTX" && show "$t"; rc=$?; podman rmi "$t" > /dev/null 2>&1; exit $rc ;;
  boot)    t=$P-production:$S; podman image exists "$t" || { echo "boot: build the full image first"; exit 1; }
           bash evidence/w00/tools/boot-smoke.sh "$t"; rc=$?; podman rmi "$t" > /dev/null 2>&1; exit $rc ;;
  *) echo "unknown image $IMG"; exit 2 ;;
esac
