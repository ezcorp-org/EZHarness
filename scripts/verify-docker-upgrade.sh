#!/usr/bin/env bash
# End-to-end two-image upgrade verification.
#
# Simulates the real upgrade flow a self-hoster experiences when a new image
# lands on GHCR (manual pull or Watchtower):
#
#   1. Use the pinned previous image, building its exact source if absent.
#   2. Start container A against a fresh volume, wait for /api/ready = 200.
#   3. Record baseline state (DB entries, readiness body, version endpoint).
#   4. Stop container A (preserve the volume).
#   5. Build image B from the current committed source (not the worktree).
#   6. Start container B against A's volume.
#   7. Verify B boots cleanly, reports its new version, preserves A's data,
#      and takes a fresh pre-boot snapshot.
#   8. Stop B and attempt a DOWNGRADE back to A — document whether it works
#      (it does for compatible ranges, since migrate is idempotent DDL).
#
# Run:
#   bash scripts/verify-docker-upgrade.sh

set -euo pipefail
cd "$(dirname "$0")/.."

# 3ec53e is a retained historical v4 candidate, not a published release.
# Its committed source differs from the current candidate. This baseline
# tests compatible v4 state; the main-to-v4 proof covers explicit adoption.
PREVIOUS_SOURCE="${VERIFY_UPGRADE_PREVIOUS_SOURCE:-3ec53eaa66409a39d66b502f79d74139ec94dcf2}"
IMAGE_A="${VERIFY_UPGRADE_PREVIOUS_IMAGE:-localhost/ezcorp-extension-v4:audit-final-3ec53eaa}"
PREVIOUS_IMAGE_ID="${VERIFY_UPGRADE_PREVIOUS_IMAGE_ID:-8f722e76d30f7a4866eb61a2546af64da73f170a5cc9c23866f53ced660e40be}"
IMAGE_B="${VERIFY_UPGRADE_CANDIDATE_IMAGE:-ezcorp:upgrade-candidate}"
RUN_ID="$(openssl rand -hex 6)"
CONTAINER="ezcorp-upgrade-verify-${RUN_ID}"
VOLUME="ezcorp-upgrade-verify-data-${RUN_ID}"
RESTORE_VOLUME="ezcorp-upgrade-verify-restore-${RUN_ID}"
STATE_ROOT="$(mktemp -d /tmp/ezcorp-upgrade-state-XXXXXXXX)"
RESTORE_STATE_ROOT="$(mktemp -d /tmp/ezcorp-upgrade-restore-state-XXXXXXXX)"
STATE_FILE="$STATE_ROOT/upgrade-state.json"
PORT="${VERIFY_UPGRADE_PORT:-13003}"

SOURCE_B="$(git rev-parse HEAD)"
REVISION_B="$SOURCE_B"
VERSION_B="$(jq -r .version package.json)"
CREATED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

BOLD="$(tput bold 2>/dev/null || echo)"
GREEN="$(tput setaf 2 2>/dev/null || echo)"
RED="$(tput setaf 1 2>/dev/null || echo)"
RESET="$(tput sgr0 2>/dev/null || echo)"

section() { echo; echo "${BOLD}==> $1${RESET}"; }
pass() { echo "  ${GREEN}✓${RESET} $1"; }
die()  { echo "  ${RED}✗${RESET} $1" >&2; exit 1; }

cleanup() {
  local status=$? cleanup_status=0
  set +e
  docker info >/dev/null 2>&1 || cleanup_status=1
  if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || cleanup_status=1
  fi
  for owned_volume in "$VOLUME" "$RESTORE_VOLUME"; do
    if docker volume inspect "$owned_volume" >/dev/null 2>&1; then
      docker volume rm "$owned_volume" >/dev/null 2>&1 || cleanup_status=1
    fi
  done
  rm -rf "$STATE_ROOT" "$RESTORE_STATE_ROOT" || cleanup_status=1
  printf 'upgrade_command_exit=%s upgrade_cleanup_exit=%s\n' "$status" "$cleanup_status"
  trap - EXIT
  if [[ "$status" -ne 0 ]]; then exit "$status"; fi
  exit "$cleanup_status"
}
trap cleanup EXIT

ENC_SECRET="$(openssl rand -base64 32)"
ENC_SALT="$(openssl rand -base64 32)"

start_container() {
  local image="$1"
  local volume="${2:-$VOLUME}"
  docker run -d \
    --name "${CONTAINER}" \
    -p "127.0.0.1:${PORT}:3000" \
    -v "${volume}:/app/data" \
    -e EZCORP_ENCRYPTION_SECRET="${ENC_SECRET}" \
    -e EZCORP_ENCRYPTION_SALT="${ENC_SALT}" \
    -e EZCORP_CHECK_UPDATES=false \
    "${image}" >/dev/null
}

wait_ready() {
  local budget="${1:-60}"
  local deadline=$(( $(date +%s) + budget ))
  while :; do
    local code
    code=$(curl -sS -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/api/ready" || true)
    if [[ "${code}" == "200" ]]; then return 0; fi
    if (( $(date +%s) > deadline )); then
      echo "--- last 30 lines of container logs:" >&2
      docker logs --tail 30 "${CONTAINER}" >&2 || true
      echo "readiness never reached 200 (last code=${code})" >&2
      return 1
    fi
    sleep 1
  done
}

volume_entries() {
  docker run --rm --user 1000:1000 -v "${VOLUME}:/d" docker.io/library/alpine:latest ls /d/ezcorp 2>/dev/null | wc -l | tr -d '[:space:]'
}

snapshot_count() {
  docker run --rm --user 1000:1000 -v "${VOLUME}:/d" docker.io/library/alpine:latest \
    sh -c 'ls -1 /d/backups 2>/dev/null | grep -c "^pre-boot-" || echo 0' | tr -d '[:space:]'
}

[[ "$PREVIOUS_SOURCE" =~ ^[0-9a-f]{40}$ ]] || die "Previous source must be a full immutable commit"
if ! git cat-file -e "${PREVIOUS_SOURCE}^{commit}" 2>/dev/null; then
  git fetch --no-tags origin "$PREVIOUS_SOURCE" || die "Cannot fetch the pinned previous source"
fi
git cat-file -e "${PREVIOUS_SOURCE}^{commit}" || die "Previous source is not a committed tree: ${PREVIOUS_SOURCE}"
[[ "$PREVIOUS_SOURCE" != "$SOURCE_B" ]] || die "Previous and candidate source are identical"
if ! docker image inspect "$IMAGE_A" >/dev/null 2>&1; then
  section "Build missing historical image from ${PREVIOUS_SOURCE}"
  previous_version="$(git show "$PREVIOUS_SOURCE:package.json" | jq -er .version)"
  previous_created="$(git show -s --format=%cI "$PREVIOUS_SOURCE")"
  git archive "$PREVIOUS_SOURCE" | docker build --load \
    --build-arg VERSION="$previous_version" --build-arg REVISION="$PREVIOUS_SOURCE" \
    --build-arg CREATED="$previous_created" -t "$IMAGE_A" - \
    >"/tmp/ezcorp-upgrade-${RUN_ID}-previous-build.log" 2>&1 || die "Historical build failed: /tmp/ezcorp-upgrade-${RUN_ID}-previous-build.log"
fi
IMAGE_A_SOURCE="$(docker image inspect "$IMAGE_A" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
IMAGE_A_ID="$(docker image inspect "$IMAGE_A" --format '{{.Id}}' | sed 's/^sha256://')"
if [[ -n "$IMAGE_A_SOURCE" && "$IMAGE_A_SOURCE" != "<no value>" && "$IMAGE_A_SOURCE" != "unknown" ]]; then
  [[ "$IMAGE_A_SOURCE" == "$PREVIOUS_SOURCE" ]] || die "Previous image label provenance is $IMAGE_A_SOURCE, expected $PREVIOUS_SOURCE"
else
  # The retained audit image predates OCI revision labels. Its immutable image
  # ID is recorded with source 3ec53e in the checked-in independent receipt.
  [[ "$IMAGE_A_ID" == "$PREVIOUS_IMAGE_ID" ]] || die "Previous unlabelled image ID is $IMAGE_A_ID, expected $PREVIOUS_IMAGE_ID"
fi

if [[ "${VERIFY_UPGRADE_SKIP_BUILD:-0}" == "1" ]]; then
  docker image inspect "$IMAGE_B" >/dev/null 2>&1 || die "Supplied candidate image is absent: $IMAGE_B"
  section "Use supplied candidate image for semantic retry"
else
  section "Build candidate from committed source ${SOURCE_B:0:12}"
  git archive "$SOURCE_B" | docker build --load \
    --build-arg VERSION="${VERSION_B}" \
    --build-arg REVISION="${REVISION_B}" \
    --build-arg CREATED="${CREATED}" \
    -t "${IMAGE_B}" - >"/tmp/ezcorp-upgrade-${RUN_ID}-candidate-build.log" 2>&1 || {
      tail -30 "/tmp/ezcorp-upgrade-${RUN_ID}-candidate-build.log" >&2
      die "candidate build failed (log: /tmp/ezcorp-upgrade-${RUN_ID}-candidate-build.log)"
    }
fi
IMAGE_B_SOURCE="$(docker image inspect "$IMAGE_B" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
[[ "$IMAGE_B_SOURCE" =~ ^[0-9a-f]{40}$ ]] || die "Candidate image needs an immutable source label"
expected_source="${VERIFY_UPGRADE_CANDIDATE_SOURCE:-$IMAGE_B_SOURCE}"
if [[ "${VERIFY_UPGRADE_SKIP_BUILD:-0}" != 1 ]]; then expected_source="$SOURCE_B"; fi
[[ "$IMAGE_B_SOURCE" == "$expected_source" ]] || die "Candidate source $IMAGE_B_SOURCE differs from expected $expected_source"
[[ "$IMAGE_B_SOURCE" != "$PREVIOUS_SOURCE" ]] || die "Previous and candidate image sources are identical"
B_SHA=$(docker image inspect "$IMAGE_B" --format '{{json .Config.Env}}' \
  | jq -r '.[] | select(startswith("EZCORP_IMAGE_SHA=")) | split("=")[1]')
[[ "$B_SHA" == "$IMAGE_B_SOURCE" ]] || die "Candidate source label and runtime source differ"
if [[ "${VERIFY_UPGRADE_SKIP_BUILD:-0}" == 1 ]]; then
  VERSION_B="$(docker image inspect "$IMAGE_B" --format '{{index .Config.Labels "org.opencontainers.image.version"}}')"
  [[ -n "$VERSION_B" && "$VERSION_B" != '<no value>' && "$VERSION_B" != unknown ]] || die "Candidate image needs a version label"
fi
pass "Previous image source=$PREVIOUS_SOURCE; candidate image source=$IMAGE_B_SOURCE; driver source=$SOURCE_B"

run_lifecycle_state() {
  local image="$1" mode="$2" state_root="$3" port="$4" project="${5}-${RUN_ID}" receipt status
  receipt="$(mktemp -d /tmp/ezcorp-upgrade-receipt-XXXXXXXX)"
  set +e
  EZ_PRODUCTION_IMAGE="$image" \
  EZ_PRODUCTION_RECEIPT_DIR="$receipt" \
  EZ_PRODUCTION_STATE_DIR="$state_root" \
  EZ_PRODUCTION_PORT="$port" EZ_PRODUCTION_COMPOSE_PROJECT="$project" \
  EZ_PRODUCTION_APP_CONTAINER="${project}-app" EZ_PRODUCTION_APP_UID="${EZ_UPGRADE_APP_UID:-0}" EZ_PRODUCTION_APP_GID="${EZ_UPGRADE_APP_GID:-0}" \
  bash scripts/verify-production-image-lifecycle.sh -- \
    env EZ_UPGRADE_MODE="$mode" EZ_UPGRADE_STATE_FILE="$STATE_FILE" bun scripts/verify-docker-upgrade-state.ts
  status=$?
  set -e
  [[ "$status" -eq 0 ]] || return "$status"
  grep -qx 'command_exit=0' "$receipt/command.log" || die "Semantic ${mode} command did not complete successfully: $receipt/command.log"
  grep -qx 'owned_cleanup_exit=0' "$receipt/command.log" || die "Semantic ${mode} cleanup did not complete successfully: $receipt/command.log"
}

section "Semantic lifecycle seed on the previous image"
run_lifecycle_state "$IMAGE_A" seed "$STATE_ROOT" 13004 ezcorp-upgrade-semantic-old
[[ -s "$STATE_FILE" ]] || die "Previous image did not persist lifecycle sentinel"
pass "Previous image created user-owned extension, exact human approval, conversation and tool sentinel"

section "Semantic lifecycle upgrade to the candidate"
tar -C "$STATE_ROOT" --exclude=socket -cf - . | tar -C "$RESTORE_STATE_ROOT" -xf -
run_lifecycle_state "$IMAGE_B" assert "$STATE_ROOT" 13005 ezcorp-upgrade-semantic-candidate
pass "Candidate preserved exact installation, active release, human approval, conversation and tool sentinel"

section "Semantic backup restore into a separate owned candidate instance"
run_lifecycle_state "$IMAGE_B" assert "$RESTORE_STATE_ROOT" 13006 ezcorp-upgrade-semantic-restore
pass "Separate restored instance preserved the same lifecycle sentinel"

if [[ "${VERIFY_UPGRADE_SEMANTIC_ONLY:-0}" == "1" ]]; then
  echo
  echo "${BOLD}${GREEN}UPGRADE SEMANTIC STATE VERIFIED${RESET} — supplied candidate preserved exact owner, release, approval, link, and stored output."
  exit 0
fi

section "Phase 1: Start container A"
start_container "${IMAGE_A}"
wait_ready 60
pass "A booted, /api/ready=200"

VER_A_RESP=$(curl -sS "http://localhost:${PORT}/api/version")
[[ "$(echo "${VER_A_RESP}" | jq -r .current)" != "null" ]] \
  || die "Container A did not report its running version"
pass "/api/version reports a previous-image version"

ENTRIES_A="$(volume_entries)"
SNAPS_A="$(snapshot_count)"
(( ENTRIES_A > 0 )) || die "DB empty after A boot"
pass "A populated volume: ${ENTRIES_A} DB entries, ${SNAPS_A} pre-boot snapshot(s)"

section "Phase 2: Stop the previous image"
docker stop "${CONTAINER}" >/dev/null
docker rm "${CONTAINER}" >/dev/null

section "Phase 3: Upgrade — start B against A's volume"
start_container "${IMAGE_B}"
wait_ready 60
pass "B booted against A's data, /api/ready=200"

VER_B_RESP=$(curl -sS "http://localhost:${PORT}/api/version")
[[ "$(echo "${VER_B_RESP}" | jq -r .current)" == "${VERSION_B}" ]] \
  || die "After upgrade, /api/version reports $(echo "${VER_B_RESP}" | jq -r .current), expected ${VERSION_B}"
pass "/api/version now reports ${VERSION_B} (upgrade surfaced to the user)"

READY_B=$(curl -sS "http://localhost:${PORT}/api/ready")
STATE_B=$(echo "${READY_B}" | jq -r .state)
[[ "${STATE_B}" == "ready" ]] \
  || die "B reports state=${STATE_B}, expected ready. Body: ${READY_B}"
pass "B readiness: state=ready (no residual circuit-breaker)"

ENTRIES_B="$(volume_entries)"
(( ENTRIES_B >= ENTRIES_A )) \
  || die "Data shrank across upgrade: ${ENTRIES_A} → ${ENTRIES_B}"
pass "DB preserved: ${ENTRIES_A} → ${ENTRIES_B} entries"

SNAPS_B="$(snapshot_count)"
(( SNAPS_B > SNAPS_A )) \
  || die "B's boot did not take a new pre-boot snapshot (was ${SNAPS_A}, still ${SNAPS_B}). Rollback would have no target on a failed migration mid-upgrade."
pass "B boot took a fresh pre-boot snapshot (${SNAPS_A} → ${SNAPS_B})"

# Confirm no migration-failed marker lingers from either A or B.
MARKER_EXISTS=$(docker run --rm --user 1000:1000 -v "${VOLUME}:/d" docker.io/library/alpine:latest \
  sh -c 'test -f /d/.migration-failed && echo yes || echo no')
[[ "${MARKER_EXISTS}" == "no" ]] \
  || die "Stale .migration-failed marker present after clean upgrade"
pass "No stale circuit-breaker marker after upgrade"

section "Phase 4: Restore a stopped candidate backup into a separate owned volume"
docker stop "$CONTAINER" >/dev/null
docker volume create "$RESTORE_VOLUME" >/dev/null
docker run --rm -v "$VOLUME:/from:ro" -v "$RESTORE_VOLUME:/to" docker.io/library/alpine:latest \
  sh -c 'cd /from && tar cf - . | tar xf - -C /to'
docker rm "$CONTAINER" >/dev/null
start_container "$IMAGE_B" "$RESTORE_VOLUME"
wait_ready 60
RESTORE_READY=$(curl -sS "http://localhost:${PORT}/api/ready")
[[ "$(echo "$RESTORE_READY" | jq -r .state)" == "ready" ]] || die "Restored candidate is not ready: $RESTORE_READY"
[[ "$(curl -sS "http://localhost:${PORT}/api/version" | jq -r .current)" == "$VERSION_B" ]] || die "Restored instance reports the wrong candidate version"
pass "Backup restored into a separate owned candidate instance and reached ready"

section "Phase 5: Downgrade B → A (documentation of behavior)"
docker stop "${CONTAINER}" >/dev/null
docker rm "${CONTAINER}" >/dev/null

start_container "${IMAGE_A}"
if wait_ready 60 2>/dev/null; then
  DOWN_VER=$(curl -sS "http://localhost:${PORT}/api/version" | jq -r .current)
  DOWN_STATE=$(curl -sS "http://localhost:${PORT}/api/ready" | jq -r .state)
  DOWN_ENTRIES="$(volume_entries)"
  pass "Downgrade succeeded: version=${DOWN_VER}, state=${DOWN_STATE}, entries=${DOWN_ENTRIES}"
  echo "    ${BOLD}Note:${RESET} This works today because migrate.ts uses only idempotent"
  echo "    CREATE IF NOT EXISTS DDL. A future major release with destructive"
  echo "    migrations would break downgrade. Pin your tag for real deployments."
else
  echo "Downgrade did not reach readiness for this image pair. Forward upgrade and restore passed."
fi

echo
echo "${BOLD}${GREEN}UPGRADE VERIFIED${RESET} — two-image forward upgrade preserves data, migrates cleanly, and updates /api/version."
