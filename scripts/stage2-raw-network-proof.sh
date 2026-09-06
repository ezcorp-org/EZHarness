#!/usr/bin/env bash
# Production Stage 2 raw-TCP proof in an owned Podman container.
#
# The parent container owns a bridge, gateway, and forbidden-peer listener.
# The child enters the production unshare -U -n -m path. We move one veth peer
# into that child netns before releasing the launcher's one-byte handshake.

set -euo pipefail

mode="${1:---nft-on}"
case "$mode" in
  --nft-on|--nft-off|--ipv6-on|--ipv6-off|--soak) ;;
  *) echo "usage: $0 [--nft-on|--nft-off|--ipv6-on|--ipv6-off|--soak]" >&2; exit 64 ;;
esac

: "${EZCORP_STAGE2_PROOF_IMAGE:?set EZCORP_STAGE2_PROOF_IMAGE to the candidate production image}"
conmon="${CONMON:-}"
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
launcher="${EZCORP_STAGE2_PROOF_LAUNCHER:-$script_dir/../src/extensions/mcp-launcher.sh}"
if [ ! -f "$launcher" ]; then
  echo "missing production launcher source: $launcher" >&2
  exit 66
fi
launcher="$(cd -- "$(dirname -- "$launcher")" && pwd)/$(basename -- "$launcher")"

seconds="${EZCORP_STAGE2_SOAK_SECONDS:-300}"
if [[ ! "$seconds" =~ ^[0-9]+$ ]] || (( seconds < 1 || seconds > 86400 )); then
  echo "Soak duration must be 1-86400 seconds" >&2; exit 64
fi
container_timeout=25
if [[ "$mode" == --soak ]]; then container_timeout=$((seconds + 30)); fi
podman_args=(run --rm --timeout="$container_timeout" --network=private --user 0 --cap-add=NET_ADMIN --security-opt unmask=/proc/sys)
if [[ -n "${EZCORP_STAGE2_RUN_ID:-}" ]]; then
  podman_args+=(--label "ezcorp.stage2-proof=$EZCORP_STAGE2_RUN_ID")
fi
if [ -n "$conmon" ]; then
  export CONMON="$conmon"
fi

exec podman "${podman_args[@]}" \
  -v "$launcher:/app/src/extensions/mcp-launcher.sh:ro" \
  -v "$script_dir/../src/extensions/mcp-proxy.ts:/app/src/extensions/mcp-proxy.ts:ro" \
  -v "$script_dir/lib/stage2-network-proof.mjs:/app/scripts/lib/stage2-network-proof.mjs:ro" \
  -e "EZCORP_STAGE2_SOAK_SECONDS=$seconds" -e "EZCORP_STAGE2_SOAK_REQUESTS=${EZCORP_STAGE2_SOAK_REQUESTS:-100}" -e "EZCORP_STAGE2_PROOF_MODE=$mode" \
  -e "EZCORP_STAGE2_KILL_WORKER=${EZCORP_STAGE2_KILL_WORKER:-0}" \
  "$EZCORP_STAGE2_PROOF_IMAGE" bun /app/scripts/lib/stage2-network-proof.mjs
