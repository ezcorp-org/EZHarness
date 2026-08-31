#!/usr/bin/env bash
# Shared bun version-skew guard — sourced by every entry point where running
# the wrong bun either corrupts results (scripts/test.sh, scripts/test-coverage.sh,
# scripts/test-web.sh) or interrupts a developer who is already looking at
# the terminal (.githooks/pre-commit, .githooks/pre-push). ONE definition so
# the check can't drift into three different implementations (or silently
# exist in some call sites and not others).
#
# The actual comparison + warn/fail decision lives in scripts/check-bun-version.ts
# (unit-tested in src/__tests__/check-bun-version.test.ts) — this file is just
# the one-line seam bash callers use to reach it. Self-contained: it resolves
# the repo root from its OWN location rather than relying on a caller's
# SCRIPT_DIR/ROOT variable, so it can be sourced from anywhere without name
# collisions.
#
# Exits the CALLING shell with status 1 on a minor/major skew (the script's
# own exit code, unless EZ_SKIP_BUN_VERSION_CHECK=1) — callers running under
# `set -e` (the three test wrappers) stop there before any test executes; the
# two hooks call this explicitly and check the exit code themselves. A
# patch-level skew (or an unparseable version) only warns to stderr and
# returns 0. On CI this is a no-op: every workflow installs bun from the same
# `.bun-version` this script reads, so the two versions always match there.
check_bun_version_skew() {
  local self_dir
  self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  bun "$self_dir/../check-bun-version.ts"
}
