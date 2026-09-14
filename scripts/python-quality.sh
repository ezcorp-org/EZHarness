#!/usr/bin/env bash
# Strict quality lanes for the locked Python distribution (C11 runtime toolchains).
#
# ONE definition shared by CI and local runs. Biome does not analyse Python and
# `bun run typecheck` does not see it, so without this script every Python line
# in the repository is unlinted, untyped, untested and unmeasured.
#
# Tool paths come from the REPOSITORY PINS, never from a machine path:
#   * interpreter  — `.python-version` at the repository root (exact match)
#   * dependencies — each locked project's `uv.lock` via `uv sync --locked`
#   * tool versions — the `dev` dependency group in that project's pyproject.toml
#
# FAIL CLOSED. Every leg below turns a missing input into a non-zero exit, never
# into a skipped success:
#   * no `uv` resolvable                       -> exit 1
#   * interpreter differs from `.python-version` -> exit 1
#   * lock file or project missing             -> exit 1
#   * `uv sync --locked` would change the lock -> exit 1 (that is what --locked means)
#   * test discovery finds ZERO tests          -> exit 1 (Python's own runner exits 5)
#   * a coverage run writes no LCOV record     -> exit 1
#
# MODES
#   lint      ruff over the locked project (lint rules; formatting is not enforced
#             because ruff's formatter would rewrite W02-owned runner source)
#   typecheck strict mypy over the locked project
#   test      standard-library `unittest` discovery, non-empty enforced
#   coverage  `coverage.py` over the same discovery plus one real script
#             invocation, emitted as LCOV with repository-relative `SF:` paths
#             and this producer's `TN:` tag so its line map is never summed
#             with Bun's (see scripts/coverage-config.ts)
#   all       every mode above, in order
#
# Usage: bash scripts/python-quality.sh <lint|typecheck|test|coverage|all>
#        PYTHON_COVERAGE_OUT=<dir> bash scripts/python-quality.sh coverage
set -uo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# Every locked Python project in the repository. Each one carries its own
# pyproject.toml, uv.lock and tests/ directory, and each lane below runs over
# all of them. A project that is not listed here is unlinted, untyped,
# untested and unmeasured, which is the gap this file exists to close.
PROJECTS=(
  "src/factory/runner/python"
  "src/factory/reference-image/python"
)
# The project whose module is additionally executed as a script by the coverage
# lane, with the exit code that invocation must produce.
SCRIPT_LEG_PROJECT="src/factory/runner/python"
PIN_FILE="$REPO_ROOT/.python-version"
# Keep this tag identical to PYTHON_COVERAGE_PRODUCER in scripts/coverage-config.ts.
PRODUCER_TAG="ezcorp-python-coverage"
COVERAGE_OUT="${PYTHON_COVERAGE_OUT:-$REPO_ROOT/coverage-python}"

fail() { echo "python quality: $*" >&2; exit 1; }

[ -f "$PIN_FILE" ] || fail "missing repository Python pin: .python-version"
PINNED_PYTHON=$(tr -d '[:space:]' < "$PIN_FILE")
[ -n "$PINNED_PYTHON" ] || fail ".python-version is empty"
[ "${#PROJECTS[@]}" -gt 0 ] || fail "no locked Python project is listed"
for project_rel in "${PROJECTS[@]}"; do
  [ -d "$REPO_ROOT/$project_rel" ] || fail "missing locked Python project: $project_rel"
  [ -f "$REPO_ROOT/$project_rel/pyproject.toml" ] || fail "missing $project_rel/pyproject.toml"
  [ -f "$REPO_ROOT/$project_rel/uv.lock" ] || fail "missing $project_rel/uv.lock"
  [ -d "$REPO_ROOT/$project_rel/tests" ] || fail "missing $project_rel/tests"
done

# `uv` resolution order: an already-provisioned uv first (CI installs a pinned
# one), then Nix. Neither present is a readiness FAILURE, not a skip.
if command -v uv >/dev/null 2>&1; then
  uv_exec() { uv "$@"; }
elif command -v nix-shell >/dev/null 2>&1; then
  uv_exec() { nix-shell -p uv --run "uv $(printf '%q ' "$@")"; }
elif command -v nix >/dev/null 2>&1; then
  uv_exec() { nix shell nixpkgs#uv -c uv "$@"; }
else
  fail "no 'uv' available; install uv or provide nix-shell. The Python lanes cannot be skipped."
fi

cd "$REPO_ROOT" || fail "cannot enter repository root"

# Run the locked interpreter of EVERY project and compare it with the
# repository pin. A pin file that nothing executes cannot detect skew, which is
# exactly the gap the W00 audit recorded for C11.8, and a second project pinned
# to a different interpreter would reintroduce it.
for project_rel in "${PROJECTS[@]}"; do
  uv_exec sync --locked --project "$project_rel" >/dev/null \
    || fail "'uv sync --locked' failed: $project_rel/uv.lock does not reproduce, or is out of date with pyproject.toml"
  actual=$(uv_exec run --frozen --project "$project_rel" python -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])' 2>/dev/null | tr -d '[:space:]')
  [ -n "$actual" ] || fail "could not read the locked interpreter version of $project_rel"
  [ "$actual" = "$PINNED_PYTHON" ] \
    || fail "Python pin skew: .python-version requires $PINNED_PYTHON, $project_rel resolves $actual"
  ACTUAL_PYTHON="$actual"
done

py() { local project_rel="$1"; shift; uv_exec run --frozen --project "$project_rel" "$@"; }

run_lint() {
  local status=0
  for project_rel in "${PROJECTS[@]}"; do
    echo "→ ruff (locked $project_rel)"
    py "$project_rel" ruff check --output-format=concise "$project_rel" || status=1
  done
  return "$status"
}

run_typecheck() {
  local status=0
  for project_rel in "${PROJECTS[@]}"; do
    echo "→ mypy --strict (locked $project_rel)"
    py "$project_rel" mypy --strict "$project_rel" || status=1
  done
  return "$status"
}

# `python -m unittest discover` exits 5 when it runs zero tests, so an empty
# tree already reds the lane. The explicit count below states the requirement
# in the lane itself rather than relying on that exit code staying that way.
discovered_test_count() {
  local project_rel="$1"
  py "$project_rel" python -c "
import unittest
suite = unittest.defaultTestLoader.discover('$project_rel/tests', pattern='test_*.py', top_level_dir='$project_rel')
print(suite.countTestCases())
" 2>/dev/null | tr -d '[:space:]'
}

require_non_empty_discovery() {
  local project_rel="$1"
  local count
  count=$(discovered_test_count "$project_rel")
  [ -n "$count" ] || fail "standard-library test discovery could not run in $project_rel/tests"
  case "$count" in (*[!0-9]*) fail "test discovery reported a non-numeric count: $count";; esac
  [ "$count" -gt 0 ] || fail "standard-library test discovery found ZERO tests in $project_rel/tests; an empty Python suite is a failure, not a pass"
  echo "→ discovered $count Python test case(s) in $project_rel"
}

run_test() {
  local status=0
  for project_rel in "${PROJECTS[@]}"; do
    require_non_empty_discovery "$project_rel" || return 1
    py "$project_rel" python -m unittest discover -s "$project_rel/tests" -t "$project_rel" -p 'test_*.py' || status=1
  done
  return "$status"
}

run_coverage() {
  local lcov="$COVERAGE_OUT/lcov.info"
  rm -rf "$COVERAGE_OUT"
  mkdir -p "$COVERAGE_OUT" || return 1
  : > "$lcov"
  for project_rel in "${PROJECTS[@]}"; do
    require_non_empty_discovery "$project_rel" || return 1
    local slug data raw
    slug=$(printf '%s' "$project_rel" | tr '/' '-')
    data="$COVERAGE_OUT/.coverage-$slug"
    raw="$COVERAGE_OUT/$slug.raw"
    echo "→ coverage.py over standard-library discovery ($project_rel)"
    py "$project_rel" coverage run --rcfile="$project_rel/pyproject.toml" --data-file="$data" \
      -m unittest discover -s "$project_rel/tests" -t "$project_rel" -p 'test_*.py' || return 1
    # A second, real invocation of the module AS A SCRIPT. Importing it can never
    # execute its `__main__` guard, so without this leg that entry point is an
    # unmeasured line in a shipped runner.
    if [ "$project_rel" = "$SCRIPT_LEG_PROJECT" ]; then
      echo "→ coverage.py over one real script invocation"
      echo '{}' | py "$project_rel" coverage run --rcfile="$project_rel/pyproject.toml" --data-file="$data" --append \
        "$project_rel/c02_runner.py" --request-schema /nonexistent --result-schema /nonexistent
      local script_status=$?
      # The deliberately malformed envelope must be REJECTED (exit 1). Exit 0 would
      # mean the wire gate admitted an envelope with no kind and no value.
      [ "$script_status" -eq 1 ] || { echo "python quality: script leg exited $script_status, expected the rejection exit 1" >&2; return 1; }
    fi
    py "$project_rel" coverage report --rcfile="$project_rel/pyproject.toml" --data-file="$data" -m || return 1
    py "$project_rel" coverage lcov --rcfile="$project_rel/pyproject.toml" --data-file="$data" -o "$raw" || return 1
    [ -s "$raw" ] || { echo "python quality: coverage.py wrote no LCOV for $project_rel" >&2; return 1; }
    # coverage.py emits no TN: record. Tag every source block with this producer
    # so merge-lcov.ts can keep the Python line map separate from Bun's.
    sed "s|^SF:|TN:$PRODUCER_TAG\nSF:|" "$raw" >> "$lcov" || return 1
    rm -f "$raw"
    grep -q "^SF:$project_rel/" "$lcov" \
      || { echo "python quality: LCOV has no repository-relative record for $project_rel" >&2; return 1; }
  done
  echo "→ python LCOV: $lcov"
}

MODE="${1:-}"
case "$MODE" in
  lint) run_lint ;;
  typecheck) run_typecheck ;;
  test) run_test ;;
  coverage) run_coverage ;;
  all)
    status=0
    run_lint || status=1
    run_typecheck || status=1
    run_test || status=1
    run_coverage || status=1
    [ "$status" -eq 0 ] || fail "one or more Python quality lanes failed (see above)"
    ;;
  *)
    echo "usage: $0 <lint|typecheck|test|coverage|all>" >&2
    exit 2
    ;;
esac
status=$?
[ "$status" -eq 0 ] || fail "mode '$MODE' failed"
echo "✓ Python $MODE passed (${#PROJECTS[@]} locked project(s): ${PROJECTS[*]}; interpreter $ACTUAL_PYTHON)"
