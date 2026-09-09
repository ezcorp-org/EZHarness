#!/usr/bin/env bash
# Exercise the candidate server's compiled embedding dependency and stored result.
set -uo pipefail

export EZ_PRODUCTION_RUNTIME_SCRIPT="scripts/verify-shipping-embeddings.ts"
receipt_dir="${EZ_PRODUCTION_RECEIPT_DIR:-$(pwd)/.cache/terra-shipping/runtime}"

bash scripts/verify-shipping-runtime.sh
runtime_exit=$?

guard_exit=0
if [[ ! -r "$receipt_dir/compose.log" ]]; then
  guard_exit=1
  printf '%s\n' 'embedding compose log is unavailable' >&2
else
  bun scripts/verify-shipping-embedding-log.ts "$receipt_dir/compose.log"
  guard_exit=$?
fi

receipt_exit=0
printf 'runtime_exit=%s\nembedding_log_guard_exit=%s\n' "$runtime_exit" "$guard_exit" > "$receipt_dir/embedding-log-guard.exit" || receipt_exit=1

if [[ "$runtime_exit" -ne 0 ]]; then exit "$runtime_exit"; fi
if [[ "$guard_exit" -ne 0 ]]; then exit "$guard_exit"; fi
exit "$receipt_exit"
