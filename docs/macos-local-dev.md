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

## Two warts worth knowing

- **The container writes into your tree.** It runs with `EZCORP_DB_PATH=:memory:`
  for parity with `docker-compose.test.yml`, and a failing DB suite leaves a
  literal `:memory:.failed.<timestamp>/` directory in the repo root. Harmless;
  delete it.
- **The VM does not start at login.** `podman machine start` after a reboot,
  or the script's engine probe succeeds and the `run` then fails on a dead
  socket.
