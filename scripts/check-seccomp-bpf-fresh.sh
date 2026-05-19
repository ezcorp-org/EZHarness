#!/usr/bin/env bash
#
# check-seccomp-bpf-fresh.sh — CI guard against mcp-seccomp.bpf drift.
#
# Phase 55 Plan 03 (MCP-03). The committed `mcp-seccomp.bpf` artifact is
# generated from `mcp-seccomp.json` by `build/compile-seccomp.c`. If a
# developer edits the JSON but forgets to regenerate the BPF, the source
# of truth and the deployed artifact diverge silently.
#
# This script re-runs the C helper against the committed JSON, compares
# the freshly-compiled output to the committed BPF, and exits non-zero
# on any difference. Mirrors `manifest.lock.json` freshness discipline.
#
# Requirements (Linux + libseccomp dev headers):
#   - gcc on PATH
#   - libseccomp.h + -lseccomp present (Debian: `apt install libseccomp-dev`)
#
# To wire into CI: add a job step that runs this script on push and PR.
# (Plan 03 does NOT modify CI workflow files — that's an out-of-band
# follow-up.)
#
# Usage:
#   bash scripts/check-seccomp-bpf-fresh.sh
#
# Exit codes:
#   0  — committed BPF matches a fresh compile.
#   1  — drift detected; re-run the C helper and commit the new BPF.
#   2  — build environment missing (gcc / libseccomp-dev).

set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v gcc >/dev/null 2>&1; then
  echo "ERROR: gcc not on PATH — install gcc (Debian: apt install gcc)" >&2
  exit 2
fi

# Sanity-check libseccomp by attempting a trivial link. If this fails the
# developer needs libseccomp-dev (Debian) or equivalent.
TMPDIR=$(mktemp -d)
# shellcheck disable=SC2064
trap "rm -rf '$TMPDIR'" EXIT

cat > "$TMPDIR/probe.c" <<'EOF'
#include <seccomp.h>
int main(void) { scmp_filter_ctx ctx = seccomp_init(0); seccomp_release(ctx); return 0; }
EOF

if ! gcc -O0 -o "$TMPDIR/probe" "$TMPDIR/probe.c" -lseccomp 2>"$TMPDIR/probe.err"; then
  echo "ERROR: libseccomp-dev missing (link failed):" >&2
  cat "$TMPDIR/probe.err" >&2
  echo "Install: apt install libseccomp-dev   (Debian / Ubuntu)" >&2
  exit 2
fi

# Re-compile the helper and regenerate the BPF.
gcc -O2 -o "$TMPDIR/compile-seccomp" build/compile-seccomp.c -lseccomp
"$TMPDIR/compile-seccomp" src/extensions/mcp-seccomp.json "$TMPDIR/regenerated.bpf"

if ! cmp -s src/extensions/mcp-seccomp.bpf "$TMPDIR/regenerated.bpf"; then
  echo "ERROR: src/extensions/mcp-seccomp.bpf is stale." >&2
  echo "Re-run this script (or 'docker build .') and commit the regenerated artifact." >&2
  echo "Diff (sizes):" >&2
  echo "  committed:   $(stat -c '%s' src/extensions/mcp-seccomp.bpf) bytes" >&2
  echo "  regenerated: $(stat -c '%s' "$TMPDIR/regenerated.bpf") bytes" >&2
  exit 1
fi

echo "OK: src/extensions/mcp-seccomp.bpf is up-to-date with mcp-seccomp.json."
