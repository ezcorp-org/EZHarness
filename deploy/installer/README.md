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
login breaks over plain HTTP.

**The suggestion sidecar is opt-in.** It backs only the composer's
prompt-enhancement row, and costs a ~1 GB model plus a 4 GB memory
reservation. With the profile off, `EZCORP_SUGGEST_OLLAMA_URL` must stay unset
— a set URL means dialing a host that does not exist on every keystroke.

**Updates run from the host.** The app cannot pull and recreate itself without
a mounted container socket, which `compose.prod.yml` already records as
host-root-equivalent and rejected. `ezcorp update` snapshots the data first and
rolls back if the new version does not reach `ready`.

**Readiness is checked before the browser opens.** `/api/ready` distinguishes
"still booting" from `data-recovery-needed`; the degraded case prints the
backup path instead of opening a broken app.

## Testing

`src/__tests__/installer-core.test.ts` drives this script with stub
engine/compose/curl binaries. Run it with `bun test
./src/__tests__/installer-core.test.ts`.

Manual end-to-end against a locally built image:

```sh
EZCORP_CONFIG_DIR=/tmp/ez/config EZCORP_DATA_ROOT=/tmp/ez/data \
  EZCORP_IMAGE=ezcorp:local deploy/installer/ezcorp install
```

## Not here yet

OS packages (`.pkg`, `.deb`, `.rpm`), code signing and notarization, the
`release-installers.yml` workflow, Windows, and any tray UI. This core is
what they will all call.
