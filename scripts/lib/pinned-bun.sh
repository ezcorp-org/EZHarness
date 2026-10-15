#!/usr/bin/env bash
# The pinned Bun toolchain for local and proof runs — source me, then call use_pinned_bun.
#
# The directory is derived from .bun-version, so a pin change edits one file:
#   ${FACTORY_TOOLS_DIR:-/tmp/factory-tools}/bun-<.bun-version>/bun-linux-x64
# Bun's release zip ships only `bun`; Bun's own installer adds `bunx` as a link to it. Without that link `bunx`
# falls through to whatever Bun is next on PATH, so a pinned-first PATH still ran the system Bun for every
# `bunx vite` / `bunx vitest` (the 2026-09-27 pin gap). The directory is shared and hash-verified, so this helper
# never writes into it: a missing `bunx` is refused by name, and provisioning adds the link
# (`ln -s bun <dir>/bunx`, see tasks/factory/w12e-GATES.md). use_pinned_bun puts the directory first on PATH and
# asserts that BOTH `bun --version` and `bunx --version` equal the pin, failing by name (return 1) otherwise.
# On a pin listed as affected in src/db/bun-sql-pipelining-defect.json it also exports
# BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING=1 (Bun reads it only from the environment a process starts with, and
# the product refuses Bun.SQL on those releases without it); on any other pin it unsets it.

pinned_bun_root() {
  local self=${BASH_SOURCE[0]:-}
  # Without this file's own path (zsh leaves BASH_SOURCE empty; eval under `bash -c` gives "bash") dirname is
  # ".", and the root would be "$PWD/../..": another tree's pin.
  if [ "${self##*/}" != pinned-bun.sh ] || [ ! -f "$self" ]; then
    echo "pinned-bun.sh: no source path; source this file from bash" >&2
    return 1
  fi
  (cd "$(dirname "$self")/../.." && pwd)
}

pinned_bun_version() {
  local root
  root=$(pinned_bun_root) || return 1
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
  if [ ! -e "$dir/bunx" ]; then
    echo "pinned bunx missing at $dir/bunx; provision it (ln -s bun $dir/bunx)" >&2
    return 1
  fi
  export PATH="$dir:$PATH"
  bun_seen=$(bun --version)
  bunx_seen=$(bunx --version)
  if [ "$bun_seen" != "$want" ] || [ "$bunx_seen" != "$want" ]; then
    echo "pinned Bun mismatch: bun $bun_seen, bunx $bunx_seen, .bun-version $want" >&2
    return 1
  fi
  if grep '"affected"' "$(pinned_bun_root)/src/db/bun-sql-pipelining-defect.json" | grep -qF "\"$want\""; then
    export BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING=1
  else
    unset BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING
  fi
}
