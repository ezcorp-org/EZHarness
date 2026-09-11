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
: "${VERIFY_UPGRADE_CANDIDATE_SOURCE:?Set the immutable candidate source SHA}"

candidate="$EZ_SHIPPING_CANDIDATE_IMAGE"
receipt_root="$EZ_SHIPPING_RECEIPT_ROOT"
app_uid="${EZ_SHIPPING_APP_UID:-$(id -u)}"
app_gid="${EZ_SHIPPING_APP_GID:-$(id -g)}"
runner_uid="${EZ_SHIPPING_RUNNER_APP_UID:-1001}"
source_revision="$VERIFY_UPGRADE_CANDIDATE_SOURCE"
selected_shard="${EZ_SHIPPING_SHARD:-local}"
expected_image_id="${EZ_SHIPPING_EXPECTED_IMAGE_ID:-}"

[[ "$source_revision" =~ ^[0-9a-f]{40}$ ]] || { echo "Candidate source must be a full 40-hex revision" >&2; exit 2; }

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
if [[ "$selected_shard" == local && -z "$expected_image_id" ]]; then
  expected_image_id="$docker_id"
else
  [[ -n "$expected_image_id" ]] || { echo "Set EZ_SHIPPING_EXPECTED_IMAGE_ID for a CI shard" >&2; exit 2; }
fi
expected_canonical_id="${expected_image_id#sha256:}"
[[ "$expected_canonical_id" =~ ^[0-9a-f]{64}$ ]] || { echo "Expected image ID must be a full sha256 image ID" >&2; exit 2; }
[[ "$canonical_docker_id" == "$expected_canonical_id" ]] || {
  echo "Candidate image ID differs from independently expected ID ($expected_image_id)" >&2
  exit 1
}

printf 'candidate=%s\nsource_revision=%s\nexpected_image_id=%s\ndocker_image_id=%s\npodman_image_id=%s\nshard=%s\napp_uid=%s\napp_gid=%s\nrunner_uid=%s\n' \
  "$candidate" "$source_revision" "$expected_image_id" "$docker_id" "$podman_id" "$selected_shard" "$app_uid" "$app_gid" "$runner_uid" > "$receipt_root/provenance.txt"

status=0
printf 'proof\texit\tstarted_at\tfinished_at\tduration_ms\treceipt\n' > "$receipt_root/summary.tsv"
run_proof() {
  local proof="$1" timeout_value="$2"; shift 2
  local receipt="$receipt_root/$proof"
  local proof_status tee_status started_at finished_at started_ms finished_ms duration_ms
  local -a pipe_status
  timestamp_for_ms() {
    local milliseconds="$1" seconds remainder
    seconds=$((milliseconds / 1000))
    remainder=$((milliseconds % 1000))
    printf '%s.%03dZ' "$(date -u -d "@$seconds" +%Y-%m-%dT%H:%M:%S)" "$remainder"
  }
  mkdir -p "$receipt"
  started_ms="$(date -u +%s%3N)"
  started_at="$(timestamp_for_ms "$started_ms")"
  set +e
  timeout --foreground --kill-after=30s "$timeout_value" "$@" 2>&1 | tee "$receipt/controller.log"
  pipe_status=("${PIPESTATUS[@]}")
  proof_status="${pipe_status[0]}"
  tee_status="${pipe_status[1]}"
  set -e
  if [[ "$proof_status" -eq 0 && "$tee_status" -ne 0 ]]; then proof_status="$tee_status"; fi
  finished_ms="$(date -u +%s%3N)"
  finished_at="$(timestamp_for_ms "$finished_ms")"
  duration_ms=$((finished_ms - started_ms))
  (( duration_ms >= 0 )) || { echo "System clock moved backwards during $proof" >&2; proof_status=1; duration_ms=0; }
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$proof" "$proof_status" "$started_at" "$finished_at" "$duration_ms" "$proof" | tee -a "$receipt_root/summary.tsv"
  if [[ "$proof_status" -ne 0 ]]; then status=1; fi
}

common_runtime_env=(
  env
  "EZ_PRODUCTION_IMAGE=$candidate"
  "EZ_PRODUCTION_APP_UID=$app_uid"
  "EZ_PRODUCTION_APP_GID=$app_gid"
  "EZ_PRODUCTION_RUNNER_APP_UID=$runner_uid"
)

selected_output="$(bun scripts/production-proof-plan.ts select "${EZ_SHIPPING_SHARD:-}")"
mapfile -t selected_proofs <<< "$selected_output"
for proof in "${selected_proofs[@]}"; do
  case "$proof" in
    file-organizer)
      run_proof file-organizer 30m env "EZ_RUNTIME_IMAGE=$candidate" "EZ_RUNTIME_APP_UID=$app_uid" "EZ_RUNTIME_APP_GID=$app_gid" "EZ_RUNTIME_RUNNER_APP_UID=$runner_uid" "EZ_RUNTIME_RECEIPT_DIR=$receipt_root/file-organizer/runtime" bash docs/validation/extension-v4-flows/runtime/replay-file-organizer-runtime.sh
      ;;
    embeddings|runtime|delivery|revocation|runtime-resources)
      proof_timeout=15m
      [[ "$proof" == runtime-resources ]] && proof_timeout=25m
      run_proof "$proof" "$proof_timeout" "${common_runtime_env[@]}" "EZ_PRODUCTION_RECEIPT_DIR=$receipt_root/$proof/runtime" bash "scripts/verify-shipping-$proof.sh"
      ;;
    historical-upgrade)
      run_proof historical-upgrade 30m env "VERIFY_UPGRADE_SKIP_BUILD=1" "VERIFY_UPGRADE_CANDIDATE_IMAGE=$candidate" "VERIFY_UPGRADE_CANDIDATE_SOURCE=$source_revision" "EZ_UPGRADE_APP_UID=$app_uid" "EZ_UPGRADE_APP_GID=$app_gid" "VERIFY_UPGRADE_RECEIPT_ROOT=$receipt_root/historical-upgrade/upgrade" bash scripts/verify-docker-upgrade.sh
      ;;
    legacy-adoption)
      run_proof legacy-adoption 35m env "VERIFY_LEGACY_ADOPTION_CANDIDATE_IMAGE=$candidate" "VERIFY_LEGACY_ADOPTION_CANDIDATE_IMAGE_ID=$podman_id" "VERIFY_LEGACY_ADOPTION_CANDIDATE_SOURCE=$source_revision" "VERIFY_LEGACY_ADOPTION_RECEIPT_DIR=$receipt_root/legacy-adoption/legacy" "EZ_LEGACY_ADOPTION_APP_UID=$app_uid" "EZ_LEGACY_ADOPTION_APP_GID=$app_gid" "EZ_PRODUCTION_RUNNER_APP_UID=$runner_uid" bash scripts/verify-legacy-adoption.sh
      ;;
    namespace)
      run_proof namespace 15m env "EZCORP_STAGE2_PROOF=1" "EZCORP_STAGE2_PROOF_IMAGE=$candidate" bash -c 'journalctl -k --no-pager -n 1 -o json | jq -e '\''.__CURSOR | strings | length > 0'\'' && exec bun test ./src/__tests__/mcp-netns-raw-socket-blocked.test.ts ./src/__tests__/mcp-stage2-ipv6-disabled.test.ts ./src/__tests__/mcp-stage2-conntrack-soak.test.ts'
      ;;
    *)
      echo "Unknown selected proof: $proof" >&2
      exit 2
      ;;
  esac
done

exit "$status"
