#!/bin/sh
# Install the legacy release's own pgvector asset where its server chunk resolves it, and refuse anything but the
# pinned bytes. Run inside the legacy image by scripts/Dockerfile.legacy-adoption-derived, and by
# src/__tests__/legacy-adoption-vector-pin.test.ts against temporary files.
#
# Usage: legacy-vector-asset.sh <package dir> <target file> <expected sha256> <expected version>
# Exits non-zero, and leaves no target, when the package's version or the asset's sha256 is not the pinned one.
set -eu
package_dir="$1"
target="$2"
expected_sha256="$3"
expected_version="$4"
[ -n "$expected_sha256" ] && [ -n "$expected_version" ] || { echo "legacy vector asset: no pinned sha256 or version" >&2; exit 2; }
grep -q "\"version\": \"$expected_version\"" "$package_dir/package.json" || {
  echo "legacy vector asset: $package_dir is not pglite-pgvector $expected_version" >&2
  exit 1
}
actual_sha256="$(sha256sum "$package_dir/dist/vector.tar.gz" | cut -d ' ' -f 1)"
[ "$actual_sha256" = "$expected_sha256" ] || {
  echo "legacy vector asset: sha256 $actual_sha256, pinned $expected_sha256" >&2
  exit 1
}
cp "$package_dir/dist/vector.tar.gz" "$target"
