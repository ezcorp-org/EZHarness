#!/usr/bin/env bash
# Docker image smoke test for a production-shaped build.
#
# Builds the image with VERSION/REVISION/CREATED build args, asserts OCI
# labels + VOLUME declaration, starts a container, and exercises the health
# + readiness + version endpoints. Cleans up on exit.
#
# Run:
#   bash scripts/verify-docker-image.sh             # full build + run
#   bash scripts/verify-docker-image.sh --no-build  # reuse existing ezcorp:verify tag

set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE="ezcorp:verify"
CONTAINER="ezcorp-verify"
VOLUME="ezcorp-verify-data"
PORT="${VERIFY_PORT:-13000}"

# VERSION/REVISION/CREATED are env-overridable so the release-image workflow
# can build the image with one set of args and then re-use them when invoking
# `verify-docker-image.sh --no-build`. Locally (no overrides) the script
# falls back to a deterministic stamp + the current git SHA.
VERSION="${VERIFY_VERSION:-0.1.0-verify}"
REVISION="${VERIFY_REVISION:-$(git rev-parse HEAD 2>/dev/null || echo dev-verify)}"
CREATED="${VERIFY_CREATED:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

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

cleanup # pre-existing state from a prior failed run

if [[ "${1:-}" != "--no-build" ]]; then
  section "Build ${IMAGE} with VERSION=${VERSION} REVISION=${REVISION:0:12}"
  docker build \
    --build-arg VERSION="${VERSION}" \
    --build-arg REVISION="${REVISION}" \
    --build-arg CREATED="${CREATED}" \
    -t "${IMAGE}" \
    -f Dockerfile \
    . >/tmp/ezcorp-verify-build.log 2>&1 || {
      tail -40 /tmp/ezcorp-verify-build.log >&2
      die "docker build failed (full log at /tmp/ezcorp-verify-build.log)"
    }
  pass "Image built"
else
  # `--no-build` reuses an existing image. If CREATED wasn't passed in via
  # VERIFY_CREATED, take it from the image label so we don't compare against
  # a freshly-stamped wall-clock value the image never saw.
  if [[ -z "${VERIFY_CREATED:-}" ]]; then
    LABEL_CREATED=$(docker inspect "${IMAGE}" --format '{{index .Config.Labels "org.opencontainers.image.created"}}' 2>/dev/null || true)
    if [[ -n "${LABEL_CREATED}" && "${LABEL_CREATED}" != "<no value>" ]]; then
      CREATED="${LABEL_CREATED}"
    fi
  fi
fi

section "Inspect OCI labels"
LABELS=$(docker inspect "${IMAGE}" --format '{{json .Config.Labels}}')
jq_check() {
  local key="$1" expected="$2"
  local actual
  actual=$(echo "${LABELS}" | jq -r --arg k "$key" '.[$k] // ""')
  [[ "${actual}" == "${expected}" ]] || die "Label ${key} expected '${expected}', got '${actual}'"
  pass "${key} = ${expected}"
}
jq_check "org.opencontainers.image.title" "ezcorp"
jq_check "org.opencontainers.image.version" "${VERSION}"
jq_check "org.opencontainers.image.revision" "${REVISION}"
jq_check "org.opencontainers.image.created" "${CREATED}"
[[ $(echo "${LABELS}" | jq -r '."org.opencontainers.image.source" // ""') == https://github.com/* ]] \
  || die "org.opencontainers.image.source missing or malformed"
pass "org.opencontainers.image.source points at github.com"

section "Inspect VOLUME declaration"
VOLUMES=$(docker inspect "${IMAGE}" --format '{{json .Config.Volumes}}')
echo "${VOLUMES}" | jq -e 'has("/app/data")' >/dev/null \
  || die "Dockerfile must declare VOLUME /app/data (got: ${VOLUMES})"
pass "/app/data declared as VOLUME"

section "Inspect env vars baked into image"
ENVS=$(docker inspect "${IMAGE}" --format '{{json .Config.Env}}')
for expected in "EZCORP_IMAGE_VERSION=${VERSION}" "EZCORP_IMAGE_SHA=${REVISION}" "EZCORP_DB_PATH=/app/data/ezcorp"; do
  echo "${ENVS}" | jq -e --arg e "$expected" 'index($e) != null' >/dev/null \
    || die "Env var missing: ${expected}"
  pass "${expected}"
done

section "Start container on port ${PORT}"
# Encryption secrets are required at boot for the bundled-creds bootstrap.
docker run -d \
  --name "${CONTAINER}" \
  -p "${PORT}:3000" \
  -v "${VOLUME}:/app/data" \
  -e EZCORP_ENCRYPTION_SECRET="$(openssl rand -base64 32)" \
  -e EZCORP_ENCRYPTION_SALT="$(openssl rand -base64 32)" \
  -e EZCORP_CHECK_UPDATES=false \
  "${IMAGE}" >/dev/null
pass "Container started"

section "Wait for /api/ready to return 200 (readiness gate)"
deadline=$(( $(date +%s) + 60 ))
while :; do
  code=$(curl -sS -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/api/ready" || true)
  if [[ "${code}" == "200" ]]; then
    pass "/api/ready returned 200 within budget"
    break
  fi
  if (( $(date +%s) > deadline )); then
    echo "--- last 30 lines of container logs:" >&2
    docker logs --tail 30 "${CONTAINER}" >&2 || true
    die "/api/ready never returned 200 (last code=${code})"
  fi
  sleep 1
done

section "Verify readiness body shape"
BODY=$(curl -sS "http://localhost:${PORT}/api/ready")
STATE=$(echo "${BODY}" | jq -r '.state // empty')
[[ "${STATE}" == "ready" ]] || die "Expected state=ready, got: ${BODY}"
pass "state=ready"
echo "${BODY}" | jq -e '.since' >/dev/null || die "readiness response missing 'since'"
pass "since field present"

section "Verify /api/health (liveness) also 2xx"
HEALTH_CODE=$(curl -sS -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/api/health")
# health returns 200 on ok, or 401 if auth-gated (older behavior) — Dockerfile HEALTHCHECK accepts both.
[[ "${HEALTH_CODE}" =~ ^(200|401)$ ]] || die "/api/health returned ${HEALTH_CODE}"
pass "/api/health returned ${HEALTH_CODE}"

section "Verify /api/version"
VER=$(curl -sS "http://localhost:${PORT}/api/version")
VER_CUR=$(echo "${VER}" | jq -r '.current // empty')
[[ "${VER_CUR}" == "${VERSION}" ]] || die "Expected current=${VERSION}, got: ${VER}"
pass "current=${VERSION}"
SRC=$(echo "${VER}" | jq -r '.source // empty')
[[ "${SRC}" == "disabled" ]] || die "Expected source=disabled (EZCORP_CHECK_UPDATES=false), got: ${SRC}"
pass "source=disabled (update check off as configured)"

section "Verify bundled/example extension npm dependencies resolve inside the image"
# Mode B deploy-time catch (extension npm-deps): for every example + bundled
# extension manifest that declares `npmDependencies`, resolve each package
# from that extension's install dir INSIDE the image. A miss here is exactly
# the live incident (2026-07-11: @zxing/library missing from the image's
# node_modules); fail the build loudly rather than ship a crash-loop.
NPMDEPS_JS='
const { verifyNpmDependencies } = await import("/app/src/extensions/npm-deps");
const roots = ["docs/extensions/examples", "extensions", "packages/@ezcorp"];
let failed = 0, checked = 0;
for (const root of roots) {
  const glob = new Bun.Glob(root + "/*/ezcorp.config.ts");
  for (const rel of glob.scanSync("/app")) {
    const dir = "/app/" + rel.slice(0, rel.lastIndexOf("/"));
    let manifest;
    try { manifest = (await import("/app/" + rel)).default; } catch (e) { continue; }
    const deps = manifest && manifest.npmDependencies;
    if (!deps) continue;
    checked += Object.keys(deps).length;
    const check = verifyNpmDependencies(deps, dir);
    if (!check.ok) {
      for (const i of check.issues) console.error("UNRESOLVED " + i.name + " (" + i.range + ") from " + rel + ": " + i.reason);
      failed += check.issues.length;
    }
  }
}
console.log("npm-deps: checked=" + checked + " failed=" + failed);
process.exit(failed > 0 ? 1 : 0);
'
if NPMDEPS_OUT=$(docker exec "$CONTAINER" bun -e "${NPMDEPS_JS}" 2>&1); then
  echo "  ${NPMDEPS_OUT}"
  pass "all declared extension npmDependencies resolve inside the image"
else
  echo "${NPMDEPS_OUT}" >&2
  die "extension npm dependency resolution failed inside the image (see UNRESOLVED lines above)"
fi

section "Verify named volume is populated + persists across restart"
docker volume inspect "${VOLUME}" >/dev/null || die "Named volume not created"
CONTENTS=$(docker run --rm -v "${VOLUME}:/d" alpine ls -1 /d | sort)
echo "${CONTENTS}" | grep -q '^ezcorp$' || die "Volume missing /app/data/ezcorp: ${CONTENTS}"
pass "Volume contains /app/data/ezcorp"

docker restart "${CONTAINER}" >/dev/null
deadline=$(( $(date +%s) + 60 ))
while :; do
  code=$(curl -sS -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/api/ready" || true)
  [[ "${code}" == "200" ]] && break
  if (( $(date +%s) > deadline )); then die "Post-restart readiness never reached 200"; fi
  sleep 1
done
pass "Container restarted cleanly + readiness returns 200"

# After a restart, a pre-boot snapshot should exist under /app/data/backups.
SNAPS=$(docker run --rm -v "${VOLUME}:/d" alpine sh -c 'ls -1 /d/backups 2>/dev/null | grep -c "^pre-boot-" || echo 0')
(( SNAPS >= 1 )) || die "Expected ≥1 pre-boot snapshot after restart, got ${SNAPS}"
pass "Pre-boot snapshot created on restart (${SNAPS} snapshot(s))"

echo
echo "${BOLD}${GREEN}DOCKER IMAGE VERIFIED${RESET} — labels, VOLUME, readiness, version, and persistence all correct."
