#!/usr/bin/env bash
# Builds the reference image pack's pinned guest image and records its digest.
#
# The build context is the sealed weight closure itself, so the only thing that
# can enter the image from outside its pinned base is a file whose digest the
# lock declared before it was fetched. Nothing else in this repository, and
# nothing else on this host, is reachable from the build.
#
# FAIL CLOSED. A closure that has not been fetched, a closure whose byte count
# does not match the lock, or a build that does not produce a digest is a
# failure, never a skip. The digest this prints is the closure pin every recipe
# and every gate record names.
#
# Usage: bash scripts/build-factory-image-guest.sh [--out <receipt path>] [--seal]
#
# `--seal` writes the resulting image digest and its observed distribution list
# back into src/factory/reference-image/sdxl-lock.json. A container image digest
# is not reproducible from its inputs, so the lock records what was built rather
# than deriving it; sealing is therefore an explicit step and a reviewable diff.
set -uo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
IMAGE_NAME="${EZCORP_FACTORY_IMAGE_GUEST_NAME:-localhost/ezcorp-reference-image}"
OUT=""
SEAL=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:-}"; shift 2 ;;
    --seal) SEAL=1; shift ;;
    *) echo "usage: $0 [--out <receipt path>] [--seal]" >&2; exit 2 ;;
  esac
done

fail() { echo "image guest build: $*" >&2; exit 1; }

command -v podman >/dev/null 2>&1 || fail "podman is not available"

# The MODEL section only. The guest image digest this build produces is what the
# full lock requires, so parsing the whole lock here would mean a first build
# could never run. The model section is still validated in full.
read -r CLOSURE EXPECTED_BYTES REVISION < <(
  cd "$REPO_ROOT" && PATH="/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH" bun -e '
    const { referenceImageModelDocument, sdxlClosureDirectoryFor } = await import("./src/factory/reference-image/model-lock.ts");
    const model = referenceImageModelDocument();
    const bytes = model.files.reduce((total, file) => total + file.bytes, 0);
    process.stdout.write(`${sdxlClosureDirectoryFor(model)} ${bytes} ${model.revision}\n`);
  '
) || fail "could not read the reference image model lock"

[ -n "$CLOSURE" ] || fail "the lock did not name a closure directory"
[ -d "$CLOSURE" ] || fail "the weight closure is absent; run 'bun scripts/fetch-factory-sdxl-weights.ts' first"

ACTUAL_BYTES=$(find "$CLOSURE" -type f -name '*' ! -name 'closure-receipt.json' -printf '%s\n' | awk '{total += $1} END {print total + 0}')
[ "$ACTUAL_BYTES" = "$EXPECTED_BYTES" ] \
  || fail "the closure holds $ACTUAL_BYTES bytes where the lock declares $EXPECTED_BYTES; refetch it"

echo "→ building $IMAGE_NAME from the closure at $CLOSURE"
# The closure directory is the whole build context, so nothing else in this
# repository or this host can reach the image.
podman build \
  --tag "$IMAGE_NAME:$REVISION" \
  --file "$REPO_ROOT/src/factory/reference-image/Containerfile" \
  "$CLOSURE" || fail "podman build failed"

DIGEST=$(podman image inspect "$IMAGE_NAME:$REVISION" --format '{{.Digest}}' 2>/dev/null)
case "$DIGEST" in
  sha256:*) : ;;
  *) fail "podman did not report an image digest for $IMAGE_NAME:$REVISION" ;;
esac

# Read the closure through the interpreter the shared runner actually launches,
# never through a path this script chose. Reading it through a different
# interpreter is how an image whose launched python has no torch passed once.
DISTRIBUTIONS=$(podman run --rm --network=none --entrypoint= "$IMAGE_NAME:$REVISION" \
  /usr/local/bin/python3 -c 'import importlib.metadata as m,json;print(json.dumps(sorted({f"{d.metadata[chr(78)+chr(97)+chr(109)+chr(101)]}=={d.version}" for d in m.distributions() if d.metadata["Name"]})))') \
  || fail "could not read the built image's importable closure"

# The generation runtime must be importable from the launched interpreter. An
# image that builds but cannot import torch is a failure here, not at the first
# attempt an hour later.
RUNTIME=$(podman run --rm --network=none --entrypoint= "$IMAGE_NAME:$REVISION" \
  /usr/local/bin/python3 -c 'import json,sys,torch,diffusers;print(json.dumps({"python":"%d.%d.%d"%sys.version_info[:3],"torch":torch.__version__,"diffusers":diffusers.__version__}))') \
  || fail "the launched interpreter of $IMAGE_NAME:$REVISION cannot import the generation runtime"

TESSERACT=$(podman run --rm --network=none --entrypoint= "$IMAGE_NAME:$REVISION" \
  /bin/sh -c 'tesseract --version 2>&1 | head -1') || fail "the built image has no working OCR engine"

RECEIPT=$(cat <<EOF
{
  "schemaVersion": "factory.reference-image-guest-image.v1",
  "image": "$IMAGE_NAME@$DIGEST",
  "tag": "$IMAGE_NAME:$REVISION",
  "digest": "$DIGEST",
  "modelRevision": "$REVISION",
  "closure": "$CLOSURE",
  "closureBytes": $ACTUAL_BYTES,
  "ocrEngine": "$TESSERACT",
  "runtime": $RUNTIME,
  "distributions": $DISTRIBUTIONS,
  "builtAt": "$(date -Is)"
}
EOF
)
if [ -n "$OUT" ]; then
  mkdir -p "$(dirname "$OUT")" || fail "could not create the receipt directory"
  printf '%s\n' "$RECEIPT" > "$OUT" || fail "could not write the receipt"
fi
printf '%s\n' "$RECEIPT"

if [ "$SEAL" -eq 1 ]; then
  printf '%s\n' "$RECEIPT" | PATH="/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH" bun -e '
    const receipt = JSON.parse(await Bun.stdin.text());
    const path = "src/factory/reference-image/sdxl-lock.json";
    const lock = await Bun.file(path).json();
    lock.runtime.guestImage = receipt.image;
    lock.runtime.distributions = [...receipt.distributions].sort();
    lock.runtime.pythonVersion = receipt.runtime.python;
    await Bun.write(path, `${JSON.stringify(lock, undefined, 2)}\n`);
    process.stdout.write(`sealed ${receipt.image} and ${receipt.distributions.length} distribution(s) into ${path}\n`);
  ' || fail "could not seal the built image into the lock"
fi

echo "✓ built $IMAGE_NAME@$DIGEST" >&2
