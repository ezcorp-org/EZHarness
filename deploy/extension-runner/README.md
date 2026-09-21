# Extension runner deployment

Set `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` before starting Bun for both the host and runner. Bun 1.3.14 can reuse environment constants from a previous process when its persistent transpiler cache is enabled. This can select an old database or runner credential. The service unit and test launch scripts disable this cache. This does not disable the immutable extension artifact store.

Run the runner on the Linux host under a dedicated non-root account. The app receives only the runner Unix socket and its credential. Never expose a Podman socket to the app or to an extension.

Requirements: Podman 5 with rootless cgroup v2 CPU, memory and PID controllers; Python 3.11 or newer for Linux `SO_PEERCRED`; util-linux `flock` and `setpriv`; the repository's pinned Bun and installed lockfile dependency closure; a local image matching `DEFAULT_IMAGE`. Provision the SDK and TypeScript only from the installed trusted application release. Builds never resolve packages from the app's dependency tree.

## Default app connection

Both `docker-compose.yml` and `compose.prod.yml` inherit the same connection from `compose.runner.yml`. There is no extra `-f` flag to remember. The runner remains a separate host service; Compose does not install host packages, create a service account, or launch nested Podman.

Provision the host service below before the first app start. The default host paths are:

- Socket: `/run/ez-extension-runner/runner.sock`
- Credential: `/etc/ezharness/extension-runner-token`

For an existing runner, set `EZ_RUNNER_SOCKET_DIR` and `EZ_RUNNER_TOKEN_FILE` in `.env` (dev) or `.env.prod` (production). The paths must name the directory containing that runner's socket and its actual credential file. The documented Linux development command, `bun run podman`, derives `EZ_RUNNER_GROUP` from the socket and the live rootless Podman map when the variable is unset. Do not set it to an empty value.

For direct Docker Compose, export the socket's numeric host GID before Compose:

```sh
export EZ_RUNNER_GROUP="$(bash scripts/resolve-runner-group.sh --docker)"
docker compose up -d
```

The resolver does not load Compose dotenv files. If `EZ_RUNNER_SOCKET_DIR` in
`.env` is not the default path, pass that same path to the resolver command:

```sh
export EZ_RUNNER_GROUP="$(EZ_RUNNER_SOCKET_DIR=/path/to/runner bash scripts/resolve-runner-group.sh --docker)"
docker compose up -d
```

For direct Docker Compose pointed at rootless Podman, use `--podman` instead. Use a verified numeric `EZ_RUNNER_GROUP`. The Podman wrapper rejects empty and non-numeric shell overrides before it invokes Compose. It leaves `.env` and `--env-file` values to Compose, whose required-variable check rejects an empty value.

Rootless Podman needs an explicit user-namespace mapping. Pick an unused container GID (the verifier uses `1`) and find its host GID from `podman unshare cat /proc/self/gid_map`: within the matching row, `host_gid = row_host_start + container_gid - row_container_start`. Create the shared host group with that host GID, add the runner account to it, use it on the directory, socket, and credential, and set `EZ_RUNNER_GROUP` to the container GID. Do not set `keep-groups`: Docker Compose sends it through the Podman API as a literal group name, which Podman rejects.

Before Compose starts the app, check the host objects with `test -S "$EZ_RUNNER_SOCKET_DIR/runner.sock"`, `test -f "$EZ_RUNNER_TOKEN_FILE"`, and `stat -c '%A %u:%g %n' "$EZ_RUNNER_SOCKET_DIR" "$EZ_RUNNER_SOCKET_DIR/runner.sock" "$EZ_RUNNER_TOKEN_FILE"`. The directory should be setgid `2750`, the socket `0660`, and the credential `0640` or stricter, all with the shared group. Compose requires all three settings before it asks the container engine to mount anything and keeps `create_host_path: false`. If a configured host path is absent, Docker or Podman rejects the mount before the application entrypoint can print a message; fix the path on the host and run the checks above.

At each app start, a 15-second check calls the runner through the real app UID and credential reader. A missing socket, rejected credential, wrong peer UID or stalled runner prevents app startup. Start the host runner first, then recreate the app. Existing deployments need an image rebuild for the startup check. Extension code still needs its normal tests and exact human approval.

## NixOS and systemd

1. Enable `virtualisation.podman.enable = true`. Create a dedicated normal user named `ez-extension-runner` with subordinate UID/GID ranges and a home directory. Install Podman, Python 3 and the pinned Bun for this account. Use a separate group containing the runner account whose GID is visible inside the application container as described above.
2. Enable lingering for that account with `loginctl enable-linger ez-extension-runner`. Install `extension-runner.service` in its user systemd directory. Set `WorkingDirectory` and `ExecStart` to the immutable installed application release and pinned Bun binary. Rootless Podman must use that account's user systemd manager; do not run it as root. The supplied unit includes Nix profile paths and checks `podman`, `python3`, `flock` and `setpriv` before launch. On NixOS install `pkgs.util-linux` as well as Podman, Python and pinned Bun; user services do not inherit your shell PATH.
3. Create a private artifact store owned by the runner, mode `0700`. Create a socket directory owned by the runner and shared application group, mode `2750`. Configure the runner to create its socket as `0660`. Generate at least 32 random bytes for the shared credential and make it `0640` with the same shared group. Keep the credential readable only by the runner and application group. Do not place credentials in source control.
4. Create `%h/.config/ezharness/runner.env`, mode `0600`, with `EZ_EXTENSION_RUNNER_SOCKET`, `EZ_EXTENSION_RUNNER_TOKEN_FILE`, `EZ_EXTENSION_RUNNER_STORE`, and `EZ_EXTENSION_APP_UID`. The UID is the application's host-visible Unix peer UID, including any container user namespace mapping. The gateway checks this exact UID as well as the bearer credential.
5. Pre-pull `docker.io/oven/bun@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4` under the runner account. This is the multi-arch index of the tested Bun 1.3.14 image: its linux/amd64 child is `sha256:50317d83cd5a5ae1d8b35b3379c69f57ce1a0dbf4def91f0965653d767851834` (the digest previously pinned here, unchanged) and its linux/arm64 child is native, so an arm64 host no longer runs the runner under emulation. A host that pre-pulled only the amd64 child by digest must pull the index — `--pull=never` looks the image up by the reference the runner is configured with. Runtime execution uses `--pull=never`; an absent image is an error.
6. Start the user service. Initialization verifies actual container UID, seccomp, capabilities, no-new-privileges, read-only root, network routes and cgroup settings. A failed check prevents service startup. No command in this setup is run automatically by the application.

## No host runner: the trusted-local mode

A host that cannot run the isolated runner — macOS or Windows, where the Linux VM is not the operator's to provision (on macOS the runner provisions fine inside `podman machine`, but no container there can connect to a bind-mounted host unix socket, which is how the app reaches it — evidence and the ruled-out causes are in [macos-local-dev.md](../../docs/macos-local-dev.md#extensions-on-macos-the-isolated-runner-is-not-available)), or any host where the steps above are not worth it — can instead run extensions as plain processes inside the application container. This is the `trusted-local` adapter from [security.md](../../docs/extensions/security.md): none of the seven sandbox controls apply, the extension has the app's full reach, and every build and every release approval requires an explicit per-digest human acknowledgement. In the Compose env file, select the alternative connection and set the acknowledgement:

```
EZCORP_RUNNER_COMPOSE_FILE=deploy/extension-runner/compose.trusted-local.yml
EZCORP_EXTENSIONS_UNSANDBOXED_ACK=I-understand-extensions-run-with-the-apps-full-powers
```

This selects `EZCORP_EXTENSION_RUNNER=trusted-local`, uses UID 1000, and omits the host socket and credential mounts. The dev image makes its image-backed dependencies, generated files, and new named-volume roots writable by that UID. Pre-create the host `.ezcorp` bind directories for UID 1000 before the first start; source binds only need to be readable unless you intend to edit them from the app.

Named volumes created by an older root-running dev image retain their old ownership. Stop the app and inspect its mounts with `docker inspect` to find the volume names attached at `/app/state`, `/app/cache`, `/app/web/.ezcorp`, and `/app/.ezcorp/extension-releases`. Mount each named volume by itself at `/target` in a disposable root container and run `chown -R 1000:1000 /target`, then recreate the app. Do not run a recursive ownership change through the app service: nested host bind mounts sit below these paths and must keep their host ownership.

Outside Compose, set `EZCORP_EXTENSION_RUNNER=trusted-local` and the same acknowledgement directly. The app refuses to start with one key but not the other, with an unknown value, or with an isolated-runner socket configured alongside. It runs as the image's non-root uid 1000 and refuses root. It logs the mode at error level on every boot, reports it on `/api/health?detail=true` as `extensions.runner`, and shows a standing banner on every page. Which to choose, and why this exists at all: the [decision record](../../docs/decisions/2026-09-12-extension-runner-install-burden.md).

For a custom Compose deployment, inherit the `app` service from `compose.runner.yml` and set both host paths plus the container-visible shared group. The app reads `EZCORP_EXTENSION_RUNNER_SOCKET` and `EZCORP_EXTENSION_RUNNER_TOKEN_FILE`. Outside Compose, set either this token file or `EZCORP_EXTENSION_RUNNER_TOKEN`, never both. The file must be an absolute, regular, non-symlink path, at most 4096 bytes, and not writable by group or others. Use a private secret mount; the reader removes surrounding whitespace and rejects short or malformed credentials. The runner service uses the separate `EZ_EXTENSION_*` settings above. Keep the shared socket directory at `2750`; the artifact store and other runner-only directories remain `0700`.

## Validation and operation

After building the application image, run `bash scripts/verify-extension-container.sh <local-image>`. This starts a disposable, network-disabled app container and a real host runner. It verifies file credentials, isolated build, session approval, activation, invocation, revocation and retained history through the production HTTP API. It uses the same Compose runner connection and startup check as the default stacks, a new database, and removes only its own container and runner files. This check also needs Docker Compose v2+ connected to the rootless Podman socket (`systemctl --user enable --now podman.socket`). The image must use the standard UID 1000 app user; the test maps it to the current host UID for the Unix peer check.

Run `bun test --cwd packages/@ezcorp/extension-runner` under a Linux test account with the same controls and cached pinned image. The integration suite requires real Podman and does not skip when isolation is missing. It tests build, typecheck, test failures, metadata discovery, reverse RPC, immutable artifacts, repeatability, host/network denial, kernel resource limits and descendant cancellation. Unit tests separately check Unix peer identity and credentials, framing and malformed output.

On an ephemeral Ubuntu GitHub Actions host, run `bash scripts/setup-extension-runner-ci.sh --install` after the pinned Bun and frozen dependencies are installed. It installs the distribution's Podman and required tools, grants the test user's systemd manager cgroup delegation, allocates subordinate IDs if absent, pulls the pinned image and runs the actual kernel-control probe. Delegation uses a root-owned, per-user runtime unit drop-in with `Delegate=cpu memory pids`, followed by daemon reload and user-manager restart. It verifies all three controllers and the user bus before the kernel probe. It refuses to restart a manager containing the CI job itself; run provisioning from the host CI service instead. This mode is only for disposable CI hosts, not an active developer session. `systemctl set-property Delegate=...` is not supported for this static service. See the [systemd delegation contract](https://systemd.io/CGROUP_DELEGATION/) and [rootless setup instructions](https://rootlesscontaine.rs/getting-started/common/cgroup2/).

Existing Linux hosts use `--probe`, which changes no host configuration and does not pull an image. An unsupported kernel, AppArmor profile, controller or Podman version fails the job; the script does not weaken host security settings or enable a fallback. The local tested version is Podman 5.8.2; distribution versions are accepted only when these actual checks pass.

The CI installer also pins the upstream conmon 2.2.1 static monitor by its release SHA-256, installs it in a root-owned versioned directory, and selects it through a containers.conf drop-in. It checks Podman's selected path before running tests. Ubuntu 24.04's conmon 2.1.10 was reproduced returning `OOMKilled=false` after a genuine memory-limit exit; the same Podman 4.9.3 and crun 1.14.1 pass the unchanged real memory test with conmon 2.2.1. Use that tested monitor for deployment too. The runner does not guess that exit code 137 means OOM. Downloads and redirects must use HTTPS; checksum, architecture, configuration, or kernel-probe failures stop setup. The pinned assets and hashes come from the [upstream conmon release](https://github.com/containers/conmon/releases/tag/v2.2.1).

For Playwright, start `bash scripts/start-extension-runner-e2e.sh` as a managed test-server process. Set unique `EZ_EXTENSION_RUNNER_SOCKET`, `EZ_EXTENSION_RUNNER_TOKEN_FILE`, and `EZ_EXTENSION_RUNNER_STORE` paths for the job, and pass the same socket and credential to the test application. The helper generates a private random credential only if absent and runs the production service in the foreground. Test teardown must terminate it and wait for exit. This helper does not install packages or change host settings.

The runner permits one build and four executions by default. Excess work returns a retryable queue diagnostic to the durable host lifecycle. A kernel file lock permits only one runner per store. A runner restart removes its labelled orphan containers and retains immutable artifacts; the gateway recovers an owned stale socket only after confirming that no listener is active. The host lifecycle reconciles interrupted operations; runner in-memory inspection alone is not a durable operation journal. Keep the store and its reference inventory in the host backup policy. Only the host may decide which unreferenced artifacts to remove.

The seccomp allowlist is vendored from containers/common `v0.64.2`, `pkg/seccomp/seccomp.json`. Its hash is recorded in each artifact recipe. Updating the image, SDK, compiler or profile changes build evidence and requires release review.

`TrustedLocalRunner` is a separate, explicit admin-only adapter. It verifies the pinned Bun binary, dedicated UID, exact source or artifact digest approval, expiry and all omitted controls, then awaits an audit write. It never runs after an automatic Podman failure. It shares the build and protocol logic but cannot protect host files, network or cgroup resources against malicious code. The application must label this profile `trusted-local` and separately approve activation.
