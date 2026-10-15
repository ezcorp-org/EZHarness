#!/usr/bin/env bash
# Browser lanes run their server under the `bun` PATH resolves. lane_bun_pin puts
# the pinned Bun (.bun-version) first on PATH when it can find it
# (EZCORP_PINNED_BUN_DIR, then ~/.bun/bin), and fails by name, with both versions,
# when the resolved `bun --version` or `bunx --version` still differs. web/playwright-lane-bun.ts is the same
# guard inside every Playwright config's webServer. Source this file, then call
# lane_bun_pin before starting anything.
lane_bun_pin() {
  local root want dir have
  # Bash builtins only: this runs before PATH is trusted, so it needs no dirname or tr.
  root="${BASH_SOURCE[0]%/*}/../.."
  read -r want < "$root/.bun-version" || true
  want="${want//[[:space:]]/}"
  # A pinned directory counts only when it holds both entry points: a lane runs
  # `bunx` (vite builds, vitest, Playwright) as well as `bun`.
  for dir in "${EZCORP_PINNED_BUN_DIR:-}" "${HOME:-}/.bun/bin"; do
    if [ -n "$dir" ] && [ -x "$dir/bun" ] && [ -x "$dir/bunx" ] \
      && [ "$("$dir/bun" --version 2>/dev/null)" = "$want" ] && [ "$("$dir/bunx" --version 2>/dev/null)" = "$want" ]; then
      PATH="$dir:$PATH"
      export PATH
      break
    fi
  done
  local tool status=0 record=()
  for tool in bun bunx; do
    have="$("$tool" --version 2>/dev/null || echo "none (no $tool on PATH)")"
    if [ "$have" != "$want" ]; then
      echo "lane Bun mismatch: PATH resolves $tool $have ($(command -v "$tool" || echo "no $tool")), .bun-version pins $want. Set EZCORP_PINNED_BUN_DIR to a directory holding bun and bunx $want." >&2
      status=1
    fi
    record+=("$tool $have ($(command -v "$tool"))")
  done
  # On a pass, name what was asserted: the lane log is the only record of the runtime its servers ran under.
  [ "$status" -ne 0 ] || echo "lane Bun: ${record[0]}, ${record[1]}" >&2
  return "$status"
}

# pinned_bun_binary prints the path of a `bun` whose --version equals .bun-version, and leaves PATH alone. It looks
# in EZCORP_PINNED_BUN_DIR, then ~/.bun/bin, then each PATH entry in order. Repository tooling that must not run under a
# substitute calls the binary it prints. Examples of a substitute: a test's fake `bun` first on PATH, or a stale system Bun.
# The lane manifest lookup in scripts/lib/test-file-sets.sh is one such caller. It fails by name when no candidate matches.
pinned_bun_binary() {
  local root want dir IFS=:
  root="${BASH_SOURCE[0]%/*}/../.."
  read -r want < "$root/.bun-version" || true
  want="${want//[[:space:]]/}"
  for dir in "${EZCORP_PINNED_BUN_DIR:-}" "${HOME:-}/.bun/bin" $PATH; do
    if [ -n "$dir" ] && [ -x "$dir/bun" ] && [ "$("$dir/bun" --version 2>/dev/null)" = "$want" ]; then
      printf '%s\n' "$dir/bun"
      return 0
    fi
  done
  echo "pinned Bun: no bun $want in EZCORP_PINNED_BUN_DIR, ~/.bun/bin or PATH (.bun-version pins $want)" >&2
  return 1
}
