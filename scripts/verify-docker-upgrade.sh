#!/usr/bin/env bash
# End-to-end two-image upgrade verification.
#
# Simulates the real upgrade flow a self-hoster experiences when a new image
# lands on GHCR (manual pull or Watchtower):
#
#   1. Build image A with VERSION=0.1.0-a / a unique REVISION.
#   2. Start container A against a fresh volume, wait for /api/ready = 200.
#   3. Record baseline state (DB entries, readiness body, version endpoint).
#   4. Stop container A (preserve the volume).
#   5. Build image B with VERSION=0.2.0-b / a different REVISION (same source).
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

IMAGE_A="ezcorp:upgrade-a"
IMAGE_B="ezcorp:upgrade-b"
CONTAINER="ezcorp-upgrade-verify"
VOLUME="ezcorp-upgrade-verify-data"
PORT="${VERIFY_UPGRADE_PORT:-13003}"

VERSION_A="0.1.0-upgrade-a"
VERSION_B="0.2.0-upgrade-b"
# Artificial distinct SHAs so the circuit-breaker key differs across the
# versions, even though both builds come from the same source tree.
REVISION_A="$(git rev-parse HEAD 2>/dev/null || echo dev)upgradea"
REVISION_B="$(git rev-parse HEAD 2>/dev/null || echo dev)upgradeb"
CREATED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

BOLD="$(tput bold 2>/dev/null || echo)"
GREEN="$(tput setaf 2 2>/dev/null || echo)"
RED="$(tput setaf 1 2>/dev/null || echo)"
RESET="$(tput sgr0 2>/dev/null || echo)"

section() { echo; echo "${BOLD}==> $1${RESET}"; }
pass() { echo "  ${GREEN}✓${RESET} $1"; }
die()  { echo "  ${RED}✗${RESET} $1" >&2; exit 1; }

cleanup() {
  set +e
  docker rm -f "$CONTAINER" >/dev/null 2>&1
  docker volume rm "$VOLUME" >/dev/null 2>&1
}
trap cleanup EXIT
cleanup

ENC_SECRET="$(openssl rand -base64 32)"
ENC_SALT="$(openssl rand -base64 32)"

start_container() {
  local image="$1"
  docker run -d \
    --name "${CONTAINER}" \
    -p "${PORT}:3000" \
    -v "${VOLUME}:/app/data" \
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
      die "readiness never reached 200 (last code=${code})"
    fi
    sleep 1
  done
}

volume_entries() {
  docker run --rm --user 1000:1000 -v "${VOLUME}:/d" alpine ls /d/ezcorp 2>/dev/null | wc -l | tr -d '[:space:]'
}

snapshot_count() {
  docker run --rm --user 1000:1000 -v "${VOLUME}:/d" alpine \
    sh -c 'ls -1 /d/backups 2>/dev/null | grep -c "^pre-boot-" || echo 0' | tr -d '[:space:]'
}

section "Build image A (VERSION=${VERSION_A}, REVISION=${REVISION_A:0:12})"
docker build \
  --build-arg VERSION="${VERSION_A}" \
  --build-arg REVISION="${REVISION_A}" \
  --build-arg CREATED="${CREATED}" \
  -t "${IMAGE_A}" . >/tmp/ezcorp-upgrade-a.log 2>&1 || {
    tail -30 /tmp/ezcorp-upgrade-a.log >&2
    die "build A failed (log: /tmp/ezcorp-upgrade-a.log)"
  }
pass "Image A built"

section "Phase 1: Start container A"
start_container "${IMAGE_A}"
wait_ready 60
pass "A booted, /api/ready=200"

VER_A_RESP=$(curl -sS "http://localhost:${PORT}/api/version")
[[ "$(echo "${VER_A_RESP}" | jq -r .current)" == "${VERSION_A}" ]] \
  || die "Container A reporting wrong version: $(echo "${VER_A_RESP}" | jq -r .current)"
pass "/api/version reports current=${VERSION_A}"

ENTRIES_A="$(volume_entries)"
SNAPS_A="$(snapshot_count)"
(( ENTRIES_A > 0 )) || die "DB empty after A boot"
pass "A populated volume: ${ENTRIES_A} DB entries, ${SNAPS_A} pre-boot snapshot(s)"

section "Phase 2: Stop A, build image B (different VERSION + REVISION)"
docker stop "${CONTAINER}" >/dev/null
docker rm "${CONTAINER}" >/dev/null

docker build \
  --build-arg VERSION="${VERSION_B}" \
  --build-arg REVISION="${REVISION_B}" \
  --build-arg CREATED="${CREATED}" \
  -t "${IMAGE_B}" . >/tmp/ezcorp-upgrade-b.log 2>&1 || {
    tail -30 /tmp/ezcorp-upgrade-b.log >&2
    die "build B failed (log: /tmp/ezcorp-upgrade-b.log)"
  }
# Confirm B really has a different SHA baked in (otherwise buildx may have
# reused A's layers with the same ENV cache, defeating the test).
B_SHA=$(docker inspect "${IMAGE_B}" --format '{{json .Config.Env}}' \
  | jq -r '.[] | select(startswith("EZCORP_IMAGE_SHA=")) | split("=")[1]')
[[ "${B_SHA}" == "${REVISION_B}" ]] \
  || die "Image B has wrong EZCORP_IMAGE_SHA: ${B_SHA} (expected ${REVISION_B})"
pass "Image B built with distinct SHA baked in"

section "Phase 3: Upgrade — start B against A's volume"
start_container "${IMAGE_B}"
wait_ready 60
pass "B booted against A's data, /api/ready=200"

VER_B_RESP=$(curl -sS "http://localhost:${PORT}/api/version")
[[ "$(echo "${VER_B_RESP}" | jq -r .current)" == "${VERSION_B}" ]] \
  || die "After upgrade, /api/version still reports ${VERSION_A}: $(echo "${VER_B_RESP}" | jq -r .current)"
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
MARKER_EXISTS=$(docker run --rm --user 1000:1000 -v "${VOLUME}:/d" alpine \
  sh -c 'test -f /d/.migration-failed && echo yes || echo no')
[[ "${MARKER_EXISTS}" == "no" ]] \
  || die "Stale .migration-failed marker present after clean upgrade"
pass "No stale circuit-breaker marker after upgrade"

section "Phase 4: Downgrade B → A (documentation of behavior)"
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
  pass "Downgrade failed gracefully (migration forward-only for this version pair)"
fi

echo
echo "${BOLD}${GREEN}UPGRADE VERIFIED${RESET} — two-image forward upgrade preserves data, migrates cleanly, and updates /api/version."
