#!/usr/bin/env bash
# hosted-builder-leg.sh <rev> [<context dir>]: build deploy/factory/Dockerfile with the HOSTED builder, not the host's.
# w00 copy (integrator-5, 2026-10-23) of w4h-35/hosted-builder/hosted-builder-leg.sh 6593753f585fee06 (v3: one Dockerfile choice, passed in):
# the repo default is the integration worktree (a shared tool names no owner folder) and the image tag and temp prefix are neutral.
# Why (W4H-35, ci 39956956620): the job "Factory image under shipped isolation" runs on ubuntu-latest, whose Podman 4.9.3 /
# Buildah 1.33 refused `ADD --checksum`; the host's Podman 5.8.7 accepted it, so the hold and run 13 built green.
# Guards, each RED by name and before any build:
#  G1 the builder image reports exactly HB_PODMAN (the version the runner image readme lists; re-read it when the runner image moves);
#  G2 ci.yml at <rev> still runs that job on HB_RUNS_ON (a changed runner means a changed builder: re-pin, never guess);
#  G3 every base image is the host's image for the Dockerfile's pinned digest (same image id after save/load); nothing is pulled.
# The build runs inside the builder container on vfs storage (--privileged inside a rootless podman: no host privilege), from a
# git-archive context of <rev> (or <context dir> for the leg's own tests). Exit: the build's exit; 3 = a guard is red.
set -uo pipefail
HB_IMAGE=${HB_IMAGE:-localhost/w00-hosted-builder:podman-4.9.3}
HB_PODMAN=${HB_PODMAN:-4.9.3}
HB_RUNS_ON=${HB_RUNS_ON:-ubuntu-latest}
HB_JOB="Factory image under shipped isolation"
REPO=${HB_REPO:-/home/<USER>/work/EZCorp/EZHarness-worktrees/composable-factory-platform/.worktrees/w00-integration}
REV=${1:?rev}; CTXARG=${2:-}
red() { echo "hosted-builder-leg RED: $*"; exit 3; }
H=$(git -C "$REPO" rev-parse --verify "$REV^{commit}") || red "no commit $REV"
v=$(podman run --rm --pull=never "$HB_IMAGE" podman --version 2>&1) || red "G1 builder image $HB_IMAGE does not run: $v"
[ "$v" = "podman version $HB_PODMAN" ] || red "G1 builder reports '$v', the hosted job uses Podman $HB_PODMAN"
ro=$(git -C "$REPO" show "$H:.github/workflows/ci.yml" | awk -v j="    name: $HB_JOB" '$0==j{f=1;next} f&&/^    runs-on:/{print $2; exit} f&&/^  [a-z]/{exit}')
[ "$ro" = "$HB_RUNS_ON" ] || red "G2 ci.yml at ${H:0:12} runs '$HB_JOB' on '${ro:-<none>}', the pinned builder is for $HB_RUNS_ON"
WORK=$(mktemp -d /tmp/w00-hb.XXXXXX); trap 'rm -rf "$WORK"' EXIT
# The Dockerfile is chosen ONCE, here, and the same relative path is built inside the builder: a repo tree also has a root
# Dockerfile (the dev image), which the leg must never build (W4H-35 session 11: the inner fallback picked it, exit 125).
if [ -n "$CTXARG" ]; then CTX=$CTXARG; else CTX=$WORK/ctx; mkdir "$CTX"; git -C "$REPO" archive "$H" | tar -x -C "$CTX"; fi
DFREL=deploy/factory/Dockerfile; [ -f "$CTX/$DFREL" ] || { [ -n "$CTXARG" ] && DFREL=Dockerfile; }
DF=$CTX/$DFREL; [ -f "$DF" ] || red "no $DFREL in the context $CTX"
args=(); n=0
while read -r name ref; do n=$((n+1))
  id=$(podman image inspect --format '{{.Id}}' "$ref" 2>/dev/null) || red "G3 base $ref is not on the host (no pull)"
  podman save --format docker-archive -o "$WORK/base$n.tar" "$id" >/dev/null 2>&1 || red "G3 cannot save $ref"
  echo "$n $name $id" >> "$WORK/bases.txt"; args+=(--build-arg "$name=localhost/hb-base$n")
done < <(sed -nE 's/^ARG ([A-Z_]*IMAGE)=([^ ]+@sha256:[0-9a-f]{64})$/\1 \2/p' "$DF")
lit=$(grep -nE '^FROM +[^$ ]+' "$DF" | grep -vE '^[0-9]+:FROM +localhost/' || true)
[ -z "$lit" ] || red "G3 a literal FROM cannot be mapped to a host image: $lit"
echo "hosted-builder-leg: builds $DFREL of the context $([ -n "$CTXARG" ] && echo "$CTX (given)" || echo "git archive ${H:0:12}"); ci.yml read at ${H:0:12}; builder '$v', runs-on $ro, $n base image(s):"; cat "$WORK/bases.txt" 2>/dev/null
podman run --rm --privileged --pull=never -v "$WORK:/in:ro" -v "$CTX:/ctx:ro" "$HB_IMAGE" bash -c '
  set -e; while read -r n name id; do podman --storage-driver=vfs load -q -i /in/base$n.tar >/dev/null
    got=$(podman --storage-driver=vfs image inspect --format "{{.Id}}" "$id"); [ "$got" = "$id" ] || { echo "G3 base $n id $got != $id"; exit 3; }
    podman --storage-driver=vfs tag "$id" localhost/hb-base$n; done < /in/bases.txt
  df=/ctx/$1; shift
  exec podman --storage-driver=vfs build --pull=never --isolation=chroot -f "$df" "$@" -t localhost/hb-probe /ctx' _ "$DFREL" "${args[@]}"
rc=$?; echo "hosted-builder-leg: build exit $rc"; exit $rc
