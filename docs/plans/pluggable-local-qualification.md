# Local runtime qualification

## Decision

Use rootless Podman with a fixed-size, rootless FUSE filesystem for the first local native-EZHarness fixture. The fixture qualifies the runtime controls needed by the local `linux-exec.v1` profile. It does not by itself qualify a provider extension or engine routing.

Do not offer `persistent-web-compose.v1` on this recipe. An inner engine would need elevated access or the host Podman socket. The first weakens containment. The second grants host-engine authority. Neither option proves that inner container storage, logs, and processes remain inside the outer limits.

The local fixture does not claim remote networking, an external provider, portability, or production support.

## Reproducible probe

The probe uses an image that is already in local Podman storage. It does not pull an image, start a daemon, change the network, or change host configuration. Every container has a unique name and an ownership label. Limits are 0.5 CPU, 128 MiB memory with no swap, 32 PIDs, and a 16 MiB temporary filesystem. The root filesystem is read-only. Networking is disabled. All capabilities are dropped. `no-new-privileges` and seccomp are active.

Run the full local check under the shared heavy-run lock:

```sh
flock /tmp/ezcorp-validation-heavy.lock \
  scripts/pluggable-infrastructure/test-qualify-local-runtime.sh
```

Write one receipt:

```sh
python3 scripts/pluggable-infrastructure/qualify-local-runtime.py \
  --profile canary \
  --receipt /tmp/ezpi-canary.json
```

The receipt contains the Podman image ID, runtime and kernel identity, observed cgroup files, per-control evidence, cleanup evidence, and the final decision. Exit code `0` means every required control for the selected profile passed. Exit code `2` means rejection.

The test proves that a passing canary becomes a rejection when one control is removed:

```sh
python3 scripts/pluggable-infrastructure/qualify-local-runtime.py \
  --profile canary \
  --simulate-missing-control cpu-ceiling
```

## Proven local behavior

The canary reads CPU, memory, swap, and PID ceilings from the live cgroup. It reads the effective capability mask from the container process. It writes a marker only in the owned workspace, rejects a root filesystem write, runs and cancels a child process, truncates retained output, restarts the container, and reads the same workspace marker after restart. Cleanup removes the container and temporary workspace and then searches by the unique ownership label for leftovers.

The persistent workspace is a fixed 32 MiB ext2 image, mounted by rootless `fuse2fs` and then bind-mounted into the container. A write larger than the filesystem reaches `ENOSPC`. The fixture removes the container, unmounts the filesystem, runs a forced `e2fsck`, remounts the image, and verifies that the guest marker remains. It also records host allocated bytes and rejects allocation above the image's logical size. The image size is the hard storage boundary and does not depend on a disk-usage watchdog.

## Measured gaps and next recipe

`podman create --storage-opt size=64m` was tested on this host. Podman rejected it because overlay size and inode quotas require an XFS backing filesystem; this Podman store uses extfs. The rootless FUSE image supplies the missing workspace byte boundary without host filesystem or daemon changes. The recipe uses ext2 because `fuse2fs` does not support the ext4 journal. Clean unmount and a filesystem check before recovery are mandatory.

KVM and QEMU are installed, but no reusable Linux guest disk is present. A later VM recipe needs a pinned Linux image, a non-root guest account, Bun and Git, a guest control transport, process-tree cancellation, and verified cleanup. The local MVP does not need that larger recipe.

## Runtime basis

The probe follows the current Podman run contract. Podman documents that `--cpus`, `--memory`, and `--pids-limit` map to cgroup controls; `--network=none` creates an unconfigured network namespace; and `--read-only` makes the root filesystem read-only. It also warns that rootless resource controls depend on the host and are unsupported with cgroups v1. The probe therefore checks the real cgroup v2 values instead of trusting accepted flags. See [Podman run](https://docs.podman.io/en/latest/markdown/podman-run.1.html).

Podman documents that privileged mode disables major isolation controls, including dropped capabilities, read-only mounts, and seccomp. The Compose probe does not use privileged mode to make nesting pass. See [Podman create](https://docs.podman.io/en/latest/markdown/podman-create.1.html#privileged).

## Production driver recovery proof

The production driver has a separate repeatable check. It starts a real managed
process, exits the first host client, and uses a second host client to read its
identity and retained output, cancel it, read the saved workspace, run another
command, and destroy the workspace. The final check requires no owned container
or filesystem mount to remain.

```sh
EZ_FUSE2FS_PATH=/absolute/path/to/fuse2fs \
EZ_LOCAL_IMAGE='localhost/ezharness-local-mvp@sha256:<manifest-digest>' \
EZ_LOCAL_DRIVER_RECEIPT=/tmp/local-driver-receipt.json \
bun scripts/pluggable-infrastructure/qualify-production-local-driver.ts
```

The script compiles the production supervisor and creates its own private state
directory. Its two client processes use the same production driver and persisted
state. This proves driver recovery across client exits; the browser qualification
separately exercises provider approval, application routing, and native tools.
