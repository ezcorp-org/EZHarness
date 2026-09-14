#!/usr/bin/env bash
set -euo pipefail

# Trusted fixtures only. ROCm on this host requires both render devices during
# initialization. ROCR_VISIBLE_DEVICES is a selector, not an authority boundary.
readonly repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly image='docker.io/rocm/pytorch@sha256:0f6e6e98a3d60159443962394866696fa5977b42369413053c3158caf485980d'
readonly runtime_base="${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR is required.}"
[[ "$(stat -c '%a:%u' "$runtime_base")" == "700:$UID" ]]
exec 9>"$runtime_base/ezcorp-factory-local-gpu.lock"
flock -n 9 || { printf '%s\n' 'Another local factory GPU proof is active.' >&2; exit 1; }

# The fixture is staged as a readable copy under the user runtime directory.
# A checkout made with a restrictive umask leaves the source file unreadable by
# the container's mapped user, which would fail this proof for a reason that has
# nothing to do with the GPU.
readonly staged="$runtime_base/factory-local-gpu-fixture.py"
install -m 0444 "$repo_root/scripts/fixtures/factory-local-gpu.py" "$staged"
trap 'rm -f -- "$staged"' EXIT

readonly common=(--rm --network=none --read-only --user=65532:65532
  --cap-drop=ALL --security-opt=no-new-privileges --ipc=private
  --env ROCR_VISIBLE_DEVICES=0 --env HOME=/tmp
  --tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m --shm-size=256m
  --memory=8g --cpus=4 --pids-limit=256
  --label owner=factory-platform-proof
  --mount "type=bind,src=$staged,dst=/proof.py,ro")

for tenant in $(seq 1 10); do
  podman run "${common[@]}" --device=/dev/kfd \
    --device=/dev/dri/renderD128 --device=/dev/dri/renderD129 \
    "$image" python /proof.py "$tenant"
done

negative_log="$(mktemp "$runtime_base/factory-gpu-negative.XXXXXXXX")"
trap 'rm -f -- "$negative_log" "$staged"' EXIT
if podman run "${common[@]}" "$image" python /proof.py 1 >"$negative_log" 2>&1; then
  printf '%s\n' 'GPU proof incorrectly passed without devices.' >&2
  exit 1
fi
rg -q 'AssertionError: GPU_REQUIRED' "$negative_log"
printf '%s\n' 'Ten fresh GPU fixture containers passed; missing-device control failed as required.'
