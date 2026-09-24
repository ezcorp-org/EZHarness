#!/usr/bin/env bash
set -euo pipefail

readonly reference='localhost/ezharness-local-mvp@sha256:cbdad798c9d85113d326c04eddcea0e3ce272dedb00465e66aa6c6a2e8e4a437'
readonly expected_id='d13851b203d0a53c1f83dc64e1eb6457eba2cfeb5a66066cbe5d63ac4f414aa7'

actual_id="$(podman --remote=false image inspect "$reference" --format '{{.Id}}')"
actual_id="${actual_id#sha256:}"
if [[ "$actual_id" != "$expected_id" ]]; then
  printf 'local runtime image ID mismatch: expected %s, got %s\n' "$expected_id" "$actual_id" >&2
  exit 1
fi

printf '%s\n' "$reference"
printf 'imageId=%s\n' "$actual_id"
