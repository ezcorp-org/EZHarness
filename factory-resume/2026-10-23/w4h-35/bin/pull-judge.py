#!/usr/bin/env python3
# pull-judge.py <proof dir> <allowed ref> (the user's run-13 ruling, option (a), 2026-10-21): exactly ONE Docker Hub pull is allowed in
# run 13, the exempt ingress nginx by its digest (the product's IfNotPresent pull by the kubelet in the kind node). Reads the driver's
# node records: node-images-after.json (crictl, after the proof image's load and tag), node-images-final.json and node-pull-events.json
# (crictl and the cluster's events, recorded before the teardown). Exit 0 PASS: every image new since the load is the allowed digest,
# and every pull event ("Pulling image", "Successfully pulled image", "Failed to pull image") names it. Exit 1 RED: any other new
# image or pull, or a missing record once the node was made; and (team-lead point 3) after a run whose C12 step 6 (ingress) is
# complete (install-status.json), the allowed digest must be in the node. No records at all = no node was made (PASS, noted).
import json, os, re, sys

# team-lead's run-13 ruling: the stopped wave's designed failure. The driver names its absent canary image (kind-proof.sh step_wave) in
# proof/wave-absent-ref.txt; only that exact localhost reference with the all-zero-then-1 digest may show FAILED pull attempts.
CANARY_FORM = re.compile(r"^localhost/[a-z0-9._/-]+@sha256:0{63}1$")
CANARY_REASONS = {"Pulling", "Failed", "BackOff", "ErrImagePull", "ImagePullBackOff"}


def refs(path):
    return {img["id"]: set(img.get("repoDigests") or []) | set(img.get("repoTags") or []) for img in json.load(open(path))["images"]}


def main(proof, allowed):
    files = {k: os.path.join(proof, f"node-{k}.json") for k in ("images-after", "images-final", "pull-events")}
    present = {k: os.path.isfile(p) for k, p in files.items()}
    if not any(present.values()):
        print("pull judge: PASS: no node records (no node was made), so no node pull")
        return 0
    missing = [k for k, ok in present.items() if not ok]
    if missing:
        print(f"pull judge: RED: missing node record(s): {', '.join(missing)}")
        return 1
    after, final = refs(files["images-after"]), refs(files["images-final"])
    new = {i: r for i, r in final.items() if i not in after}
    other_images = sorted(" ".join(sorted(r)) or i for i, r in new.items() if r != {allowed})
    canary_file = os.path.join(proof, "wave-absent-ref.txt")
    canary = open(canary_file).read().strip() if os.path.isfile(canary_file) else None
    if canary is not None and not CANARY_FORM.match(canary):
        print(f"pull judge: RED: wave-absent-ref.txt names {canary!r}, not the driver's localhost/...@sha256:0...01 form")
        return 1
    pulled, canary_bad = [], []
    for e in json.load(open(files["pull-events"])).get("items", []):
        m = re.match(r'(Pulling image|Successfully pulled image|Failed to pull image|Back-off pulling image) "([^"]+)"', e.get("message") or "")
        if not m:
            continue
        kind, ref = m.groups()
        if canary is not None and ref == canary:
            if kind == "Successfully pulled image" or e.get("reason") not in CANARY_REASONS:
                canary_bad.append(f"{e.get('reason')}: {kind}")
            continue
        if kind != "Back-off pulling image":
            pulled.append(ref)
    if canary_bad:
        print(f"pull judge: RED: the wave's absent canary {canary} was not only a failed pull: {canary_bad}")
        return 1
    if canary is not None and any(canary in r for r in final.values()):
        print(f"pull judge: RED: the wave's absent canary {canary} is in the node's final images")
        return 1
    other_pulls = sorted({p for p in pulled if p != allowed})
    try:
        steps = {e.get("step"): e.get("state") for e in (json.load(open(os.path.join(proof, "install-status.json"))).get("status") or {}).get("steps") or []}
    except (OSError, ValueError):
        steps = {}
    if steps.get("ingress") == "complete" and not any(allowed in r for r in final.values()):
        print(f"pull judge: RED: step 6 (ingress) is complete but {allowed} is not in the node")
        return 1
    if other_images or other_pulls:
        print(f"pull judge: RED: new images other than the allowed one: {other_images}; pull events of other references: {other_pulls}")
        return 1
    print(f"pull judge: PASS: new images {[sorted(r) for r in new.values()]}; pull events {len(pulled)}, all of {allowed}" + (f"; the wave's absent canary {canary}: failed attempts only" if canary else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
