#!/usr/bin/env bash
# Production Stage 2 raw-TCP proof in an owned Podman container.
#
# The parent container owns a bridge, gateway, and forbidden-peer listener.
# The child enters the production unshare -U -n -m path. We move one veth peer
# into that child netns before releasing the launcher's one-byte handshake.

set -euo pipefail

mode="${1:---nft-on}"
case "$mode" in
  --nft-on|--nft-off|--ipv6-on|--ipv6-off) ;;
  *) echo "usage: $0 [--nft-on|--nft-off|--ipv6-on|--ipv6-off]" >&2; exit 64 ;;
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

podman_args=(run --rm --timeout=25 --network=private --user 0 --cap-add=NET_ADMIN --security-opt unmask=/proc/sys)
if [ -n "$conmon" ]; then
  export CONMON="$conmon"
fi

exec podman "${podman_args[@]}" \
  -v "$launcher:/app/src/extensions/mcp-launcher.sh:ro" \
  -v "$script_dir/../src/extensions/mcp-proxy.ts:/app/src/extensions/mcp-proxy.ts:ro" \
  -v "$script_dir/lib/stage2-network-proof.mjs:/app/scripts/lib/stage2-network-proof.mjs:ro" \
  -e "EZCORP_STAGE2_PROOF_MODE=$mode" \
  "$EZCORP_STAGE2_PROOF_IMAGE" bun /app/scripts/lib/stage2-network-proof.mjs
