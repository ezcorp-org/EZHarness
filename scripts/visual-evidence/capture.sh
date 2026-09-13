#!/usr/bin/env bash
# Run selected visual-evidence specs with the Playwright config that owns them.
#
# The default mock config ignores every `real-auth` lane member of
# web/e2e/lanes.json — not only e2e/real-auth/**: eight real-auth journeys sit
# at the e2e/ root (chip-reorder, goal-feature, signup-token, ...). Diff
# selection can credit any of them, so a spec is tiered by LANE MEMBERSHIP,
# never by path prefix; a real-auth member handed to the mock config fails with
# "No tests found" and reds the credited capture. Blob reporter output names are
# distinct and are moved into web/blob-report/: build-manifest.ts scans that
# flat directory for every .zip report. Playwright clears its blob output dir at
# the start of a run, so each tier writes to a private temporary directory.
#
# Usage:
#   capture.sh <selected-evidence-specs-file>                  run the capture
#   capture.sh --has-real-auth <selected-evidence-specs-file>  exit 0 when the
#       selection needs the real-auth tier (__ALL__ or at least one real-auth
#       lane member), 1 when it does not, 2 on a usage or manifest error;
#       ci.yml asks this before installing the extension runner so the answer
#       has one home, and treats 2 as an error, never as "no real tier".
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
LANES_JSON="${REPO_ROOT}/web/e2e/lanes.json"
QUERY=""
if [[ "${1:-}" == "--has-real-auth" ]]; then
  QUERY="has-real-auth"
  shift
fi
SPECS_FILE=${1:-}

if [[ -z "${SPECS_FILE}" || ! -f "${SPECS_FILE}" ]]; then
  echo "usage: $0 [--has-real-auth] <selected-evidence-specs-file>" >&2
  exit 2
fi
if [[ ! -f "${LANES_JSON}" ]]; then
  echo "visual-evidence capture: lane manifest missing: ${LANES_JSON}" >&2
  exit 2
fi

# True when a selected spec (Playwright-rootDir-relative and regex-escaped by
# select-specs.ts, e.g. `e2e/chip-reorder\.spec\.ts`) is a `real-auth` lane
# member. Spec paths carry no literal backslashes, so stripping them undoes the
# escaping. One awk process: an early `grep -q` under pipefail would turn the
# writer's SIGPIPE into a false negative.
#
# The parser expects the manifest's committed shape: `"real-auth": [` on its
# own line, one quoted path per line, `]` closing the lane. It FAILS CLOSED
# (exit 2, via the caller) when that header is never seen, so a reformatted
# manifest cannot quietly answer "not a member" for every spec; and
# src/__tests__/visual-evidence-capture.test.ts runs it against the real file.
is_real_auth_spec() {
  local spec="${1//\\/}"
  awk -v want="\"web/${spec}\"" '
    /"real-auth": \[/ { in_lane = 1; seen = 1; next }
    in_lane && /^[[:space:]]*\]/ { exit }
    in_lane && index($0, want) { found = 1; exit }
    END { if (!seen) exit 2; exit !found }
  ' "${LANES_JSON}"
}

declare -a MOCK_SPECS=()
declare -a REAL_AUTH_SPECS=()
MODE="some"

while IFS= read -r spec || [[ -n "${spec}" ]]; do
  [[ -z "${spec}" ]] && continue
  case "${spec}" in
    __ALL__)
      [[ "${MODE}" == "some" && ${#MOCK_SPECS[@]} -eq 0 && ${#REAL_AUTH_SPECS[@]} -eq 0 ]] || {
        echo "visual-evidence capture: __ALL__ must be the only selection" >&2
        exit 2
      }
      MODE="all"
      ;;
    __NONE__)
      [[ "${MODE}" == "some" && ${#MOCK_SPECS[@]} -eq 0 && ${#REAL_AUTH_SPECS[@]} -eq 0 ]] || {
        echo "visual-evidence capture: __NONE__ must be the only selection" >&2
        exit 2
      }
      MODE="none"
      ;;
    e2e/*)
      [[ "${MODE}" == "some" ]] || {
        echo "visual-evidence capture: selection sentinel cannot be mixed with specs" >&2
        exit 2
      }
      is_real_auth_spec "${spec}"
      case $? in
        0) REAL_AUTH_SPECS+=("${spec}") ;;
        1) MOCK_SPECS+=("${spec}") ;;
        *)
          echo "visual-evidence capture: no \"real-auth\" lane found in ${LANES_JSON}" >&2
          exit 2
          ;;
      esac
      ;;
    *)
      echo "visual-evidence capture: unsupported selected spec '${spec}'" >&2
      exit 2
      ;;
  esac
done < "${SPECS_FILE}"

if [[ "${MODE}" == "some" && ${#MOCK_SPECS[@]} -eq 0 && ${#REAL_AUTH_SPECS[@]} -eq 0 ]]; then
  echo "visual-evidence capture: selection has no specs" >&2
  exit 2
fi

if [[ "${QUERY}" == "has-real-auth" ]]; then
  [[ "${MODE}" == "all" || ${#REAL_AUTH_SPECS[@]} -gt 0 ]] && exit 0
  exit 1
fi

[[ "${MODE}" != "none" ]] || exit 0

if [[ "${MODE}" == "all" ]]; then
  # The configs partition the tree: mock ignores real-auth, and real-auth's
  # testDir contains only real-auth. Both runs are required for full fallback.
  MOCK_SPECS=()
  REAL_AUTH_SPECS=()
fi

BLOB_DIR="${REPO_ROOT}/web/blob-report"
# This directory is generated capture output. Clear it before either tier so
# build-manifest.ts cannot parse a stale ordinary Playwright report alongside
# this invocation's evidence. Each tier below uses a private temporary dir.
rm -rf "${BLOB_DIR}" || exit $?
mkdir -p "${BLOB_DIR}" || exit $?

run_capture() {
  local config=$1
  local report_name=$2
  local real_mode=$3
  shift 3
  local tier_dir="${BLOB_DIR}/.${report_name}.tmp"
  local status

  rm -rf "${tier_dir}" || return $?
  mkdir -p "${tier_dir}" || return $?

  (
    local -a capture_env=(
      "EZCORP_E2E_EVIDENCE=1"
      "PI_E2E_REAL=${real_mode}"
      "PLAYWRIGHT_BLOB_OUTPUT_DIR=${tier_dir}"
      "PLAYWRIGHT_BLOB_OUTPUT_NAME=${report_name}"
    )
    if [[ "${real_mode}" == "1" ]]; then
      cd "${REPO_ROOT}"
      env "${capture_env[@]}" bun scripts/run-real-e2e.ts real-auth --project=chromium --grep @evidence "$@"
    else
      cd "${REPO_ROOT}/web"
      env "${capture_env[@]}" bunx playwright test --config "${config}" --project=chromium --grep @evidence "$@"
    fi
  )
  status=$?

  # Keep report files at the flat path build-manifest.ts already reads. Move
  # even on red so CI uploads the report that explains the failure.
  if [[ -f "${tier_dir}/${report_name}" ]]; then
    mv "${tier_dir}/${report_name}" "${BLOB_DIR}/${report_name}" || {
      [[ ${status} -ne 0 ]] || status=1
    }
  elif [[ ${status} -eq 0 ]]; then
    echo "visual-evidence capture: ${report_name} was not produced" >&2
    status=1
  fi
  rm -rf "${tier_dir}" || [[ ${status} -ne 0 ]] || status=1
  return "${status}"
}

# Do not stop after one tier fails: attempt the other tier so CI retains both
# diagnostic reports, then return the first actual Playwright exit status.
EXIT_STATUS=0
if [[ "${MODE}" == "all" || ${#MOCK_SPECS[@]} -gt 0 ]]; then
  if run_capture "playwright.config.ts" "mock-evidence.zip" "0" "${MOCK_SPECS[@]}"; then
    :
  else
    status=$?
    echo "visual-evidence capture: mock tier exited ${status}" >&2
    EXIT_STATUS=${status}
  fi
fi
if [[ "${MODE}" == "all" || ${#REAL_AUTH_SPECS[@]} -gt 0 ]]; then
  if run_capture "playwright.real.config.ts" "real-auth-evidence.zip" "1" "${REAL_AUTH_SPECS[@]}"; then
    :
  else
    status=$?
    echo "visual-evidence capture: real-auth tier exited ${status}" >&2
    [[ ${EXIT_STATUS} -eq 0 ]] && EXIT_STATUS=${status}
  fi
fi

exit "${EXIT_STATUS}"
