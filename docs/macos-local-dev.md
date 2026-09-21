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

## Extensions on macOS: the isolated runner is not available

`compose.prod.yml` and `docker-compose.yml` both default to the **isolated
extension runner**, a host service the app reaches over a bind-mounted unix
socket (`deploy/extension-runner/README.md`). On macOS that connection cannot
be made, so the app fails its 15-second startup check and restarts forever:

```
Extension runner is not ready. Check its service, socket, credential and application UID.
```

### Why — and it is not the runner's fault

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

### What to do instead

Use the `trusted-local` adapter, which `deploy/extension-runner/README.md`
already documents for exactly this case. In `.env.prod`:

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

## Two warts worth knowing

- **The container writes into your tree.** It runs with `EZCORP_DB_PATH=:memory:`
  for parity with `docker-compose.test.yml`, and a failing DB suite leaves a
  literal `:memory:.failed.<timestamp>/` directory in the repo root. Harmless;
  delete it.
- **The VM does not start at login.** `podman machine start` after a reboot,
  or the script's engine probe succeeds and the `run` then fails on a dead
  socket.
