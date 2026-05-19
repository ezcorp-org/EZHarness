#!/usr/bin/env bash
# Docker failure-mode / rollback verification.
#
# Validates that the circuit-breaker + recovery flow works end-to-end at
# the Docker level, using the same image produced by verify-docker-image.sh:
#
#   1. Seed a pre-existing DB + valid data in the volume.
#   2. Inject a "previous boot failed" marker with the image's own SHA.
#   3. Start the container. Expect readiness=503 with reason=migration-blocked,
#      container is healthy (not crash-looping), and data is readable.
#   4. Clear the marker via `docker exec`.
#   5. Restart. Expect readiness=200 and data still intact.
#
# Prereqs: ezcorp:verify image (run `bash scripts/verify-docker-image.sh` first).
#
# Run:
#   bash scripts/verify-docker-rollback.sh

set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="ezcorp:verify"
CONTAINER="ezcorp-verify-rollback"
VOLUME="ezcorp-verify-rollback-data"
PORT="${VERIFY_ROLLBACK_PORT:-13001}"

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
cleanup # pre-existing state

docker image inspect "${IMAGE}" >/dev/null 2>&1 \
  || die "Image ${IMAGE} not found. Run: bash scripts/verify-docker-image.sh"

# Extract the image's own EZCORP_IMAGE_SHA so our injected marker matches.
IMAGE_SHA=$(docker inspect "${IMAGE}" --format '{{json .Config.Env}}' \
  | jq -r '.[] | select(startswith("EZCORP_IMAGE_SHA=")) | split("=")[1]')
[[ -n "${IMAGE_SHA}" && "${IMAGE_SHA}" != "unknown" ]] \
  || die "Image is missing EZCORP_IMAGE_SHA env (rebuild with --build-arg REVISION=...)"
pass "Image SHA detected: ${IMAGE_SHA:0:12}"

section "Phase 1: Seed a DB (one normal boot)"
docker run -d \
  --name "${CONTAINER}" \
  -p "${PORT}:3000" \
  -v "${VOLUME}:/app/data" \
  -e EZCORP_ENCRYPTION_SECRET="$(openssl rand -base64 32)" \
  -e EZCORP_ENCRYPTION_SALT="$(openssl rand -base64 32)" \
  -e EZCORP_CHECK_UPDATES=false \
  "${IMAGE}" >/dev/null

deadline=$(( $(date +%s) + 60 ))
while :; do
  code=$(curl -sS -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/api/ready" || true)
  [[ "${code}" == "200" ]] && break
  (( $(date +%s) > deadline )) && die "Phase-1 readiness never reached 200"
  sleep 1
done
pass "Container booted cleanly on first start (readiness=200)"

# Verify the volume holds the DB + we can read data via HTTP (we only need to
# know it's non-empty; seeding occurs via migrate() + default settings).
DB_ENTRIES=$(docker run --rm -v "${VOLUME}:/d" alpine sh -c 'ls /d/ezcorp 2>/dev/null | wc -l')
(( DB_ENTRIES > 0 )) || die "DB dir empty after first boot"
pass "DB populated with ${DB_ENTRIES} entries"

section "Phase 2: Inject circuit-breaker marker + restart"
docker stop "${CONTAINER}" >/dev/null
# Write the marker directly into the volume. JSON must match readMarker()
# shape: imageSha, error, ts.
MARKER_BODY=$(jq -nc --arg sha "${IMAGE_SHA}" \
  '{imageSha: $sha, error: "simulated failure for docker rollback verification", ts: (now|todate)}')
# Write as uid 1000 (the `bun` user inside the runtime image) so the
# non-root container can actually read the 0600-permission marker.
docker run --rm --user 1000:1000 -v "${VOLUME}:/d" alpine sh -c \
  "printf '%s' '${MARKER_BODY}' > /d/.migration-failed && chmod 600 /d/.migration-failed"
pass "Marker written to volume with matching image SHA"

docker start "${CONTAINER}" >/dev/null

# Wait for the container to come up (it won't be 'ready', but the HTTP
# listener should bind). Poll /api/ready — expect 503.
deadline=$(( $(date +%s) + 60 ))
while :; do
  code=$(curl -sS -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/api/ready" || true)
  [[ "${code}" != "000" ]] && break
  (( $(date +%s) > deadline )) && die "Container never bound HTTP after restart"
  sleep 1
done

BODY=$(curl -sS "http://localhost:${PORT}/api/ready")
CODE=$(curl -sS -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/api/ready")
[[ "${CODE}" == "503" ]] || die "Expected /api/ready → 503 (circuit breaker), got ${CODE}; body=${BODY}"
pass "/api/ready returned 503"

STATE=$(echo "${BODY}" | jq -r '.state // empty')
REASON=$(echo "${BODY}" | jq -r '.reason // empty')
[[ "${STATE}" == "degraded" ]] || die "Expected state=degraded, got: ${BODY}"
[[ "${REASON}" == "migration-blocked" ]] || die "Expected reason=migration-blocked, got: ${REASON}"
pass "state=degraded + reason=migration-blocked"

# Container should STILL be running (not crash-looping) — degraded but alive.
STATUS=$(docker inspect "${CONTAINER}" --format '{{.State.Status}}')
[[ "${STATUS}" == "running" ]] || die "Container should be running (not crashed); got: ${STATUS}"
pass "Container is 'running' — degraded, not crash-looping"

# The marker's detail should be exposed in the readiness body for operators.
MSG=$(echo "${BODY}" | jq -r '.detail.error // empty')
echo "${MSG}" | grep -q "simulated failure" \
  || die "Readiness detail should surface marker error text; got: ${MSG}"
pass "Readiness body exposes marker error to operators"

section "Phase 3: Clear marker + restart → recovery"
docker exec "${CONTAINER}" sh -c 'rm -f /app/data/.migration-failed'
pass "Marker cleared via \`docker exec\`"

docker restart "${CONTAINER}" >/dev/null
deadline=$(( $(date +%s) + 60 ))
while :; do
  code=$(curl -sS -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/api/ready" || true)
  [[ "${code}" == "200" ]] && break
  (( $(date +%s) > deadline )) && die "Post-recovery readiness never reached 200"
  sleep 1
done
pass "Post-recovery readiness=200"

BODY=$(curl -sS "http://localhost:${PORT}/api/ready")
STATE=$(echo "${BODY}" | jq -r '.state')
[[ "${STATE}" == "ready" ]] || die "Expected state=ready, got: ${BODY}"
pass "state=ready"

# DB should be intact (not wiped during recovery).
DB_ENTRIES_AFTER=$(docker run --rm -v "${VOLUME}:/d" alpine sh -c 'ls /d/ezcorp 2>/dev/null | wc -l')
(( DB_ENTRIES_AFTER >= DB_ENTRIES )) \
  || die "DB entries shrank across recovery: ${DB_ENTRIES} → ${DB_ENTRIES_AFTER}"
pass "DB data preserved (${DB_ENTRIES_AFTER} entries, ≥ pre-test ${DB_ENTRIES})"

SNAPS=$(docker run --rm -v "${VOLUME}:/d" alpine sh -c 'ls /d/backups 2>/dev/null | grep -c "^pre-boot-" || echo 0')
(( SNAPS >= 1 )) || die "Recovery boot should have taken a fresh pre-boot snapshot"
pass "Recovery created a pre-boot snapshot (total: ${SNAPS})"

echo
echo "${BOLD}${GREEN}DOCKER ROLLBACK VERIFIED${RESET} — circuit breaker, degraded mode, and recovery all work end-to-end."
