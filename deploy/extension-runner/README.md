# Extension runner deployment

Run the runner on the Linux host under a dedicated non-root account. The app receives only the runner Unix socket and its credential. Never expose a Podman socket to the app or to an extension.

Requirements: Podman 5 with rootless cgroup v2 CPU, memory and PID controllers; Python 3.11 or newer for Linux `SO_PEERCRED`; util-linux `flock` and `setpriv`; the repository's pinned Bun and installed lockfile dependency closure; a local image matching `DEFAULT_IMAGE`. Provision the SDK and TypeScript only from the installed trusted application release. Builds never resolve packages from the app's dependency tree.

## NixOS and systemd

1. Enable `virtualisation.podman.enable = true`. Create a dedicated normal user named `ez-extension-runner` with subordinate UID/GID ranges and a home directory. Install Podman, Python 3 and the pinned Bun for this account. Use a separate group containing the runner and application service account for the socket directory.
2. Enable lingering for that account with `loginctl enable-linger ez-extension-runner`. Install `extension-runner.service` in its user systemd directory. Set `WorkingDirectory` and `ExecStart` to the immutable installed application release and pinned Bun binary. Rootless Podman must use that account's user systemd manager; do not run it as root.
3. Create a private artifact store owned by the runner, mode `0700`. Create a socket directory owned by the runner and shared application group, mode `0750`. Generate at least 32 random bytes for the shared credential. Keep the credential file readable only by the runner and the application's secret delivery mechanism. Do not place credentials in source control.
4. Create `%h/.config/ezharness/runner.env`, mode `0600`, with `EZ_EXTENSION_RUNNER_SOCKET`, `EZ_EXTENSION_RUNNER_TOKEN_FILE`, `EZ_EXTENSION_RUNNER_STORE`, and `EZ_EXTENSION_APP_UID`. The UID is the application's host-visible Unix peer UID, including any container user namespace mapping. The gateway checks this exact UID as well as the bearer credential.
5. Pre-pull `docker.io/oven/bun@sha256:50317d83cd5a5ae1d8b35b3379c69f57ce1a0dbf4def91f0965653d767851834` under the runner account. This is the tested Bun 1.3.14 image. Runtime execution uses `--pull=never`; an absent image is an error.
6. Start the user service. Initialization verifies actual container UID, seccomp, capabilities, no-new-privileges, read-only root, network routes and cgroup settings. A failed check prevents service startup. No command in this setup is run automatically by the application.

Merge `compose.runner.yml` into the existing application Compose deployment and set the two required host paths. Configure the application-side secret reader to pass the token to `RunnerClient`. The socket mount is the only shared host directory; its private runner subdirectory is `0700` and cannot be read by the app account.

## Validation and operation

Run `bun test --cwd packages/@ezcorp/extension-runner` under a Linux test account with the same controls and cached pinned image. The integration suite requires real Podman and does not skip when isolation is missing. It tests build, typecheck, test failures, metadata discovery, reverse RPC, immutable artifacts, repeatability, host/network denial, kernel resource limits and descendant cancellation. Unit tests separately check Unix peer identity and credentials, framing and malformed output.

The runner permits one build and four executions by default. Excess work returns a retryable queue diagnostic to the durable host lifecycle. A kernel file lock permits only one runner per store. A runner restart removes its labelled orphan containers and retains immutable artifacts; the gateway recovers an owned stale socket only after confirming that no listener is active. The host lifecycle reconciles interrupted operations; runner in-memory inspection alone is not a durable operation journal. Keep the store and its reference inventory in the host backup policy. Only the host may decide which unreferenced artifacts to remove.

The seccomp allowlist is vendored from containers/common `v0.64.2`, `pkg/seccomp/seccomp.json`. Its hash is recorded in each artifact recipe. Updating the image, SDK, compiler or profile changes build evidence and requires release review.

`TrustedLocalRunner` is a separate, explicit admin-only adapter. It verifies the pinned Bun binary, dedicated UID, exact source or artifact digest approval, expiry and all omitted controls, then awaits an audit write. It never runs after an automatic Podman failure. It shares the build and protocol logic but cannot protect host files, network or cgroup resources against malicious code. The application must label this profile `trusted-local` and separately approve activation.
