#!/usr/bin/env bash
# The pinned Bun toolchain for local and proof runs — source me, then call use_pinned_bun.
#
# The directory is derived from .bun-version, so a pin change edits one file:
#   ${FACTORY_TOOLS_DIR:-/tmp/factory-tools}/bun-<.bun-version>/bun-linux-x64
# Bun's release zip ships only `bun`; Bun's own installer adds `bunx` as a link to it. Without that link `bunx`
# falls through to whatever Bun is next on PATH, so a pinned-first PATH still ran the system Bun for every
# `bunx vite` / `bunx vitest` (the 2026-09-27 pin gap). use_pinned_bun makes the link when it is missing, puts
# the directory first on PATH, and asserts that BOTH `bun --version` and `bunx --version` equal the pin,
# failing by name (return 1) otherwise.

pinned_bun_version() {
  local root self=${BASH_SOURCE[0]:-}
  # Without this file's own path (zsh leaves BASH_SOURCE empty; eval under `bash -c` gives "bash") dirname is
  # ".", and the root would be "$PWD/../..": another tree's pin.
  if [ "${self##*/}" != pinned-bun.sh ] || [ ! -f "$self" ]; then
    echo "pinned-bun.sh: no source path; source this file from bash" >&2
    return 1
  fi
  root=$(cd "$(dirname "$self")/../.." && pwd)
  tr -d '[:space:]' < "$root/.bun-version"
}

pinned_bun_dir() {
  printf '%s/bun-%s/bun-linux-x64\n' "${FACTORY_TOOLS_DIR:-/tmp/factory-tools}" "$(pinned_bun_version)"
}

use_pinned_bun() {
  local want dir bun_seen bunx_seen
  want=$(pinned_bun_version) || return 1
  dir=$(pinned_bun_dir)
  if [ ! -x "$dir/bun" ]; then
    echo "pinned Bun missing: $dir/bun (download bun-v$want bun-linux-x64.zip and verify it against SHASUMS256.txt)" >&2
    return 1
  fi
  [ -e "$dir/bunx" ] || ln -s bun "$dir/bunx"
  export PATH="$dir:$PATH"
  bun_seen=$(bun --version)
  bunx_seen=$(bunx --version)
  if [ "$bun_seen" != "$want" ] || [ "$bunx_seen" != "$want" ]; then
    echo "pinned Bun mismatch: bun $bun_seen, bunx $bunx_seen, .bun-version $want" >&2
    return 1
  fi
}
