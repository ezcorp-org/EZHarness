# Durable extension lifecycle

The host owns installation records, source revisions, build operations, releases,
approvals, and activation state. Source and artifact bytes use the host digest
store. Database transactions serialize installation changes on both PGlite and
PostgreSQL. Release records and revision snapshots cannot be edited or deleted
through the normal repository interface.

`ExtensionLifecycle.build` queues frozen input. A host worker calls `runBuild`.
`recoverExtensionLifecycle` must run before serving extension traffic after a
restart. The runtime resolves the active pointer for each call. Catalog updates
remain `reconciling` until their acknowledgement is durable.

Only authenticated human administrators can approve through the production
service. Approval binds the release, owner, scope, exact grants, runner image,
policy, and expected generation. The harness control does not expose approval.

## Data changes

`manifest.dataSchema` describes the extension's `extension_storage` data only.
It has `version`, `readableVersions`, and optional `migrateMethod`. The migration
method must be declared in `manifest.methods`. Its input is
`{ fromVersion, toVersion, values }`; its output is `{ values }`.

The host snapshots storage before a change. Each user or conversation storage
scope runs in a separate worker, with no host effects. Each scope is limited to
512 KiB for the migration input and result. A database trigger rejects writes
while storage is paused. The active pointer commits before writes resume.
Failed transformations restore the saved snapshot. Fencing prevents an expired
activation worker from restoring a newer migration.

Encrypted values require a separate migration and are refused here. Settings,
secrets, entities, and files are retained but are not transformed by this API.
An unreadable code rollback fails with `data_restore_required`; it never silently
discards writes made by the newer release.

## Delivery queue

`ExtensionDeliveryQueue` stores event, webhook, and schedule deliveries with an
explicit owner, scope, release, generation, and deduplication ID. Generation
changes cancel queued and leased work in the same transaction. Worker leases
are fenced. Known failures before an external effect can retry up to three
times. Uncertain external results become `outcome_unknown` and are not retried
automatically. Producers must supply durable deduplication IDs and the dispatcher
must invoke the existing release runtime with the frozen generation and a
host-issued call token. The queue is host-only; it is not a harness tool.

## Checks

Version 4 filesystem calls use `/project` and `/data`, not host paths. `/project`
resolves from the authenticated caller's conversation and project membership.
`/data` is the extension's retained shared data directory. Both the manifest and
the approved grant must cover the virtual path. Descriptor-based access rejects
symlink traversal. File transfers are limited to 512 KiB per call under the
bounded runner protocol; larger transfers require a separate chunked API.

`VirtualFilesystemPorts.roots` and `StorageContext.repository` let candidate tests
use the production handlers with temporary roots and isolated storage. Storage
ports include scoped queries, transactions, conversation wiring, and encryption.
Tests must not substitute an allow-all production identity or production secrets.
The default storage port keeps quota checks and writes in one transaction.
Catalog verification never invents a smoke tool call. Declared smoke checks must
pass using the candidate broker; sealed catalog verification alone is not proof
of all feature behavior.

Candidate verification uses the production filesystem, storage, credential, and
network handlers with temporary roots, separate storage, an ephemeral encryption
key, and exact network response fixtures. No candidate request reaches a real
provider or production secret. Missing adapters fail closed. A denied request
fails verification even if the extension catches its error. The immutable release
records which declared capabilities were tested, denied, or not exercised.

Run `bun scripts/verify-first-party-lifecycle-v4.ts` for full first-party source
builds and candidate checks through PGlite and the real rootless Podman runner.
The script emits JSONL evidence and stops at the first failure. Set
`EXTENSION_VERIFY_ALL=1` to collect every failure, or `EXTENSION_VERIFY_NAMES` to
select a comma-separated subset. Optional `EXTENSION_VERIFY_FIXTURES` names a
JSON file keyed by extension name with explicit isolated test fixtures. The
summary reports untested extensions. The script never approves or activates.

Run each `*.test.ts` file in its own Bun process. The lifecycle, delivery, and
data-migration suites use real PGlite transactions. The blob tests use real files.
To check the other supported driver against a disposable PostgreSQL database:

```sh
EXTENSION_TEST_POSTGRES_URL=postgres://... bun src/extensions/v4/postgres.integration.ts
```

The PostgreSQL check creates and removes its own random schema. It verifies JSON
fidelity, competing writes, transaction rollback, the storage write gate, and
delivery cancellation. Candidate protocol tests do not replace product parity
tests or real runner isolation tests.
