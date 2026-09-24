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

Provision a static NixOS system user and group for this one isolated app.
Choose unused numeric UID and GID values and record them in the cutover
manifest. Keep the operator supervisor as root and the extension runner under
its separate account. For example, in a reviewed NixOS module:

```nix
users.groups.ezharness-qual = { gid = 62040; };
users.users.ezharness-qual = {
  isSystemUser = true;
  uid = 62040;
  group = "ezharness-qual";
  home = "/var/lib/ezharness-qual";
  createHome = true;
};
```

The values above are examples, not reserved IDs. Evaluate and apply the
host's NixOS configuration separately. Confirm that the chosen UID owns no
other process or file tree. The [NixOS manual](https://nixos.org/manual/nixos/stable/)
describes declarative users and systemd services.

Build the reviewed app release before stopping the old app. Install the whole
release and its dependency closure under a root-owned, non-writable path such
as `/opt/ezharness`. The supervisor's `appCommand` must start the real Bun
adapter entrypoint `/opt/ezharness/web/build/index.js`; `server.js` in the
example supervisor config is only a placeholder. Do not point the dedicated
user into this worktree: `/home/dev` is mode `0700`, and dev owns its code.
The preflight checks ownership, path traversal, and that exact entrypoint.

## 2. Prepare sealed settings

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
break every runner call. The socket's parent must have the app group and
group search permission. Its token file must be regular, non-symlink,
group-readable by the app group, and not group-writable or world-readable.
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
  "sourceDb": "/reviewed/old/pglite",
  "quarantineDb": "/tmp/ezharness-qual-quarantine/pglite",
  "targetDb": "/var/lib/ezharness-qual-data/pglite",
  "rollbackDb": "/var/lib/ezharness-qual-rollback/pglite",
  "oldAppUnit": "reviewed-old-app.service",
  "runnerUnit": "reviewed-runner.service",
  "supervisorUnit": "ezharness-incus-supervisor.service",
  "builtApp": "/opt/ezharness/web/build/index.js",
  "oldEnv": "/etc/ezharness/old-isolated.env",
  "newEnv": "/etc/ezharness/qualification.env",
  "runnerEnv": "/etc/ezharness/runner.env",
  "runnerSocket": "/run/ezharness-runner/runner.sock",
  "runnerTokenFile": "/etc/ezharness/runner-token",
  "supervisorConfig": "/etc/ezharness/incus-supervisor.json"
}
```

The example paths and numeric IDs are placeholders. Read the real isolated
app's process, loaded service unit, PGlite path, runner settings, and build artifact
before replacing them. A main app using external `DATABASE_URL` is not the
isolated PGlite app and must not be used for this cutover.

At the time of writing, the isolated app is a manually started Vite dev process
with four process IDs and its PGlite source is under a dev-owned `/tmp` parent.
That launch has no reviewed systemd unit and cannot pass this preflight. First
prepare a reviewed unit that owns the old app process group, stop the old
processes, and confirm the exact old PGlite path. Do not name a missing or
dummy unit in the manifest. The separate development runner user unit is also
not proof that the isolated runner process is stopped; register and review the
isolated runner unit before the cutover.

## 4. Hold traffic, stop, and stage

Hold ingress and all runner clients. Stop the old isolated app, its runner,
and any old supervisor unit. Verify all three units are inactive with no
main PID; verify the runner public socket is gone. Seal the source parent as
described above. Keep traffic held. Run:

```sh
sudo python3 scripts/incus/prepare-dedicated-uid.py \
  --manifest /root/incus-dedicated-uid.json check
sudo python3 scripts/incus/prepare-dedicated-uid.py \
  --manifest /root/incus-dedicated-uid.json stage --execute
```

The script checks that no process holds a descriptor in the old database,
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
root-only rollback copy remain available; restore the quarantined source's
recorded UID/GID and mode from `dedicated-uid-stage.json` and move it back to
the original path only after confirming that no process holds it and the
original path is still absent. Restore the source parent's reviewed owner and
mode. Then restart the old runner and app with their
original settings. If the new app has accepted work or run migrations,
review the resulting state before choosing a rollback point; switching
back to the old copy could lose writes.

This procedure only prepares the UID cutover. The saved CREATE still needs
the independent client-fence verifier and the separate operator recovery
review in [incus-create-noeffect-recovery.md](./incus-create-noeffect-recovery.md).
