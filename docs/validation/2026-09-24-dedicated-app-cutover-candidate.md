# Dedicated app cutover candidate — 24 September 2026

Status: **private preparation only**. The old isolated app and runner still
run. No traffic hold was asserted, service started or stopped, environment
captured, token seeded, database copied, project tree moved, or server changed.
This packet records candidate inputs for a later exact action review.

## Private candidates and current evidence

| Input | Candidate or observation |
| --- | --- |
| Settings manifest | `/root/incus-qualification-settings-candidate-20260924.json`; pins source PID 3878560, boot ID `12e34c4a-efb4-4b11-8e95-8b74e262b5b5`, start ticks 28758896, source and target paths, setup SSH files, recipe and supervisor public key. Refresh its process identity before use. |
| Supervisor config | `/root/ezh-qual-supervisor-config-candidate-20260924.json`; root:root `0600`; SHA-256 `830487da9185c77df2d234d65925e8f90b447448c088073ab3b556aed1c89749`. Pins `/opt/ezharness/bin/bun /opt/ezharness/web/build/index.js`, UID/GID 62040, app control and private operator sockets, root-owned candidate signing key, authorization and recovery verifiers. `receiptAuthorityCommand` and `recoveryFenceCommand` both run `false`. Fault authority is absent. |
| Signing key | Existing `/root/ezh-qual-supervisor-key-candidate-20260924/{private,public}.pem` are root:root `0600`; the public key SHA-256 is `b92e7fb471f30d87ff5fcb364dd80ceeba31e7e6d823e7e1c8239050d8a54600`. OpenSSL derived the same public PEM from the private key. The settings manifest points to this public PEM. |
| DB stage manifest | `/root/ezh-dedicated-uid-stage-candidate-20260924.json`; root:root `0600`; SHA-256 `aac226181efbb704ca2e6b6a5ae2f888b4d7ddcb2841a3fc4539e70b89908e3f`. Pins the old manually launched app and runner PIDs, old `1001:100`, app `62040:62040`, runner UID 62041, socket GID 62042, source `/tmp/ezh-incus-isolated-app.QMhk6Qhv/db`, quarantine `/tmp/ezharness-qual-quarantine/pglite`, target `/var/lib/ezharness-qual-data/pglite`, and rollback `/var/lib/ezharness-qual-rollback/pglite`. It names the final `/etc/ezharness` files, not candidate files. |
| Installed host | Both qualification units are loaded, inactive, MainPID 0. Accounts have the stated IDs and the app and runner share only socket GID 62042. `/etc/ezharness/incus-setup-identity` and `incus-setup-known-hosts` are root:app-group `0640`. The release entrypoint and three verifier scripts exist under root-owned `/opt/ezharness`. |
| Project tree | Source `/tmp/ezh-incus-isolated-app.QMhk6Qhv/projects` is `1001:100` `0700`; current inventory has five directories, no regular files, links, or special files. Target `/var/lib/ezharness-qual-data/projects` is absent. Re-inventory after the hold. |

The candidate signing key stays under `/root` because the supervisor runs as
root. Before installing the config at `/etc/ezharness/incus-supervisor.json`,
verify that the private key is still a regular root-owned `0600` file and
that the public PEM in the sealed app environment matches it. The supervisor
service already sets `EZCORP_INCUS_SUPERVISOR_DB_PATH` to the target PGlite
path and loads `/etc/ezharness/qualification.env` for its child.

## Cutover gates

1. Review the exact active AMD generation and server setup gate readback.
   Recheck the dedicated SSH key, known-hosts pin, recipe, image digest,
   release manifest and process identities. Keep the old app live while an
   operator establishes a real ingress and runner-client hold and writes the
   exact root-owned hold receipt. This packet supplies no hold evidence.
2. Run `prepare-qualification-settings.py prepare --execute`, `check`, and
   `check-live-source` with the pinned settings manifest. Review sealed file
   hashes, modes and crypto equality. Install the reviewed sealed files at
   the module's exact `/etc/ezharness` paths. Do not set `DATABASE_URL`.
3. Stop only the pinned isolated app and runner. Verify their PID start
   identities, absence, listener and socket closure, and no clients of the
   source paths. Record the source parent owner/mode, then seal it root:root
   `0700`. Keep both dedicated units inactive. Seed the runtime runner token
   through the guarded runbook command; do not start a unit to make it.
4. Create empty root:root `0700` parents for the quarantine and rollback DB
   paths and confirm quarantine shares the source filesystem. Confirm the
   already-present target parent remains root:app-group `0710`. Re-pin the
   exact old process ID lists and manifest SHA-256. Only then run the stage
   script's read-only `check`, review its output, and separately authorize
   `stage --execute`. The stage script preserves a quarantined original and
   root-only rollback copy.
5. Transfer the project root while ingress remains held and before the new
   supervisor starts. Inventory the stopped tree again and reject links,
   special files, unexpected owners or open descriptors. Record a sorted
   relative-path, file-content and mode digest. Copy into a newly created
   private temporary directory inside `/var/lib/ezharness-qual-data`, compare
   the copy against that inventory, then give all copied directories and files
   UID/GID `62040:62040` with private modes. Atomically rename the checked
   copy to `projects` only while that target is absent. Keep the original
   source tree under the sealed parent as the rollback source. The DB stage
   script does not handle this tree.
6. Before any app start, review saved `projects.path` values and other
   persisted absolute project paths against the new root. Reject the cutover
   if a saved path still points to the old tree or to a path inaccessible to
   UID 62040; plan an exact reviewed data correction rather than a blanket
   string replacement. After runner and supervisor start, verify app UID,
   port owner, runner peer access, PGlite fixture, saved CREATE state,
   project access, and root-only operator controls before releasing ingress.

`prepare-dedicated-uid.py check` is **not yet expected to pass**: the old
clients still run, sealed environments and runtime token do not exist, the
source parent is still owned by UID 1001, quarantine and rollback parents
are absent, and the candidate `recoveryFenceCommand` is `false`. The script
explicitly rejects `false` in its full preflight. Keep recovery disabled
until a separate independent observer and client-fence verifier are installed
and reviewed; then replace that command with the exact working verifier and
repeat the manifest and preflight review. Do not weaken the script to make
this candidate pass.

## Rollback boundary

Before the new app accepts work, stop its supervisor and runner, keep ingress
held, and verify no process uses the target or quarantined trees. Preserve
the target DB and projects copy for diagnosis. Check the DB stage receipt and
quarantine digest, restore the quarantined DB tree's original `1001:100`
ownership and recorded root mode, and move it back only if the original DB
path is absent. Restore the original project tree's recorded owner and mode
and the source parent's recorded `1001:100` `0700` state. Restart only the
old isolated runner and app with their sealed old settings, then verify the
old fixture and CREATE row. If the new app accepted writes or ran migrations,
stop and review the changed data before selecting a rollback point; the old
copy may be stale. Never delete the quarantine or rollback copy as part of
this preparation.

Validation: `prepare-dedicated-uid.py` parsed the candidate manifest with
its exact-key and path schema; supervisor required/optional keys, UID/GID,
command paths and disabled fence were checked against the supervisor parser.
The direct Python suites for dedicated UID staging (18 tests), supervisor
(9), and settings preparation (6) pass. These checks validate candidate
shape and code behavior only. They do not prove a live traffic hold, sealed
settings, DB consistency, project references, rootless Podman, or server
authority.
