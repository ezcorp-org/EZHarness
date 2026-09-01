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
#
# REGRESSION (caught by src/__tests__/git-hooks.test.ts, which drives the real
# .githooks/pre-commit inside a throwaway `git init` fixture that deliberately
# does NOT mirror this whole repo — no scripts/, no .bun-version): sourcing a
# nonexistent file from a caller aborts nothing on its own, but it also never
# DEFINES check_bun_version_skew, so the caller's next line called an undefined
# function ("command not found", exit 127) and pre-commit's `if ! ...; then
# fail; fi` read that as a genuine failure — blocking every commit in ANY repo
# that hadn't yet grown the rest of this tree. The fix has two parts: each
# call site defines a no-op `check_bun_version_skew` BEFORE conditionally
# sourcing this file (so an absent .sh is a silent no-op, not an undefined
# function), and this function separately guards the .ts file it invokes (so
# an absent .ts is a silent no-op too). Never assume either sibling file
# exists — the whole point of this check is to be safe in an environment it
# wasn't written for.
check_bun_version_skew() {
  local self_dir script
  self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  script="$self_dir/../check-bun-version.ts"
  # Missing checker script (e.g. this .sh got sourced but its sibling .ts
  # didn't ship, or was deleted) is the SAME "nothing to check" case
  # check-bun-version.ts's own main() already treats a missing .bun-version
  # as: never block a run over this script's own absence. See the
  # call-site guard in scripts/test.sh et al. for the companion case (this
  # file itself missing) — src/__tests__/git-hooks.test.ts pins both.
  [ -f "$script" ] || return 0
  bun "$script"
}
