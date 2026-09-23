# Factory retention, checkpoints, and restore

This guide describes the C06 recovery features (work package W15): retention,
the compatible checkpoint barrier, key wrapping, and restore into a new
execution epoch. It names what an operator must configure and what each check
proves.

## Retention

The `retention-gc` role enrolls each subject when it reaches its anchor. The
anchor is the moment a run became terminal, a release settled, or a key wrap
was superseded. The deadline is the anchor plus the class period:

| Class | Period | Subjects |
| --- | --- | --- |
| Ordinary history | 30 days | Temporal workflow history (namespace retention) |
| Unaccepted candidate | 90 days | `candidate_output` artifacts of terminal runs |
| Debug log | 90 days | No factory store holds debug logs today, so nothing enrolls |
| Canonical audit | 365 days | A run's audit batches and projections |
| Release | 365 days | Settled release operations |
| Accepted evidence | 365 days | A terminal run's validator evidence |
| Approval | 365 days | A terminal run's command and release approvals |
| Receipt | 365 days | A terminal run's task completion, outcome, and stop receipts |
| Key version | 365 days after it is superseded | Prior data-key wraps |

A database CHECK refuses a deadline below its class period. A release can
extend a deadline. Nothing can shorten one.

A due subject is collected only after these checks, in this order:

1. The subject's archive copy exists and reads back. The role archives audit
   streams early, when the run becomes terminal. An archive failure stops the
   whole pass before anything is removed.
2. No live reference holds the subject. The run must be terminal, its children
   settled, its releases settled, and its attempts finished. A foreign key that
   the database catalog names keeps the subject. A sealed checkpoint from the
   last 365 days keeps the key wrap it recorded.
3. The subject is tombstoned in its own transaction.
4. The references are checked again under the row lock. Only then is the
   primary copy removed.

Releases, receipts, approvals, and accepted evidence are tombstoned at their
deadline and never deleted by this role. Final deletion needs the explicit
C09 purge, which is not built yet.

To rebuild a run view after its audit expired, read the archived stream with
`readFactoryArchivedRunAudit` and import it with `importFactoryArchivedRunAudit`.
The import refuses a gap or a conflicting digest.

## Compatible checkpoints

The `checkpoint-barrier` role seals a checkpoint at least every five minutes.
The database refuses a release claim or an attempt launch while the newest
sealed checkpoint is older than 15 minutes. This rule holds with no policy
row: a new installation cannot claim an effect until its first barrier seals.
If the role cannot compose, it is held, readiness is `degraded` with the reason
`factory-checkpoint-barrier-held`, and effect claims stay closed.

The role needs three things from the startup document: the archive credential
set, the pool client, and `temporalHttp`, the tenant namespace's Temporal HTTP
API. Every checkpoint records the Temporal position of each live workflow.

One barrier does these steps:

1. It closes release claims and attempt launches with a flag that expires by
   itself after the barrier's maximum.
2. It waits up to one second for in-flight senders to settle. Ordinary writes
   still flow during this step.
3. It pauses factory writes. A transaction that has not written yet waits at
   its first factory write. A transaction that already wrote continues.
4. It takes an exclusive lock when every writing transaction has finished.
5. It records the WAL position, the product-state digests, every object
   version, the fenced senders, the tenant's pool reservations, and the
   Temporal positions.
6. It writes the object inventory, the manifest, and a seal to the independent
   archive, and reads each one back.
7. It commits the sealed row and resumes writes and claims.

The target is 2 seconds and the maximum is 10 seconds. Past the maximum the
barrier aborts, records an aborted attempt, and claims no checkpoint. The abort
itself adds the rollback time, a few milliseconds, to the measured duration.

At most 16 barriers run at once across every tenant that shares a pool. The
pool service holds sixteen slots. A barrier runs only while it holds one. When
every slot is held, the barrier defers and the role retries on its next pass.
A slot expires 15 seconds after it is taken, so a coordinator that dies cannot
hold one for good. Barrier windows are recorded
with their duration so C11 can exclude them from steady-state percentiles.

Every `factory_*` table carries the barrier's statement trigger. A barrier
refuses to run (`barrier_gate_incomplete`) while any factory table lacks it.
The migration attaches it on every boot.

## WAL archiving

A checkpoint's WAL position is useful only if the WAL is archived
continuously. Configure the product PostgreSQL server with:

```
wal_level = replica
archive_mode = on
archive_command = '<copy %p to durable storage as %f>'
```

`factoryWalArchiveReadiness` reports the server's settings and archiver
statistics and names every unmet criterion. To restore, start a new server
from a base backup with `restore_command`, `recovery_target_lsn` set to the
manifest's `product.lsn`, and `recovery_target_action = promote`.

## Temporal history

Create or update each tenant namespace with the arguments that
`factoryTemporalNamespaceArguments` returns: 720 hours of retention, and history
and visibility archival to the given URIs. `verifyFactoryTemporalRetention`
reads the settings through the Temporal HTTP API and names any unmet criterion.

Workflow positions are read through the visibility list, because the HTTP
describe route cannot address a workflow id that contains `/`. A running
workflow has no history length there; a closed one has.

## Key wrapping

The installation data key never changes. Rotation adds a wrap under the
current key and keeps every earlier wrap. No encrypted object is rewritten.
The startup document's `keyManagement` section selects the wrapper. Absent, the
operator master key in `keys` is used. The orchestration process's `codec`
section carries the same `keyManagement`, so its payload codec opens the data
key through the same service; one unit (`composeFactoryDataKeyWrapper` in
`key-management.ts`) selects it for both processes. The wrap file must be made
under the selected service: a wrap made under another service is refused as
`factory_key_invalid`, and a service that cannot open the wrap is refused as
`factory_key_missing` with the service's error as its cause. Every sealed
checkpoint manifest names the selected service in `keys.service`. Three
wrappers exist:

- The operator master-key file (`readOperatorMasterKey`), for self-hosted use.
- `FactoryCloudKmsWrapper`, for hosted use with a cloud KMS client that has the
  AWS KMS `encrypt` and `decrypt` shapes.
- `FactoryTransitKmsWrapper`, for a self-hosted Vault or OpenBao transit
  engine. Its token is read from a private file for every call.

## Restore

A restore runs against a restored product database, before the product process
admits work. The operator runs it with the restore command:

```
DATABASE_URL=... EZCORP_FACTORY_STARTUP_CONFIG=... bun scripts/factory-restore.ts begin --restore-id <id> --fence <attestation.json>
bun scripts/factory-restore.ts verify --restore-id <id> --fence <attestation.json>
bun scripts/factory-restore.ts status --restore-id <id>
```

The command builds the restore from the installation's own composition: its
release providers, host stop client, pool clients, Temporal reader, and key
wrapper. A part that cannot compose is named in `uncomposed`, and its check
blocks. The fence attestation is a private JSON file with `restoreId`,
`ingress`, and `credentials`. The operator or the provisioner writes it after
the old deployment's ingress route is withdrawn and its credentials are
revoked. The command exits 2 while a tenant-blocking check remains.

1. `FactoryRestore.open` raises the installation's execution epoch and records
   an open restore epoch. From this moment, run admission, release claims, and
   attempt launches are refused, and every old-epoch token is refused.
2. `verify` fences the old deployment's ingress and credentials. It then checks
   the schema, the product state at the moment the epoch opened, the key
   version, and every object version against the sealed manifest.
3. It re-creates pool reservations that the shared ledger lost, as
   `uncertain`, and blocks any whose capacity another holder now has.
4. It compares Temporal positions. A tenant restore keeps the live namespace
   and blocks a run whose workflow moved past the restored product stream. A
   cluster restore requires every position to equal the manifest's. With no
   live reader, or a manifest without positions, the check blocks in both
   modes.
5. It verifies every run's audit stream, imports archived batches the database
   no longer holds, and rebuilds projections.
6. It recovers every release identity in the archive and checks each receipt
   with its provider. Nothing is dispatched. An archived intent or receipt that
   cannot be read blocks the tenant; no identity is skipped.
7. It asks the original supervisor to stop every worker that was live at the
   old epoch, and verifies the signed stop receipt. It revokes every live pool
   reservation the restored database does not know.
8. It writes the recovery report to the database and the archive.

A blocked check, worker, or pool finding keeps the whole tenant closed. A
blocked run stays at the old epoch after service resumes. `verify` can run
again after an operator fixes a blocked finding.

`sign` accepts only a human administrator with a browser session and the exact
report digest. It moves every unblocked run to the new epoch and enables
service. Run a checkpoint barrier right after, so the freshness rule opens
effect claims.

For a cluster-wide Temporal disaster, use `runFactoryClusterRestore`. It opens
every tenant's epoch before it verifies any tenant.

## Local-only caveats

On the development host, both S3 services and every database run on one
machine. The proofs here show the logic and the credential separation. They do
not show an independent failure domain, a real cloud KMS, or a deployed
restore. The deployed restore proof waits for W16.
