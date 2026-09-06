#!/usr/bin/env bash
# Run every required production-image shipping proof against one candidate.
#
# The caller builds and loads the candidate into both Docker and rootless
# Podman; this script verifies that exact image and retains one
# receipt directory per proof. It deliberately completes later proofs after a
# failed earlier proof so CI uploads all failure evidence before returning
# nonzero.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

: "${EZ_SHIPPING_CANDIDATE_IMAGE:?Set the exact candidate Docker image tag}"
: "${EZ_SHIPPING_RECEIPT_ROOT:?Set an empty owned receipt root}"

candidate="$EZ_SHIPPING_CANDIDATE_IMAGE"
receipt_root="$EZ_SHIPPING_RECEIPT_ROOT"
app_uid="${EZ_SHIPPING_APP_UID:-$(id -u)}"
app_gid="${EZ_SHIPPING_APP_GID:-$(id -g)}"
runner_uid="${EZ_SHIPPING_RUNNER_APP_UID:-1001}"

for value in "$app_uid" "$app_gid" "$runner_uid"; do
  [[ "$value" =~ ^[0-9]+$ ]] || { echo "Shipping runtime IDs must be numeric" >&2; exit 2; }
done
if [[ -e "$receipt_root" && -n "$(find "$receipt_root" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "Receipt root must be empty: $receipt_root" >&2
  exit 2
fi
mkdir -p "$receipt_root"
umask 077

docker image inspect "$candidate" >/dev/null
# The production app runs through Docker while its isolated extension runner
# uses rootless Podman. The workflow loads this candidate before this suite;
# prove both engines refer to the same immutable image ID.
docker_id="$(docker image inspect "$candidate" --format '{{.Id}}')"
podman_id="$(podman image inspect "$candidate" --format '{{.Id}}')"
canonical_docker_id="${docker_id#sha256:}"
canonical_podman_id="${podman_id#sha256:}"
[[ "$canonical_docker_id" == "$canonical_podman_id" ]] || {
  echo "Candidate image ID differs between Docker ($docker_id) and Podman ($podman_id)" >&2
  exit 1
}

printf 'candidate=%s\ndocker_image_id=%s\npodman_image_id=%s\napp_uid=%s\napp_gid=%s\nrunner_uid=%s\n' \
  "$candidate" "$docker_id" "$podman_id" "$app_uid" "$app_gid" "$runner_uid" > "$receipt_root/provenance.txt"

status=0
printf 'proof\texit\treceipt\n' > "$receipt_root/summary.tsv"
run_proof() {
  local proof="$1" timeout_value="$2"; shift 2
  local receipt="$receipt_root/$proof"
  local proof_status tee_status
  local -a pipe_status
  mkdir -p "$receipt"
  set +e
  timeout --foreground --kill-after=30s "$timeout_value" "$@" 2>&1 | tee "$receipt/controller.log"
  pipe_status=("${PIPESTATUS[@]}")
  proof_status="${pipe_status[0]}"
  tee_status="${pipe_status[1]}"
  set -e
  if [[ "$proof_status" -eq 0 && "$tee_status" -ne 0 ]]; then proof_status="$tee_status"; fi
  printf '%s\t%s\t%s\n' "$proof" "$proof_status" "$receipt" | tee -a "$receipt_root/summary.tsv"
  if [[ "$proof_status" -ne 0 ]]; then status=1; fi
}

common_runtime_env=(
  env
  "EZ_PRODUCTION_IMAGE=$candidate"
  "EZ_PRODUCTION_APP_UID=$app_uid"
  "EZ_PRODUCTION_APP_GID=$app_gid"
  "EZ_PRODUCTION_RUNNER_APP_UID=$runner_uid"
)

run_proof file-organizer 30m \
  env "EZ_RUNTIME_IMAGE=$candidate" "EZ_RUNTIME_APP_UID=$app_uid" "EZ_RUNTIME_APP_GID=$app_gid" \
  "EZ_RUNTIME_RUNNER_APP_UID=$runner_uid" "EZ_RUNTIME_RECEIPT_DIR=$receipt_root/file-organizer/runtime" \
  bash docs/validation/extension-v4-flows/runtime/replay-file-organizer-runtime.sh

# R1 deliberately waits through one real lease expiry after the app is killed
# while an owned build is paused. Its normal runtime is about seven minutes; fifteen
# minutes permits slower hosted runners while still making a hang finite.
for proof in runtime delivery revocation runtime-resources; do
  proof_timeout=15m
  [[ "$proof" == runtime-resources ]] && proof_timeout=25m
  run_proof "$proof" "$proof_timeout" \
    "${common_runtime_env[@]}" "EZ_PRODUCTION_RECEIPT_DIR=$receipt_root/$proof/runtime" \
    bash "scripts/verify-shipping-$proof.sh"
done

run_proof historical-upgrade 30m \
  env "VERIFY_UPGRADE_SKIP_BUILD=1" "VERIFY_UPGRADE_CANDIDATE_IMAGE=$candidate" \
  "VERIFY_UPGRADE_CANDIDATE_SOURCE=${VERIFY_UPGRADE_CANDIDATE_SOURCE:?Set the immutable candidate source SHA}" \
  "EZ_UPGRADE_APP_UID=$app_uid" "EZ_UPGRADE_APP_GID=$app_gid" \
  bash scripts/verify-docker-upgrade.sh

exit "$status"
