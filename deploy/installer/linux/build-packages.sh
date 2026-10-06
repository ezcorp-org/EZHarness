#!/usr/bin/env bash
# Build the EZCorp installer's .deb and .rpm for one architecture.
#
#   EZCORP_PKG_MAINTAINER="Name <email>" \
#     bash deploy/installer/linux/build-packages.sh <amd64|arm64> <X.Y.Z> <outdir>
#
# The package version is also the EZCorp image version the installer pulls by
# default, so package 1.4.0 installs ghcr.io/ezcorp-org/ezcorp:1.4.0 — a
# package can never silently install a different app than its version says.
#
# Needs: nfpm, curl, and sha256sum or shasum.
set -euo pipefail

ARCH="${1:?usage: build-packages.sh <amd64|arm64> <version> <outdir>}"
VERSION="${2:?usage: build-packages.sh <amd64|arm64> <version> <outdir>}"
OUT="${3:?usage: build-packages.sh <amd64|arm64> <version> <outdir>}"

: "${EZCORP_PKG_MAINTAINER:?set EZCORP_PKG_MAINTAINER (\"Name <email>\"); the repo declares no contact and a package must not invent one}"

case "$ARCH" in
  amd64) COMPOSE_ARCH=x86_64 ;;
  arm64) COMPOSE_ARCH=aarch64 ;;
  *) echo "error: unsupported arch '$ARCH' (amd64 or arm64)" >&2; exit 1 ;;
esac
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "error: version must be X.Y.Z, got '$VERSION'" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$INSTALLER/../.." && pwd)"

# shellcheck source=deploy/installer/linux/compose.lock
. "$HERE/compose.lock"
expected_var="COMPOSE_SHA256_$COMPOSE_ARCH"
EXPECTED_SHA="${!expected_var:?no pinned checksum for $COMPOSE_ARCH in compose.lock}"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
LIB="$STAGE/usr/lib/ezcorp"
mkdir -p "$LIB" "$STAGE/usr/bin" "$STAGE/usr/share/applications" \
  "$STAGE/usr/share/icons/hicolor/512x512/apps"

# ── Vendored compose: downloaded over HTTPS only, packaged only if it matches ─
compose_url="https://github.com/docker/compose/releases/download/$COMPOSE_VERSION/docker-compose-linux-$COMPOSE_ARCH"
curl -fsSL --proto '=https' --tlsv1.2 -o "$LIB/docker-compose" "$compose_url"
actual_sha="$(sha256 "$LIB/docker-compose")"
if [ "$actual_sha" != "$EXPECTED_SHA" ]; then
  echo "error: docker-compose $COMPOSE_VERSION ($COMPOSE_ARCH) checksum mismatch" >&2
  echo "  expected $EXPECTED_SHA" >&2
  echo "  actual   $actual_sha" >&2
  exit 1
fi
chmod 0755 "$LIB/docker-compose"

# ── The installer core and everything it expects beside itself ──────────────
install -m 0755 "$INSTALLER/ezcorp" "$LIB/ezcorp"
for f in compose.installer.yml compose.machine.yml compose.isolated.yml compose.trusted-local.yml; do
  install -m 0644 "$INSTALLER/$f" "$LIB/$f"
done
# The core looks for searxng/ beside itself before falling back to the repo
# layout (../searxng), so the packaged copy sits beside it.
cp -R "$REPO/deploy/searxng" "$LIB/searxng"

# Pin the default image to this package's version.
sed -i.bak "s/^VERSION_FALLBACK=\".*\"$/VERSION_FALLBACK=\"$VERSION\"/" "$LIB/ezcorp"
rm -f "$LIB/ezcorp.bak"
grep -q "^VERSION_FALLBACK=\"$VERSION\"$" "$LIB/ezcorp" \
  || { echo "error: could not pin VERSION_FALLBACK to $VERSION" >&2; exit 1; }

install -m 0755 "$HERE/ezcorp-wrapper" "$STAGE/usr/bin/ezcorp"
install -m 0644 "$HERE/ezcorp.desktop" "$STAGE/usr/share/applications/ezcorp.desktop"
install -m 0644 "$REPO/web/static/favicon-512.png" "$STAGE/usr/share/icons/hicolor/512x512/apps/ezcorp.png"
install -m 0755 "$HERE/postinstall.sh" "$STAGE/postinstall.sh"

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
for packager in deb rpm; do
  (cd "$STAGE" && EZCORP_PKG_ARCH="$ARCH" EZCORP_PKG_VERSION="$VERSION" \
    nfpm package --config "$HERE/nfpm.yaml" --packager "$packager" --target "$OUT")
done
ls -l "$OUT"
