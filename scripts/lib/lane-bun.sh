#!/usr/bin/env bash
# Browser lanes run their server under the `bun` PATH resolves. lane_bun_pin puts
# the pinned Bun (.bun-version) first on PATH when it can find it
# (EZCORP_PINNED_BUN_DIR, then ~/.bun/bin), and fails by name, with both versions,
# when the resolved `bun --version` still differs. web/playwright-lane-bun.ts is the same
# guard inside every Playwright config's webServer. Source this file, then call
# lane_bun_pin before starting anything.
lane_bun_pin() {
  local root want dir have
  # Bash builtins only: this runs before PATH is trusted, so it needs no dirname or tr.
  root="${BASH_SOURCE[0]%/*}/../.."
  read -r want < "$root/.bun-version" || true
  want="${want//[[:space:]]/}"
  for dir in "${EZCORP_PINNED_BUN_DIR:-}" "${HOME:-}/.bun/bin"; do
    if [ -n "$dir" ] && [ -x "$dir/bun" ] && [ "$("$dir/bun" --version 2>/dev/null)" = "$want" ]; then
      PATH="$dir:$PATH"
      export PATH
      break
    fi
  done
  have="$(bun --version 2>/dev/null || echo "none (no bun on PATH)")"
  if [ "$have" != "$want" ]; then
    echo "lane Bun mismatch: PATH resolves bun $have ($(command -v bun || echo 'no bun')), .bun-version pins $want. Set EZCORP_PINNED_BUN_DIR to a directory holding bun $want." >&2
    return 1
  fi
}
