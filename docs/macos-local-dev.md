# Local development on macOS

CI runs on Linux and production ships a Linux container. A Mac is a fine place
to write the code, but a chunk of the backend pool exercises kernel facilities
Darwin does not have, so `bun run test` on a Mac is red before you change
anything. This page says exactly how red, why, and what to run instead.

## TL;DR

```sh
brew install bash podman docker-compose   # bash 4+ for native wrappers; container engine
podman machine init --cpus 4 --memory 8192 --disk-size 60 && podman machine start

bun run typecheck      # native, clean
bun run lint           # native, clean
bash scripts/test-linux.sh          # the pool, in a Linux container
bash scripts/test-linux.sh bun run test:coverage
```

## Why native test wrappers need Homebrew bash

macOS ships bash **3.2** as `/bin/bash` (GPLv2, frozen in 2007). It has no
associative arrays, which `scripts/lib/test-file-sets.sh` uses for the leg
registry, so every native wrapper that sources it dies immediately. The
scripts now detect this and tell you to `brew install bash`. Put
`$(brew --prefix)/bin` before `/bin` on your `$PATH`; this works on both Apple
Silicon and Intel Macs.

`scripts/test-linux.sh` does not source that library and works with the system
bash. Its default test command invokes the newer bash inside the Linux image.

## What fails natively, and why it is not a portability bug

Measured on macOS 27 / bun 1.3.14 against a clean `main`:

```
25341 pass | 317 fail | 1646 files       # 115 files red
```

Dominant causes, none of which are defects in the product:

| Cause | Files | Why |
|---|---|---|
| `prlimit` not on `$PATH` | 32 | util-linux; the rlimit syscall it wraps is Linux-only |
| `flock` not on `$PATH` | 24 | util-linux |
| `/proc/self/fd/<n>/…` walks | 25 | the TOCTOU-safe directory descent in `scripts/migrate-extension-v4.ts` is procfs-only **by design** |
| `setsid` not on `$PATH` | 4 | util-linux |

Installing GNU coreutils does not fix these: `prlimit` has no macOS
equivalent, and procfs is not something a package provides.

## `scripts/test-linux.sh`

Runs any repo command inside a Linux container against your working tree as it
is on disk — no commit, no image rebuild per change.

```sh
bash scripts/test-linux.sh                    # bun run test
bash scripts/test-linux.sh bun run typecheck  # anything else
```

It prefers Podman, falls back to Docker, and builds its image from
`Dockerfile.test` on first use. The default image tag is derived from the
Dockerfile, Bun pin, and web package inputs, so a toolchain change builds a new
image instead of silently reusing a stale one. `EZCORP_CONTAINER_ENGINE` and
`EZCORP_TEST_IMAGE` override the engine and image.

**The two `node_modules` volumes are the load-bearing part.** The repo is
bind-mounted, so a host `bun install` is visible inside the container,
macOS-native binaries and all. Reusing them adds 18 `Ensure your package
manager supports multi-platform installation` failures. Two named volumes mask
them with Linux-native installs that persist between runs.

Result on the same tree:

```
25613 pass | 64 fail | 1646 files        # 115 files red → 43
```

## The 43 that still fail, and why they are CI's job

The remainder need a **privileged Linux host**, not merely a Linux userland:

- landlock tiers and the fs-jail posture suites
- compiling a seccomp filter with a real C toolchain against a live kernel
- network namespaces / veth bridging
- Podman **inside** the test container
- the browser-rendering runner and its offline bundle seal

These pass on CI's runners. Do not treat them as your regression unless CI
says so — the same files fail identically on a clean checkout.

## Extensions on macOS: run the isolated runner in Colima

`compose.prod.yml` and `docker-compose.yml` both default to the **isolated
extension runner**, a host service the app reaches over a bind-mounted unix
socket (`deploy/extension-runner/README.md`). Whether that works on a Mac
depends entirely on which VM the containers run in:

| VM | App container → host runner socket | Isolated runner |
|---|---|---|
| **Colima** (Lima, Ubuntu 24.04, Docker) | connects | **works** — verified end to end below |
| `podman machine` (Fedora CoreOS, rootless Podman) | `EACCES` | does not work — see below |

When the connection cannot be made, the app fails its 15-second startup check
and restarts forever:

```
Extension runner is not ready. Check its service, socket, credential and application UID.
```

### On Colima: it works (recommended)

Colima's VM is the same OS upstream CI provisions the runner on
(`scripts/setup-extension-runner-ci.sh`, Ubuntu 24.04), it is a VM you can
shell into, and it runs Docker rootful, where bind-mounting a host socket into
a container is ordinary. Measured on macOS 27 / Colima / Docker 29.5.2 /
podman 4.9.3 / arm64:

| Check | Result |
|---|---|
| uid-1000 container → VM socket, read-only bind + `--group-add` | connects |
| `setup-extension-runner-ci.sh --probe` as the runner account | `Extension runner kernel controls verified` |
| rootless limits (`--memory=64m --pids-limit=32`) | enforced: `memory.max 67108864`, `pids.max 32` |
| runner image (multi-arch pin) | runs native `aarch64` |
| app image, uid 1000, right token → `/v4/inspect` | reaches the runner API |
| same, wrong token | `401` |
| uid **1001**, right token | refused by the `SO_PEERCRED` gateway |
| app on the isolated runner | passes its startup check, `ready`, 0 restarts, no unsandboxed banner |
| `colima stop && colima start` | runner, socket dir and app all return on their own |

Everything below runs **inside the VM** (`colima ssh`) except the last step.
Paths like `/run/ez-extension-runner` are VM paths — Docker resolves bind
sources there, not on the Mac.

1. **Packages and the verified container monitor** — the same set and pinned,
   SHA-256-checked conmon 2.2.1 as CI:
   ```sh
   sudo apt-get update
   sudo apt-get install -y --no-install-recommends podman uidmap slirp4netns fuse-overlayfs dbus-user-session python3 util-linux ca-certificates curl unzip
   source /Users/$USER/path/to/ezharness/scripts/lib/extension-runner-conmon.sh && install_extension_runner_conmon
   ```
   Ubuntu 24.04 restricts unprivileged user namespaces
   (`apparmor_restrict_unprivileged_userns=1`) but ships AppArmor profiles
   for `podman`, `crun`, `runc` and `slirp4netns`. No sysctl change is needed;
   zero AppArmor denials were logged.
2. **A dedicated account**, not uid 1000 (the app's uid) and not your own:
   ```sh
   sudo groupadd -g 2001 ezshared
   sudo useradd -m -u 2000 -U -G ezshared -s /bin/bash ezrunner   # adds a subuid/subgid range
   sudo loginctl enable-linger ezrunner
   ```
3. **cgroup delegation**, persistent (CI writes it under `/run`; a VM you keep
   needs `/etc`):
   ```sh
   sudo install -d /etc/systemd/system/user@2000.service.d
   printf '[Service]\nDelegate=cpu memory pids\n' | sudo tee /etc/systemd/system/user@2000.service.d/90-extension-runner.conf
   sudo systemctl daemon-reload && sudo systemctl restart user@2000.service
   ```
4. **Bun, an immutable release copy, dependencies, images** — as ezrunner:
   install Bun 1.3.14 (`curl -fsSL https://bun.sh/install | bash -s bun-v1.3.14`);
   copy a `git archive HEAD` of `package.json bun.lock bunfig.toml
   tsconfig.json packages scripts src` to `~/app`; run
   `bun install --frozen-lockfile` **with `~/.bun/bin` on `PATH`** (the
   workspace `prepare` scripts call `bunx`); `podman pull` the image named by
   `DEFAULT_IMAGE` and the `postgres` image from `scripts/test-images.json`.
5. **Socket directory and credential**, persistent across VM boots (`/run` is
   tmpfs):
   ```sh
   printf 'd /run/ez-extension-runner 2750 ezrunner ezshared -\n' | sudo tee /etc/tmpfiles.d/ez-extension-runner.conf
   sudo systemd-tmpfiles --create /etc/tmpfiles.d/ez-extension-runner.conf
   sudo install -d /etc/ezharness
   python3 -c 'import secrets; print(secrets.token_hex(32))' | sudo tee /etc/ezharness/extension-runner-token >/dev/null
   sudo chown ezrunner:ezshared /etc/ezharness/extension-runner-token && sudo chmod 0640 /etc/ezharness/extension-runner-token
   ```
6. **The service**: install `deploy/extension-runner/extension-runner.service`
   as ezrunner's user unit with `WorkingDirectory=/home/ezrunner/app`,
   `ExecStart=/home/ezrunner/.bun/bin/bun …`, `~/.bun/bin` on its `PATH`, and
   `Environment=XDG_RUNTIME_DIR=/run/user/2000`. Save the unit as
   `~/.config/systemd/user/extension-runner.service` and its environment as
   `~/.config/ezharness/runner.env` (both paths are in ezrunner's home):
   ```
   EZ_EXTENSION_RUNNER_SOCKET=/run/ez-extension-runner/runner.sock
   EZ_EXTENSION_RUNNER_TOKEN_FILE=/etc/ezharness/extension-runner-token
   EZ_EXTENSION_RUNNER_STORE=/home/ezrunner/store
   EZ_EXTENSION_APP_UID=1000
   ```
   `EZ_EXTENSION_APP_UID` is **1000**: rootful Docker does no uid remapping,
   so the peer the gateway sees is the app's own uid.
   Then, as ezrunner with `XDG_RUNTIME_DIR=/run/user/2000`, load and start the
   service, and enable it for later VM boots:
   ```sh
   systemctl --user daemon-reload
   systemctl --user enable --now extension-runner.service
   systemctl --user status extension-runner.service
   ```
7. **Verify before touching the app**, as ezrunner in `~/app`:
   `bash scripts/setup-extension-runner-ci.sh --probe` must print
   `Extension runner kernel controls verified`.
8. **Point the app at it** — on the Mac, in `.env.prod`, remove the two
   trusted-local lines if present and set:
   ```
   EZ_RUNNER_SOCKET_DIR=/run/ez-extension-runner
   EZ_RUNNER_TOKEN_FILE=/etc/ezharness/extension-runner-token
   EZ_RUNNER_GROUP=<output of: sudo env EZ_RUNNER_SOCKET_DIR=/run/ez-extension-runner bash scripts/resolve-runner-group.sh --docker, run in the VM>
   ```
   then `docker compose -f compose.prod.yml --env-file .env.prod up -d`.

#### Three things that cost time

- **A wedged `systemd-logind` hangs rootless Podman with no error.** Podman
  asks logind whether the rootless user has a valid session
  (`systemd.IsSystemdSessionValid`) and blocks on that D-Bus call forever;
  `loginctl enable-linger` times out the same way. If `timeout 10 loginctl
  list-sessions` hangs, `sudo systemctl restart systemd-logind`. Seen once
  after a fresh `colima start`; it did not recur after a VM restart. A
  goroutine dump (`timeout -s QUIT 15 podman info`) is what named it.
- **The pinned conmon is built without journald**, so a manual
  `podman run` fails with `Include journald in compilation path`. The runner
  always passes `--log-driver=none`; add it to any smoke test.
- **A stuck first `podman` call holds the storage lock** and makes every later
  call hang too. Kill all of the account's `podman` processes before retrying.

### On `podman machine`: it does not work

The runner itself provisions and runs correctly inside the `podman machine`
VM. Measured on podman 6.1.2 / Fedora CoreOS, with the service active and the
gateway enforcing `SO_PEERCRED`:

```
socket   srw-rw----  ezrunner:ezshared  /run/ez-extension-runner/runner.sock
connect from the VM as the app's uid  →  OK
connect from ANY container            →  EACCES
```

**Containers in that VM cannot connect to a bind-mounted host unix socket.**
The following were each ruled out, one at a time:

| Hypothesis | Result |
|---|---|
| File permissions | Fails as container-root holding `CAP_DAC_OVERRIDE`, with the socket's group mapped, and at mode `0666` owned by the mapped uid |
| SELinux | Socket and directory relabelled `container_file_t`; **zero AVCs** with `dontaudit` disabled (`semodule -DB`) and `auditd` confirmed active |
| User namespace | Fails under `--userns=keep-id` and under the default rootless mapping |
| Network namespace | Fails with `--network host` |
| Read-only mount | Fails read-write too |
| Bind mounts in general | A host-side `mount --bind` of the same directory connects fine |
| AF_UNIX inside containers | A container-local socket connects fine |
| Something specific to this socket | Podman's **own** `podman.sock` fails the same way |

The mechanism is not identified here. What is established is that the
architecture's one hard requirement — app-in-container reaching a
host-provided unix socket — does not hold on this platform.

Note for anyone debugging this: **Bun reports the `EACCES` as `ENOENT`** from
`net.connect`, which reads like a missing socket and sends you looking in the
wrong place. `socat` reports the true errno.

### Fallback: trusted-local (no sandbox)

If you cannot use Colima or a Linux host, the `trusted-local` adapter from
`deploy/extension-runner/README.md` runs extensions without the runner. In `.env.prod`:

```
EZCORP_RUNNER_COMPOSE_FILE=deploy/extension-runner/compose.trusted-local.yml
EZCORP_EXTENSIONS_UNSANDBOXED_ACK=I-understand-extensions-run-with-the-apps-full-powers
```

**Understand what you are accepting.** Extensions then run as plain processes
inside the app container with the app's full reach — no filesystem, network,
seccomp or cgroup limits. The app is the blast radius. It says so at error
level on every boot:

```
EZCORP_EXTENSION_RUNNER=trusted-local: extensions build and run WITHOUT a
sandbox on this host — no filesystem, network, seccomp, or cgroup limits;
the app itself is the blast radius.
```

and it shows a standing banner on every page. Each bundled extension then
refuses to build until you acknowledge that exact source digest in the UI:

```
LifecycleError: This host builds and runs extensions WITHOUT a sandbox.
Acknowledge that for this exact source before building.
```

That per-digest acknowledgement is the only control left, so read what you are
approving. If that trade is not acceptable, run the stack on a Linux host,
where the isolated runner works as designed.

## Rebuilds fill the machine disk

Every `bun run podman --prod up -d --build` tags the new image `ezcorp:local`
and leaves the previous one — about 4.5 GB — untagged. Nothing removes it, so
a 60 GB `podman machine` fills after a handful of rebuilds. The symptom names
neither cause nor fix: the build dies committing the Dockerfile's
`chown -R /app` layer with `no space left on device`.

```sh
bun run podman:prune            # remove superseded EZCorp images
bash scripts/prune-images.sh --check   # list them first
```

It removes only **untagged** images carrying this project's OCI title label,
and never one a container still uses. `scripts/setup-podman.sh` runs it
automatically once a rebuilt app reports ready.

## Two warts worth knowing

- **The container writes into your tree.** It runs with `EZCORP_DB_PATH=:memory:`
  for parity with `docker-compose.test.yml`, and a failing DB suite leaves a
  literal `:memory:.failed.<timestamp>/` directory in the repo root. Harmless;
  delete it.
- **The VM does not start at login.** `podman machine start` after a reboot,
  or the script's engine probe succeeds and the `run` then fails on a dead
  socket.
