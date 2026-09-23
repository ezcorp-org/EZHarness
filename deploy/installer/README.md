# EZCorp installer core

The engine every OS installer package wraps. It is deliberately a shell script
rather than a native launcher: the product is already a browser app talking to
a local server, so a native shell would buy an icon and a menu-bar item at the
cost of a second toolchain, a second signing pipeline and a second update
path. The OS packages supply the icon; this supplies the behavior.

```
ezcorp install              set up and start EZCorp
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

## Not here yet

OS packages (`.pkg`, `.deb`, `.rpm`), code signing and notarization, the
`release-installers.yml` workflow, Windows, and any tray UI. This core is
what they will all call.
