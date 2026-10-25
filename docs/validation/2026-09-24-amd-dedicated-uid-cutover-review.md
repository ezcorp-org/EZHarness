# AMD isolated-app dedicated UID cutover: host review packet

Status: **read-only preparation; no host, app, database, or Incus change made**.
Target: `nixos-amd`, the isolated qualification app on `127.0.0.1:4301`.
This packet refines [the cutover runbook](../incus-dedicated-uid-cutover.md) and
its [preflight/stage script](../../scripts/incus/prepare-dedicated-uid.py).
It is not an authorization to run `stage --execute` or the saved CREATE repair.

## Observed state on 2026-09-24

| Item | Read-only observation | Consequence |
| --- | --- | --- |
| Host | `nixos-amd`; running generation `/nix/store/vrl7arxaw76icsipgzyws4ybm4ing94a-nixos-system-nixos-amd-26.05.20260430.15f4ee4` | Build and review a new AMD generation before activation. The sandbox-server generation is unrelated. |
| App | Four live Vite process IDs `3878477`, `3878556`, `3878559`, `3878560`, all UID 1001; port 4301 is loopback-only | These IDs are observations, not durable process identities. Refresh before stopping anything. |
| Isolated runner | Runner `1982010`, gateway `1983979`, both UID 1001; socket and token under `/tmp/ezh-incus-isolated-app.QMhk6Qhv` | It is separate from the optional NixOS `ez-extension-runner` user service. Do not stop another runner as a substitute. |
| Data | PGlite source `/tmp/ezh-incus-isolated-app.QMhk6Qhv/db`; source parent is dev-owned mode 0700; `projects` is also dev-owned mode 0700 | The source parent must be sealed only after all old clients stop. Review whether project data must move too. |
| Release | `web/build/index.js` exists but is dev-owned inside `/home/dev`; `/home/dev` and `.worktrees` are mode 0700; `/opt/ezharness` does not exist | A dedicated user cannot run this build. Install a complete reviewed release and dependency closure in a root-owned path. |
| Operator inputs | The app has setup SSH and recipe paths; the SSH identity and known-hosts file are in `/home/dev/.ssh`, both mode 0600. The recipe is in the dev-owned isolated root. | Give the dedicated app reviewed, scoped, readable copies or a separate privileged setup broker. Do not make `/home/dev` traversable. |
| Current app settings | `EZCORP_DB_PATH`, `EZCORP_PROJECT_ROOT`, port/origin, three crypto identity settings, setup SSH settings, and runner socket are present; `DATABASE_URL`, supervisor socket, and live control-probe root are absent | Preserve the three crypto values byte-for-byte in sealed files. A supervisor and live witness still need configuration. No values were printed. |
| Candidate IDs | `getent passwd/group 62040` and `62041` returned no entries during inspection | These are **candidates only**. Check the NixOS evaluated users, local ownership inventory, and live processes before reserving them. |

## Proposed AMD host declaration

Use the disabled-by-default module in
[NixOS PR #2](https://github.com/EZArchy/nixos/pull/2) for the static identities
and services. Its offline build and access tests pass; it is not activated. Transient
`systemd-run` units are useful for a guarded rehearsal, but their settings can
drift across restarts and do not provide a stable process fence. Keep this
configuration on the AMD host; no NixOS change on `sandbox-server` is needed.

1. Reserve `ezharness-qual` UID/GID **62040**, `ezharness-qual-runner`
   UID/GID **62041**, and socket GID **62042**, only after a fresh collision and ownership check. Give
   neither account password or SSH login, sudo, Docker group, nor Incus admin
   group. The runner can keep the shell that rootless Podman needs.
   The runner needs its own rootless Podman subordinate ID range, lingered user
   manager, cgroup delegation, image, and private store. Do not reuse the dev
   runner store or token. The existing `my.ezExtensionRunner` module is
   single-instance and is not enabled by the inspected AMD flake; make a
   separate qualification instance or a small shared service constructor.
   Its source is
   `/home/dev/work/nixos/.worktrees/ezh-guest-management-firewall/modules/ez-extension-runner.nix`.
2. Build and install one exact EZHarness release, including `web/build`, source
   required by the extension runner, dependencies, SDK, helper scripts, and
   pinned Bun 1.3.14, under `/opt/ezharness` (root:root, no group or world
   writes). Pin its Git SHA, dependency lock digest, output inventory, and Bun
   path in the activation packet. `appCommand` must be
   `["/opt/ezharness/bin/bun", "/opt/ezharness/web/build/index.js"]`.
   Test the full runtime under UID 62040 with private test data before moving
   the live PGlite tree. The stage script checks only the entrypoint and path
   ownership; it cannot prove all imports, static files, or subprocess paths.
3. Declare a root-owned **system** service for the Python qualification
   supervisor. It alone starts the app child as UID/GID 62040; do not add a
   second app unit. Pin `WorkingDirectory=/opt/ezharness`, the exact config
   path, `EnvironmentFile=/etc/ezharness/qualification.env`,
   `KillMode=control-group`, and bounded stop/restart settings. Its root-owned
   control directory can be `/run/ezharness-incus-control` mode 0710,
   group 62040. The supervisor creates `control.sock` mode 0660 for its exact
   child and `operator.sock` mode 0600 for root. Keep signing key, pinned
   backend credentials, and operator verifier configuration root-only.
4. Give the runner its own service, socket directory
   `/run/ezharness-qual-runner` mode 2750 with the separate socket group 62042, private
   store `/var/lib/ezharness-qual-runner` mode 0700, and token file mode 0640
   owned by the runner with socket group 62042. The runner must not join the
   app-only group that can read the setup SSH key. Pin
   `EZ_EXTENSION_APP_UID=62040`; the gateway checks the real Unix peer using
   `SO_PEERCRED`. The app receives only the socket and token file. Pin the
   runner release to the same reviewed SDK as the app. Start the runner before
   the supervisor and verify one authenticated call as UID 62040.
5. Create root-owned mode 0600 files
   `/etc/ezharness/old-isolated.env`,
   `/etc/ezharness/qualification.env`,
   `/etc/ezharness/qualification-runner.env`, and the supervisor JSON.
   Reproduce the old process environment by key inventory and protected copy,
   never by printing secrets. The first two files must carry identical
   `EZCORP_ENCRYPTION_SECRET`, `EZCORP_ENCRYPTION_SALT`, and
   `EZCORP_JWT_SECRET`. Neither may set `DATABASE_URL`. The new file also pins
   PGlite target, project root, loopback port/origin, runner paths,
   `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`, supervisor socket, and approved
   Incus recipe/connection inputs. Do not put secrets in a Nix derivation or
   world-readable unit property.

The module uses a root system manager to load the root-owned mode 0600 runner
environment file into a service with `User=ezharness-qual-runner`. Its offline
evaluation and group access tests pass. Rootless Podman and cgroup operation
under this exact service remain live cutover gates.

The current setup SSH identity is the developer's personal key. Moving it
unchanged into the app would give app code that key's full server authority.
The reviewed path is a dedicated scoped SSH identity and pinned host key, or
a host-owned setup broker whose authorized operations match the approved
plan. This is a **cutover blocker** because the 0.1.2 setup plan still needs
server access. Place the reviewed recipe under a root-owned release path and
give the app read access only to that exact file. Record the server-side SSH
scope and a negative command test before exposing the key to the app UID.

## Database and path plan

| Role | Proposed path | Required state before `check` |
| --- | --- | --- |
| Source | `/tmp/ezh-incus-isolated-app.QMhk6Qhv/db` | After the old app/runner stop, source parent root:root 0700; tree remains old UID/GID 1001:100; no open descriptors. |
| Quarantine | `/tmp/ezharness-qual-quarantine/pglite` | Parent root:root 0700, target absent, same filesystem as source for atomic rename. |
| New target | `/var/lib/ezharness-qual-data/pglite` | Parent root:62040 mode 0710, target absent. |
| Rollback | `/var/lib/ezharness-qual-rollback/pglite` | Parent root:root 0700, target and receipt absent. |
| App projects | `/var/lib/ezharness-qual-data/projects` | Review the old `projects` tree and DB references; move or copy under separate checked procedure before opening traffic. The PGlite stage script does not handle it. |

The root-owned manifest must name the dedicated runner UID (62041), socket
GID (62042), refreshed
app/runner PIDs, the exact two new service units (both loaded and inactive),
and `oldAppUnit: null` for the old manually launched app, all four
database paths, built entrypoint, three sealed environment files, socket,
token, and supervisor config. `prepare-dedicated-uid.py check` is the final
read-only gate after the old processes have stopped; `stage --execute` moves
the source to quarantine, writes target and rollback copies, and records
checksums. Keep the old source and rollback copy until the new app proves the
same saved fixture, release binding, and `OUTCOME_UNKNOWN` receipt. The
separate independent runner-client fence is still required before no-effect
recovery; a new UID alone is insufficient.

## Exact cutover gates for the later operator review

1. Freeze one reviewed release; prove `nix build`/evaluation of the AMD
   module, root-owned release inventory, static UID/GID collision check, and
   actual runner/Podman startup under the proposed UID with a disposable DB.
2. Record and hold ingress. Stop only the isolated Vite process group and
   isolated runner/gateway, verify their current PID start times, confirm
   port 4301 and the exact socket have closed, then seal the source parent.
   Do not stop the unrelated development runner service. With the new runner
   and supervisor units still inactive, copy the exact sealed root-owned
   source token to the reviewed runtime path as runner:socket-group mode 0640.
   The [runbook](../incus-dedicated-uid-cutover.md) gives the guarded command.
   Keep the runner socket absent until the database stage passes. Confirm no
   process remains under either new UID; an inactive unit alone does not prove
   that a detached runner client stopped.
3. Run the manifest `check`; inspect its result and path/mode readbacks. Then
   request a separate review of the exact stage manifest and digest before
   `stage --execute`.
4. Start the new runner, then supervisor with traffic held. Verify the app
   child's UID, socket peer identity, app health, original fixture/unknown
   operation, provider connection, and denial of app access to root-only
   key/operator socket. Confirm only one app owns port 4301.
5. Release traffic only after read-only verification. Keep quarantine and
   rollback copies. If the new app accepted writes, review database state
   before rollback to avoid discarding them.

No read-only command in this assessment changed host state. No release build,
NixOS activation, dedicated identity, sealed file, operator SSH scope,
supervisor, runner migration, database stage, or CREATE recovery is verified.
