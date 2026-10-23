#!/usr/bin/env bash
# pull-judge.test.sh (the user's run-13 ruling, option (a)): exactly one Docker Hub pull is allowed, the exempt ingress nginx by digest.
# The judge passes when every image the node holds at the end that it did not hold after the proof image's load is that digest, and
# every kubelet pull event names that digest (an "already present" event pulls nothing); it reds any other new image or pull event, a
# missing final record when the node was made, and passes with a note when no node was made; after a run whose step 6 is complete
# it requires the allowed digest in the node. The node records are run 11's, real.
set -u
J=evidence/w4h-35/bin/pull-judge.py
R11=evidence/w4h-35/proof-run11-20261017T1305Z/node-images-after.json
NGINX=docker.io/library/nginx@sha256:2f4e10193b0c4f61472245e9d26cea78e7df7af266c7e7cf5e67353ee2731b51
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; fail=0; n=0
check() { n=$((n + 1)); local want=$1 label=$2; python3 -I "$J" "$T/p" "$NGINX" > "$T/out" 2>&1; local got=$?; [ "$got" = "$want" ] || { echo "FAIL: $label: want $want got $got"; cat "$T/out"; fail=1; }; }
setup() { rm -rf "$T/p"; mkdir -p "$T/p"; cp "$R11" "$T/p/node-images-after.json"; }
final_plus() { python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); d["images"]+= [{"id": "sha256:" + sys.argv[3] * 64, "repoTags": [], "repoDigests": [sys.argv[2]]}]; json.dump(d, open(sys.argv[4], "w"))' "$T/p/node-images-after.json" "$1" "$2" "$T/p/node-images-final.json"; }
events() { python3 -I -c 'import json,sys; json.dump({"items": [{"reason": r, "message": m} for r, m in zip(sys.argv[2::2], sys.argv[3::2])]}, open(sys.argv[1], "w"))' "$T/p/node-pull-events.json" "$@"; }
setup; cp "$T/p/node-images-after.json" "$T/p/node-images-final.json"; events Pulled 'Container image "localhost/w4h35-factory@sha256:abc" already present on machine'; check 0 "no new image, an already-present event"
setup; final_plus "$NGINX" a; events Pulling "Pulling image \"$NGINX\"" Pulled "Successfully pulled image \"$NGINX\" in 3.2s"; check 0 "the allowed nginx pulled"
setup; final_plus "$NGINX" a; events Failed "Failed to pull image \"$NGINX\": rpc error"; check 0 "the allowed nginx pull failed (still the one allowed pull)"
setup; final_plus "docker.io/library/busybox@sha256:$(printf 'b%.0s' $(seq 64))" b; events; check 1 "another new image in the node"
setup; cp "$T/p/node-images-after.json" "$T/p/node-images-final.json"; events Pulling 'Pulling image "docker.io/library/nginx:latest"'; check 1 "a pull event of another reference (unpinned)"
setup; final_plus "$NGINX" a; check 1 "the events record is missing"
setup; events; check 1 "the final image record is missing while the node was made"
rm -rf "$T/p"; mkdir -p "$T/p"; check 0 "no node was made (no records at all)"
# team-lead point (3): after a run whose step 6 (ingress) is complete, the allowed digest must be in the node (an ingress ready without it = RED).
ingress() { printf '{"status": {"steps": [{"step": "ingress", "state": "%s"}]}}' "$1" > "$T/p/install-status.json"; }
setup; final_plus "$NGINX" a; events; ingress complete; check 0 "step 6 complete with the allowed nginx in the node"
setup; cp "$T/p/node-images-after.json" "$T/p/node-images-final.json"; events; ingress complete; check 1 "step 6 complete WITHOUT the allowed nginx in the node"
setup; cp "$T/p/node-images-after.json" "$T/p/node-images-final.json"; events; ingress failed; check 0 "step 6 not complete: the nginx not required here (the full-path judge reds it)"
# team-lead's run-13 ruling: the stopped wave's designed failure. The driver names its absent canary image in proof/wave-absent-ref.txt;
# only that exact localhost/...@sha256:0...01 reference may show FAILED pull attempts (Pulling, Failed, BackOff, ErrImagePull,
# ImagePullBackOff); a successful pull of it, the ref in the node's final images, its events without the file, or a file whose ref is not
# the driver's form is RED.
CANARY="localhost/w4h35-factory@sha256:$(printf '0%.0s' $(seq 63))1"
canary_events() { events Pulling "Pulling image \"$CANARY\"" Failed "Failed to pull image \"$CANARY\": failed to pull and unpack image" BackOff "Back-off pulling image \"$CANARY\"" "$@"; }
setup; cp "$T/p/node-images-after.json" "$T/p/node-images-final.json"; echo "$CANARY" > "$T/p/wave-absent-ref.txt"; canary_events; check 0 "the canary's failed attempts, named by the driver"
setup; cp "$T/p/node-images-after.json" "$T/p/node-images-final.json"; echo "$CANARY" > "$T/p/wave-absent-ref.txt"; canary_events Pulled "Successfully pulled image \"$CANARY\" in 1s"; check 1 "the canary pulled successfully"
setup; final_plus "$CANARY" c; echo "$CANARY" > "$T/p/wave-absent-ref.txt"; canary_events; check 1 "the canary in the node's final images"
setup; cp "$T/p/node-images-after.json" "$T/p/node-images-final.json"; canary_events; check 1 "the canary's events without the driver's file"
setup; cp "$T/p/node-images-after.json" "$T/p/node-images-final.json"; echo "localhost/w4h35-factory@sha256:$(printf 'a%.0s' $(seq 64))" > "$T/p/wave-absent-ref.txt"; events Pulling "Pulling image \"localhost/w4h35-factory@sha256:$(printf 'a%.0s' $(seq 64))\""; check 1 "a file whose ref is not the driver's form"
setup; cp "$T/p/node-images-after.json" "$T/p/node-images-final.json"; NL="docker.io/library/w4h35@sha256:$(printf '0%.0s' $(seq 63))1"; echo "$NL" > "$T/p/wave-absent-ref.txt"; events Failed "Failed to pull image \"$NL\": not found"; check 1 "a file naming a non-localhost ref"
[ "$fail" = 0 ] && echo "pull-judge.test.sh: $n of $n pass"
exit "$fail"
