#!/usr/bin/env bash
# The one way the proof scripts read an image's ID:
#
#   source scripts/lib/image-identity.sh
#   id="$(image_identity docker "$image")"
#
# For the packed candidate, the ID is the image CONFIG digest from its saved archive, once the engine's own `.Id` is
# shown to be that archive's image. Docker's classic image store reports the config digest as `.Id`; its containerd
# store (ubuntu-26.04's default) reports the manifest list's digest; Podman reports the config digest. Comparing raw
# `.Id` values across engines therefore depends on the store. Any other image keeps its engine `.Id`.
#
# The logic lives in scripts/production-image-artifact.ts (`identify`); this only calls it. The artifact directory is
# EZ_SHIPPING_CANDIDATE_ARTIFACT, default `.cache/production-candidate` (where CI downloads and loads the candidate).
image_identity() {
  bun scripts/production-image-artifact.ts identify "${EZ_SHIPPING_CANDIDATE_ARTIFACT:-.cache/production-candidate}" "$1" "$2"
}
