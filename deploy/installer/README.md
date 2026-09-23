# EZCorp installer core

The engine every OS installer package wraps. It is deliberately a shell script
rather than a native launcher: the product is already a browser app talking to
a local server, so a native shell would buy an icon and a menu-bar item at the
cost of a second toolchain, a second signing pipeline and a second update
path. The OS packages supply the icon; this supplies the behavior.

```
ezcorp install              set up and start EZCorp
ezcorp launch               set up if needed, otherwise start (the desktop entry)
ezcorp start | stop         start or stop it (stop leaves the container VM up)
ezcorp open                 open it in the browser
ezcorp status               engine, VM, version, URL, readiness, subuid room
ezcorp update [version]     back up, pull, recreate, verify, roll back on failure
ezcorp suggestions on|off   local suggestion model (~1 GB download, 4 GB RAM)
ezcorp uninstall [--purge]  remove it (--purge also deletes your data)
```

## Files

| File | Role |
|---|---|
| `ezcorp` | the core; all OS packages call it |
| `compose.installer.yml` | pull-only stack, absolute host paths, suggestion sidecars behind a profile |
| `compose.machine.yml` | rootless-Podman overlay (`keep-id`), layered whenever podman runs rootless |
| `compose.isolated.yml` | isolated extension runner connection — layered in `isolated` mode (the default) |
| `compose.trusted-local.yml` | unsandboxed extensions — layered only in `trusted-local` mode, which the user typed consent for |

## Extension runner modes

The app will not start without an extension runner, so every install records
one of two modes in `.env` (`EZCORP_INSTALL_RUNNER_MODE`) and keeps it; the
installer never changes an install's mode.

| Mode | When | What extensions get |
|---|---|---|
| `isolated` (default) | the three `EZ_RUNNER_*` variables below are set | the full sandbox: a separate host service, seven controls |
| `trusted-local` | **none** of them is set, and the user typed `I understand` at a terminal | none of the seven controls — the app's full reach |

`trusted-local` is decision C in
[the install-burden record](../../docs/decisions/2026-09-12-extension-runner-install-burden.md).
It exists because the isolated runner is eight root-only Linux steps, which a
one-click install cannot ask of a non-technical user. The installer offers it
under three rules, each tested in `src/__tests__/installer-core.test.ts`:

- **Only a person can choose it.** The explanation is printed and the answer
  must be typed at a real terminal. There is no flag or environment variable
  that selects it: the app's acknowledgement is a sentence so it cannot be
  switched on by copying a line, and an installer flag would be exactly that.
  From a pipe or a script, install refuses and explains both options.
- **It is never a fallback.** If *any* runner variable is set, the user is
  configuring isolation, and a missing or invalid one stays a hard error.
- **Nothing downstream changes.** Each extension build and release still needs
  its own explicit approval in the app, and the app shows a standing warning
  banner in this mode.

`ezcorp status` reports the mode. To change it, reinstall (your data is kept).

## Prerequisites

For the default `isolated` mode, this core supports a Linux host with a
provisioned **isolated extension runner**. Follow
[the runner setup](../extension-runner/README.md) before the first install.
Export its host socket directory, credential file and container-visible group:

```sh
export EZ_RUNNER_SOCKET_DIR=/run/ez-extension-runner
export EZ_RUNNER_TOKEN_FILE=/etc/ezharness/extension-runner-token
export EZ_RUNNER_GROUP=1 # use the verified group from your runner setup
```

The installer checks these settings before it creates data or secrets. It saves
them in its private `.env` for later commands. The socket directory and token
are mounted read-only. The app's normal startup check still verifies the runner
credential and isolation controls. There is no automatic trusted-local fallback;
see [Extension runner modes](#extension-runner-modes) for the explicit choice.

Configure the runner service's `EZ_EXTENSION_APP_UID` for the app's actual
host-visible UID: your login UID with rootless Podman's `keep-id` mapping, or
1000 with rootful Docker. Use the runner guide to verify its shared group map.
On Linux, start Podman's API socket before use (`systemctl --user enable --now
podman.socket`). Compose always uses the selected Podman socket, even when
Docker is also installed.

Linux Docker installs require a login UID of 1000 and a rootful Docker daemon.
Use rootless Podman for other login UIDs. The installer does not change owners
of existing data or request sudo. It validates the runner settings, then lets
Compose and the app verify mount availability and mapped-group access. It does
not provision a runner inside a macOS VM. OS packages and VM support are not
included in this core's validated configurations. This is an installer limit,
not a restriction on the application's other deployment methods.

Linux lifecycle commands also require `flock` (util-linux), `getent` and `realpath`.
Install, start, stop, update, suggestions and uninstall share one per-user lock
under `.ezcorp-installer-lock` in the account home returned by `getent passwd`.
The location does not depend on `HOME`, `XDG_RUNTIME_DIR` or `TMPDIR`, so login
shells and background jobs use the same lock. An unavailable or ambiguous
account lookup stops the command before it creates config or data.
A second command stops with a clear message. The lock stays held through
startup and rollback, and its file survives purge. Config and data overrides
must not contain that lock directory. Status and help remain available while
another command runs.

## Decisions worth knowing before editing

**Secrets and data are one unit.** The three secrets live in `.env`; the data
is encrypted with them. Anything that removes one while keeping the other
turns a reinstall into a fresh install with orphaned data — no error, every
stored provider key undecryptable, every session dead. That is why non-purge
uninstall keeps `.env`, and why only `--purge` (behind a typed confirmation)
may remove either.

**Only the host port varies.** The image pins `EZCORP_PORT=3000` and
in-container loopback callers resolve to it, so the installer never sets that
variable. What must track the chosen port is `EZCORP_PUBLIC_URL`, which feeds
`ORIGIN`: left unset, svelte-adapter-bun defaults the scheme to `https` and
login breaks over plain HTTP. The host port binds only to `127.0.0.1`, because
this local installer serves plain HTTP.

**The suggestion sidecar is opt-in.** It backs only the composer's
prompt-enhancement row, and costs a ~1 GB model plus a 4 GB memory
reservation. With the profile off, `EZCORP_SUGGEST_OLLAMA_URL` must stay unset
— a set URL means dialing a host that does not exist on every keystroke.
Turning suggestions off recreates the app with the URL removed before stopping
the sidecar. Non-purge uninstall keeps the opt-in setting with `.env`, so a
reinstall restores both together.

**Updates run from the host.** The app cannot pull and recreate itself without
a mounted container socket, which `compose.prod.yml` already records as
host-root-equivalent and rejected. `ezcorp update` snapshots the data first and
rolls back if the new version does not reach `ready`.
Both backup and restore require a successful container stop. If the failed
version cannot stop, the installer preserves both data copies and prints the
backup path. It never restores files beneath a running app.

**Readiness is checked before the browser opens.** `/api/ready` distinguishes
"still booting" from `data-recovery-needed`; the degraded case prints the
backup path instead of opening a broken app.

## Testing

`src/__tests__/installer-core.test.ts` drives this script with stub
engine/compose/curl binaries. Run it with `bun test
./src/__tests__/installer-core.test.ts`.

Manual end-to-end against a locally built image, after runner provisioning:

```sh
EZCORP_CONFIG_DIR=/tmp/ez/config EZCORP_DATA_ROOT=/tmp/ez/data \
  EZCORP_IMAGE=ezcorp:local deploy/installer/ezcorp install
```

## Linux packages (`linux/`)

`.deb` and `.rpm` for amd64 and arm64, built with
[nfpm](https://nfpm.goreleaser.com/) by `linux/build-packages.sh` and attached to
each GitHub Release by `.github/workflows/release-installers.yml`, which runs
after `release-image` succeeds for an `app-v*` tag.

```sh
EZCORP_PKG_MAINTAINER="Name <email>" \
  bash deploy/installer/linux/build-packages.sh arm64 1.3.0 dist
```

What a package installs, and why each piece is shaped the way it is:

| Path | Notes |
|---|---|
| `/usr/lib/ezcorp/ezcorp` + the compose files | the core, with `VERSION_FALLBACK` pinned to the package version — package 1.4.0 pulls image 1.4.0 |
| `/usr/lib/ezcorp/docker-compose` | **vendored** Docker Compose, pinned in `linux/compose.lock` by the SHA-256 its release publishes; the build refuses a mismatch. A stock Linux with only podman has no compose provider at all (verified on Fedora CoreOS) |
| `/usr/bin/ezcorp` | a wrapper, not a symlink: the core finds its siblings next to itself |
| `/usr/share/applications/ezcorp.desktop` | runs `ezcorp launch` in a terminal — the only place the runner-mode question may be asked |

Depends on `podman (>= 4.0)`, `util-linux`, `openssl` and `curl`. Each format
lists all four itself: nfpm's per-format `overrides` *replace* a shared list,
and an early build silently shipped depending on podman alone.

The package installs **the installer**, not EZCorp. Its post-install script only
prints how to start. It never runs `ezcorp install`, because package scripts run
as root and EZCorp installs per user under rootless Podman, and it never answers
the runner-mode question.

`EZCORP_PKG_MAINTAINER` is required and set from a repository variable in CI. The
repo declares no contact address, and a package must not invent one.

Verified: `apt` on Debian 12 and `dnf` on Fedora 41 install the packages and
resolve every dependency. The packaged payload installs and runs EZCorp
end-to-end on Fedora CoreOS (SELinux enforcing, rootless Podman) in
`trusted-local` mode, with consent typed at a real terminal.

## Not here yet

macOS: the core is Linux-only today (the lifecycle lock uses GNU `stat -c` and
`realpath -m`), so the `.pkg` needs that ported first, then signing and
notarization. Also missing: Windows and any tray UI. They will all call this core.
