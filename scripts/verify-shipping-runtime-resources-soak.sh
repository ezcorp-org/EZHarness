#!/usr/bin/env bash
# Opt-in R4 duration soak. It performs continuous real lifecycle cycles;
# it does not use idle time to satisfy the requested duration.
set -euo pipefail

minimum_seconds="${EZ_RUNTIME_RESOURCE_MIN_DURATION_SECONDS:-1800}"
maximum_cycles="${EZ_RUNTIME_RESOURCE_MAX_CYCLES:-1440}"
grace_seconds="${EZ_RUNTIME_RESOURCE_SOAK_GRACE_SECONDS:-600}"

integer_between() {
  local value="$1" name="$2" minimum="$3" maximum="$4"
  [[ "$value" =~ ^[0-9]+$ ]] && (( value >= minimum && value <= maximum )) || {
    echo "$name must be an integer from $minimum through $maximum." >&2
    exit 2
  }
}
integer_between "$minimum_seconds" EZ_RUNTIME_RESOURCE_MIN_DURATION_SECONDS 1800 86400
integer_between "$maximum_cycles" EZ_RUNTIME_RESOURCE_MAX_CYCLES 10 5000
integer_between "$grace_seconds" EZ_RUNTIME_RESOURCE_SOAK_GRACE_SECONDS 60 3600

export EZ_RUNTIME_RESOURCE_MIN_DURATION_SECONDS="$minimum_seconds"
export EZ_RUNTIME_RESOURCE_MAX_CYCLES="$maximum_cycles"
export EZ_PRODUCTION_RUNTIME_SCRIPT="scripts/verify-shipping-runtime-resources.ts"
# The verifier records actual elapsed time. This outer bound is only the
# failure guard for a wedged app, runner, or lifecycle operation.
exec timeout --foreground --kill-after=30s "$((minimum_seconds + grace_seconds))s" bash scripts/verify-shipping-runtime.sh
