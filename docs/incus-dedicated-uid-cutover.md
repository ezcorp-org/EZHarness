# Dedicated UID cutover for the isolated Incus qualification app

This is a preparation path for the saved pre-fix CREATE repair. It does not
run the repair, change Incus, or open a public readiness gate. The current
isolated app uses the shared development UID 1001. That UID has unrelated
processes, so the supervisor's no-effect recovery fence correctly rejects it.

Use [prepare-dedicated-uid.py](../scripts/incus/prepare-dedicated-uid.py) to
check the exact cutover inputs and stage a private database copy **after**
the old app and runner have stopped. Nothing in this runbook was executed
against the live app or its database while the runbook was prepared.

## 1. Review the identity and release

Use the disabled-by-default AMD host module in
[NixOS PR #2](https://github.com/EZArchy/nixos/pull/2). It proposes app
UID/GID 62040, runner UID/GID 62041, and a shared socket GID 62042. The
runner is not in the app-only group that can read the setup SSH key. These
IDs remain candidates until the host generation is reviewed and activated.
Check live UID/GID collisions and file ownership before that step. Keep the
operator supervisor as root and the extension runner under its own account.

Build the reviewed app release before stopping the old app. Install the whole
release and its dependency closure under a root-owned, non-writable path such
as `/opt/ezharness`. The supervisor's `appCommand` must start the real Bun
adapter entrypoint `/opt/ezharness/web/build/index.js`; `server.js` in the
example supervisor config is only a placeholder. Do not point the dedicated
user into this worktree: `/home/dev` is mode `0700`, and dev owns its code.
The preflight checks ownership, path traversal, and that exact entrypoint.

## 2. Prepare sealed settings

The [candidate settings tool](../scripts/incus/prepare-qualification-settings.py)
can make the three environment files and runner token before the database
cutover. Use a private root-owned mode `0700` staging directory outside
`/etc`. Its manifest is root-owned mode `0600` and names the old app PID,
the process start ticks from `/proc/PID/stat`, the host boot ID from
`/proc/sys/kernel/random/boot_id`, old and new database and
project paths, and every reviewed runner, supervisor, and SSH path. It has an
exact key set. An operator must hold ingress and runner clients, then make
a root-owned mode `0600` hold receipt with exactly
`sourcePid`, `sourceStartTicks`, `sourceBootId`, `sourceDb`, and
`trafficHeld: true`.
The receipt records an operator assertion; the tool cannot prove traffic is
held. The pinned old process must still run for the one-time capture. Run:

```sh
sudo python3 scripts/incus/prepare-qualification-settings.py \
  --manifest /root/incus-qualification-settings.json prepare --execute
sudo python3 scripts/incus/prepare-qualification-settings.py \
  --manifest /root/incus-qualification-settings.json check
sudo python3 scripts/incus/prepare-qualification-settings.py \
  --manifest /root/incus-qualification-settings.json check-live-source
```

The tool reads the actual old process environment, checks its PID, start time,
UID, database, project root, port, and local origin, and refuses
`DATABASE_URL` or unknown `EZCORP_` keys. It does not execute the old
launcher, whose crypto values were generated at start. It writes root-owned
mode `0600` candidates for `old-isolated.env`, `qualification.env`,
`qualification-runner.env`, and `qualification-runner-token`, plus a
hash-only receipt. It prints no secret values. Only the new app settings
refer to the reviewed dedicated-UID socket, token, setup key, and supervisor
paths. They set `HOST=127.0.0.1` and `PORT` to the pinned local app port
because the built adapter reads those values. The manifest also pins a
root-owned mode `0600` canonical Ed25519 public-key PEM file. The tool
encodes it as one line in the new app environment. It does not print the
PEM or decoded key and does not copy the developer's SSH key. Review file hashes
and paths, then copy the exact candidates to the NixOS module's reviewed
`/etc/ezharness` paths in a separate cutover step. Stop the old app and
runner before the database stage. A fresh final `check` and the existing
`prepare-dedicated-uid.py check` are required at their respective gates.
The latter requires the dedicated runner's runtime token and directory.
Provision and review those before the database stage; candidate generation
alone does not create them.
Run `check-live-source` immediately before stopping the old app. It checks
that the old process still has the pinned boot, PID, start time, UID, and
byte-equal selected environment. After the old process stops, use the staged
`check` action; it does not need the old process.

Prepare two root-owned mode `0600` environment files: one exact baseline
for the old isolated app and one for the new app. They must keep
`EZCORP_ENCRYPTION_SECRET`, `EZCORP_ENCRYPTION_SALT`, and
`EZCORP_JWT_SECRET` byte-for-byte equal. The old file pins
`EZCORP_DB_PATH` to the current PGlite directory. The new file pins it to
the new private copy, sets `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`, the
runner socket and token-file paths, and
`EZCORP_INCUS_SUPERVISOR_SOCKET` to the app control socket. Neither file
may set `DATABASE_URL`. Use literal `KEY=value` lines with no shell
expansion; do not print or commit secret values.

The supervisor config must pin the new numeric `appUid` and `appGid`, the
root-owned built app path, the operator socket, recovery verifier, and
`recoveryFenceCommand`. Keep its Ed25519 private key and the pinned Incus
connection file root-owned mode `0600`. Set
`EZCORP_INCUS_SUPERVISOR_DB_PATH` to the same new PGlite directory in the
root-owned supervisor service. Load the new app environment into that service
so the child inherits it. The supervisor control directory is root-owned
with the app group able to traverse it; its app control socket is group
accessible, while the operator socket stays mode `0600`.

The extension runner gateway checks the peer's numeric UID with Linux
`SO_PEERCRED`. Its sealed runner settings must change
`EZ_EXTENSION_APP_UID` to the new app UID and keep
`EZ_EXTENSION_RUNNER_SOCKET` equal to the app's socket setting. Stop and
restart the runner to apply this change; changing the app UID alone will
break every runner call. The socket parent uses the separate socket group
62042 and group search permission. Its token file must be regular,
non-symlink, readable by that socket group, and not group-writable or
world-readable. The runner must not join the app-only group.
Every token and socket path ancestor must be root- or dedicated-runner-owned
and must have no group or world write bit. A dev-owned `/tmp` parent fails
this check even if the token itself has mode `0640`.
The runner process still has its own UID and store. See the
[runner deployment contract](../deploy/extension-runner/README.md).

## 3. Prepare private paths and manifest

Create root-owned mode `0700` quarantine and rollback parents and a root-owned,
new-app-group mode `0710` target parent. All three new paths must be absent. The
quarantine parent must be on the same filesystem as the source so the stopped
database moves there with one atomic rename. For a `/tmp` source, use a
separate root-owned private directory under `/tmp`; do not use the dev-owned
source parent. After all old clients stop, seal the source parent as root:root
mode `0700` and review its other contents. The preflight refuses a parent the
shared old UID can rename or replace. Record the parent's old owner and mode
for rollback. The stage script rejects links and unexpected owners in the source PGlite tree;
it never copies an active database.

Write a root-owned mode `0600` manifest with these exact keys and reviewed
absolute paths:

```json
{
  "oldUid": 1001,
  "oldGid": 100,
  "newUid": 62040,
  "newGid": 62040,
  "runnerUid": 62041,
  "oldProcessIds": [3878477, 3878556, 3878559, 3878560],
  "runnerProcessIds": [1982010, 1983979],
  "sourceDb": "/reviewed/old/pglite",
  "quarantineDb": "/tmp/ezharness-qual-quarantine/pglite",
  "targetDb": "/var/lib/ezharness-qual-data/pglite",
  "rollbackDb": "/var/lib/ezharness-qual-rollback/pglite",
  "oldAppUnit": null,
  "runnerUnit": null,
  "supervisorUnit": null,
  "builtApp": "/opt/ezharness/web/build/index.js",
  "oldEnv": "/etc/ezharness/old-isolated.env",
  "newEnv": "/etc/ezharness/qualification.env",
  "runnerEnv": "/etc/ezharness/qualification-runner.env",
  "runnerSocket": "/run/ezharness-qual-runner/runner.sock",
  "runnerTokenFile": "/run/ezharness-qual-runner/token",
  "supervisorConfig": "/etc/ezharness/incus-supervisor.json"
}
```

The example paths and numeric IDs are placeholders. `null` means that the old
process was started manually; it does not waive the process, socket, or
database-open checks. Use a service name only for a real loaded unit. Refresh all process IDs
immediately before the cutover; the script requires those exact processes to
be gone and scans process settings for the old database and runner socket.
Read the real isolated
app's process, any loaded service unit, PGlite path, runner settings, and build artifact
before replacing them. A main app using external `DATABASE_URL` is not the
isolated PGlite app and must not be used for this cutover.

At the time of writing, the isolated app is a manually started Vite dev process
with four process IDs and its PGlite source is under a dev-owned `/tmp` parent.
That launch has no reviewed systemd unit. Set the old unit fields to `null`,
record every process ID, stop the old processes, and confirm the exact old
PGlite path. Do not name a missing or dummy unit in the manifest. The separate
development runner user unit is not proof that the isolated runner process is
stopped. The preflight checks the recorded PIDs and live process settings.

## 4. Hold traffic, stop, and stage

Hold ingress and all runner clients. Stop the old isolated app, its runner,
and any old supervisor unit. Verify all named units are inactive with no
main PID and every manually launched process is gone; verify the runner public
socket is gone. Seal the source parent as
described above. Keep traffic held. Run:

```sh
sudo python3 scripts/incus/prepare-dedicated-uid.py \
  --manifest /root/incus-dedicated-uid.json check
sudo python3 scripts/incus/prepare-dedicated-uid.py \
  --manifest /root/incus-dedicated-uid.json stage --execute
```

The script checks that no process holds a descriptor in the old database or
its parent directory, including a process working directory,
that the runner socket is gone, that the new UID and sealed settings agree,
and that the built app and destination parents have safe owners and modes.
The explicit stage moves the stopped source database to a root-only quarantine,
checks again for open descriptors, then copies it twice: one
root-only rollback copy and one copy owned by the dedicated app UID. It
compares content hashes and writes a private stage receipt beside the
rollback copy. It never deletes the source. If staging fails after source
quarantine, leave the old app stopped and inspect the source before restoring
its old UID/GID and moving it back; do not retry blindly.

## 5. Start and verify before releasing traffic

Start the runner with the new `EZ_EXTENSION_APP_UID`, then start the
root-owned qualification supervisor. Check that its child has the chosen UID
and one expected process group, the runner gateway is reachable under that
UID, and the app opens the copied PGlite database with the same fixture and
unknown CREATE receipt. Check the operator socket remains root-only and the
signing key cannot be read by the app UID. Keep ingress held until these
read-only checks pass. Do not run no-effect recovery until the independent
runner-client fence verifier is installed and reviewed.

If a check fails before the new app accepts work, stop the supervisor and
runner. Keep the target copy for inspection. The original source and the
root-only rollback copy remain available; restore the recorded UID/GID
**recursively to every directory and file** in the quarantined source, then
restore its recorded root mode from `dedicated-uid-stage.json` and move it back to
the original path only after confirming that no process holds it and the
original path is still absent. Restore the source parent's reviewed owner and
mode. Then restart the old runner and app with their
original settings. If the new app has accepted work or run migrations,
review the resulting state before choosing a rollback point; switching
back to the old copy could lose writes.

For that owner restore, first verify the quarantine tree still has the
receipt's `sha256` and contains only regular files and directories. Use the
script's recursive `chown_tree(quarantine, sourceUid, sourceGid)` operation,
then set the recorded `sourceMode` on the root directory. Verify every nested
file with `owned_tree(quarantine, sourceUid, sourceGid)` before the atomic
move back. A root-directory-only `chown` leaves PGlite data and WAL files
unreadable by the old app. Keep the rollback copy intact during this check.

This procedure only prepares the UID cutover. The saved CREATE still needs
the independent client-fence verifier and the separate operator recovery
review in [incus-create-noeffect-recovery.md](./incus-create-noeffect-recovery.md).

## Current isolated test-app preparation packet

Read-only inspection on 2026-09-24 found the isolated app on
`127.0.0.1:4301`, with Vite process IDs `3878477`, `3878556`, `3878559`,
and `3878560`. Its `EZCORP_DB_PATH` was
`/tmp/ezh-incus-isolated-app.QMhk6Qhv/db`. The isolated runner was PID
`1982010`, and its gateway was PID `1983979`; both used dev UID `1001`.
The gateway pinned that same UID and served
`/tmp/ezh-incus-isolated-app.QMhk6Qhv/runner.sock`; the token file was
`/tmp/ezh-incus-isolated-app.QMhk6Qhv/runner.token`. These IDs are time-
limited evidence and must be refreshed. The active user service
`ezharness-extension-runner-dev.service` is a different runner; stopping it
does not stop the isolated runner. No qualification supervisor process was
found. No root-owned built release exists at `/opt/ezharness`; the app still
starts from `/home/dev`, which mode `0700` denies to the new UID.

Prepare these host writes for separate review before changing the live app:

1. Install a reviewed build and its runtime files under root-owned
   `/opt/ezharness`. Prove its dependency paths do not enter `/home/dev`.
   The preflight checks ownership and path access for `web/build/index.js`;
   first supervised start with traffic held must prove the full runtime.
2. Declare a static app UID/GID and a separate runner UID. Prepare the new
   runner service with the reviewed runner executable, store, socket parent,
   token file, and `EZ_EXTENSION_APP_UID` set to the app UID. Prepare sealed
   app/runner settings and a root-owned supervisor service/config. The
   supervisor starts the new app, so do not also start a second app service.
3. Create the root-only quarantine/rollback parents and root:new-app-group
   target parent. Hold the port's ingress, stop the four old app processes and
   isolated runner/gateway, remove only their stale socket after they exit,
   then seal the source parent. Refresh the manifest PIDs and run `check`.
4. Run `stage --execute` only after the preflight passes. Start the new
   runner service, then the supervisor. Check the new child UID, read-only
   fixture state, backend connection, and runner socket while ingress stays
   held. Keep the original database quarantined and rollback copy private.

The script can check and stage steps 2–4 after the operator prepares them.
It cannot build or install a release, assign static UIDs, stop live processes,
seal the source parent, create service units, or prove that all runtime imports
work under the new UID. It does not run the saved CREATE repair.
