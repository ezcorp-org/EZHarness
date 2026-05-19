#!/usr/bin/env bash
# Regenerate dev-mode favicons from the production favicons.
#
# Dev mode (EZCORP_DEV_INDICATOR=1) inverts the logo via CSS to make the
# browser tab visually distinct from prod. Browsers don't apply CSS filters
# to favicon link tags, so we ship pre-inverted PNG variants and swap the
# href server-side in hooks.server.ts. This script regenerates those
# variants whenever the source favicons change.
#
# The filter chain `negate,hue=h=180` matches the CSS
# `invert(1) hue-rotate(180deg)` used for the on-page logo.
set -euo pipefail

cd "$(dirname "$0")/../web/static"

for size in 192 512; do
  ffmpeg -y -loglevel error \
    -i "favicon-${size}.png" \
    -vf "negate,hue=h=180" \
    "favicon-dev-${size}.png"
done

# Single-size 32x32 ico is sufficient for the dev tab icon — multi-size .ico
# packing would need a separate tool.
ffmpeg -y -loglevel error \
  -i "favicon-dev-192.png" \
  -vf "scale=32:32" \
  "favicon-dev.ico"

echo "regenerated: favicon-dev-192.png, favicon-dev-512.png, favicon-dev.ico"
