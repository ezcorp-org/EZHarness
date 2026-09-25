# Factory local S3 storage

This profile is for local storage conformance tests. It uses SeaweedFS 4.46
with the pinned image digest in `compose.factory-storage.local.yml`.

Run `scripts/setup-factory-storage.sh up`. The script generates two sets of
ten tenant credentials below the mode-0700 `XDG_RUNTIME_DIR` parent. The
directory is outside the repository and every grantable project root. The
script prints the directory path but never credential values. `XDG_RUNTIME_DIR`
is required so a container-readable configuration cannot be exposed through
`/tmp`.

The ordinary and archive services have separate SeaweedFS volumes and separate
credential file mounts. Each service can read only its own credential file.
Each service has a 2 GiB memory limit, one CPU, and a 256-process limit. Their S3 and admin ports bind to `127.0.0.1` by default. The
script permits only the IPv4 loopback bind address. It checks that the runtime
directory is owned by the current user with mode 0700. Shutdown accepts only
a generated credential directory with a matching ownership record. Set the generated directory in
`EZCORP_FACTORY_STORAGE_SECRETS_DIR` before a later Compose command, then run
`scripts/setup-factory-storage.sh down` to remove containers, volumes, and
generated credentials.

Each tenant credential is limited to one `tenant-XX` bucket and one prefix:
`ordinary/` or `archive/`. Ordinary credentials are absent from the archive
service and cannot read, overwrite, or delete archive objects. The two services
run on the same host. Separate local volumes and credentials prove credential
separation only. They do not prove an independent replication or failure domain
required for a deployed archive.

Compose health confirms that the S3 gateway answers authorization requests.
Run `bun scripts/verify-factory-storage.ts` with the generated credential
directory exported to test all ten tenant identities, cross-tenant denials,
conditional writes, multipart uploads, and version reads. This is the default
behavior and is read-only against the shared stores; it exits 0 once every
check passes and prints one line noting that the restart-persistence leg was
skipped.

Pass `--restart-stores` to also run the restart-persistence leg. That flag
RESTARTS BOTH shared SeaweedFS stores (`factory-storage-ordinary` and
`factory-storage-archive`) to prove an object survives a service restart. Use
it only against a store this run owns exclusively: CI's own ephemeral
per-job stack (started and torn down in the same job), or a long-lived local
stack after you have confirmed with its owner that a restart is safe right
now. Never pass it against a shared host's long-lived stores without that
confirmation. After a restart, the conformance runner also waits for an
object read because SeaweedFS registers durable volumes after its master
election completes. `bun scripts/verify-factory-storage.ts --help` prints
the exact wording.

Run `bun scripts/verify-factory-archive-writer.ts` with the same credential
directory exported to test the archive-writer role itself: conditional create,
checksum, version reads, the archive inventory, and a refusal for every product
and restore attempt to read, overwrite, or delete an archive object, across all
ten tenant identities. This is the default behavior and does not touch any
shared container's lifecycle; it exits 0 once every check passes and prints
one line noting that the product-store-outage leg was skipped.

Pass `--restart-stores` to also run the product-store-outage leg, which
proves the archive keeps answering, and that a real release provider cannot
verify a receipt, while the product store is down. That flag STOPS then
RESTARTS the shared `factory-storage-ordinary` store, so run it only under
the same rules as `verify-factory-storage.ts --restart-stores` above (a store
this run owns exclusively, with the owner's confirmation on a shared host),
and under `flock /tmp/ezcorp-validation-heavy.lock` on a shared host. Its
receipt records `failureDomain: "same-host-not-independent"` and the unmet
criterion `deployed-independent-failure-domain`, because that is what one
host can show; without the flag, the receipt's `ordinaryStoreLoss` records
`{ skipped: true }` instead of the outage proof.
`bun scripts/verify-factory-archive-writer.ts --help` prints the exact
wording.

Each SeaweedFS server allows up to 400 volumes of 64 MiB (25 GiB). The
first limit of 100 volumes was exhausted during the ten-tenant campaign because every tenant collection grows seven
volumes at a time; the master then reported "failed to find writable volumes"
and every upload failed. On 2026-09-25 the ordinary store held 308 of its
400 volumes: 16.95 GiB in 59,888 live keys, of which only three had ever been
deleted. Two suites held most of it: `ordinary/s3-publication` and
`ordinary/s3-published` (8.3 GiB each, from a 256 MiB multipart export per
run). The ceiling must keep the host above its 100 GB disk floor at recreate
time, so it rises only after the reviewed-manifest prune of that backlog lands,
with the free space measured then; a raise to 600 volumes (37.5 GiB) would have
taken the host from 106 GB free to about 86 GB. Raising the limit only changes
the server command; the named data volumes and credential files are kept.

The buckets are versioned, so deleting a key only adds a delete marker and the
bytes stay. A proof run must remove every version it wrote. The PostgreSQL
proofs' helper does this: `createFactoryOrdinaryStorage(prefix, tenant, owns)`
in `tests/postgres/helpers/factory-storage.ts` takes a run-unique prefix (a
UUID) and any other run-unique prefixes the run writes to, such as a
publication destination, and its `close()` permanently removes every version
and delete marker under them. It refuses a prefix with fewer than two path
segments, so it never reaches a bucket root or the shared `ordinary/` root that
installations write to. Every caller must await `close()`. The SeaweedFS master
compacts the deleted bytes out of each volume with its periodic vacuum. Archive
objects are immutable and the archive credentials cannot delete them.

Leftovers from earlier runs are removed only with
`scripts/prune-factory-storage-manifest.ts`, which deletes exactly the object
versions a reviewed manifest names. Other packages' receipts can point at
objects in this store, so a prefix or time-window delete is not allowed (see
`tasks/factory/w07-GATES.md`). The coordinator authorizes each manifest. Run it
dry first, then with `--apply`.

Each server has a 2 GiB memory limit. The first limit of 768 MiB killed the
ordinary service (exit 137, `OOMKilled`) after 186 volumes were loaded and a
256 MiB object arrived through the S3 gateway; the same service idles at about
211 MiB with those volumes loaded. Raising the limit changes only the container
configuration. A recreate keeps the named data volumes and the credential files.

### Memory and the host OOM killer

On 2026-09-25 each store's cgroup was sampled every second while the
PostgreSQL checkpoint and restore suites, one W19a mock pass, and the
`db-postgres.yml` storage step ran at the same time. The ordinary store peaked
at 1263 MiB, of which 739 MiB was anonymous memory and the rest page cache,
with 308 volumes loaded. The archive store peaked at 247 MiB. Neither container
had an OOM kill, so the 2 GiB limit stays. The receipts are under
`/tmp/factory-platform-evidence/w15d/`.

The two store kills on 2026-09-23 (ordinary) and 2026-09-25 (archive) were not
caused by this limit. The kernel log shows a host-wide OOM
(`constraint=CONSTRAINT_NONE`, `global_oom`): swap was exhausted, and on
2026-09-25 62 processes named `MainThread`, the name Node gives its main thread,
held 21.6 GiB. The `weed` process that died
held under 10 MiB resident. The kernel chose it because its `oom_score_adj` was
200. On this host that adds about 9 GiB to its OOM score, while test processes
run at 0.

A store gets 200 when Compose creates it through the rootless Podman socket.
The socket starts `podman.service`, which the systemd user manager runs with
`OOMScoreAdjust=200`. An unprivileged process cannot lower its own adjustment,
so the container inherits 200. An `oom_score_adj` line in the Compose file
cannot override this: through the socket, a request for 0 or 100 still gives
200. A container started with `podman` from a login shell gets 0.

Protecting the stores therefore needs one of two host-side measures. One is a
user drop-in for `podman.service` that sets `OOMScoreAdjust=100`, the lowest
value the user manager allows. The other is to keep the total of concurrent
builds, coverage runs, and test pools within the host's memory. Both are
decisions for the host's owner, not for a single package.

## Engine, and recovery after a reboot

`scripts/setup-factory-storage.sh` drives Compose through
`scripts/lib/container-engine.sh`: Podman by default on a developer host
(Compose is pointed at the rootless socket through `DOCKER_HOST`), Docker
under CI, and `EZCORP_CONTAINER_ENGINE=podman|docker` to choose.
`scripts/verify-factory-storage.ts`'s restart-persistence leg and
`scripts/verify-factory-archive-writer.ts`'s product-store-outage leg (both
gated behind `--restart-stores`) drive Compose the same way, through the
TypeScript port of that same rule, `scripts/lib/container-engine.ts` — all
three files keep one rule text so they cannot drift apart. A host reboot
clears the credential
directory, which lives on tmpfs below `XDG_RUNTIME_DIR`, while the containers
and their data volumes survive.
`scripts/setup-factory-storage.sh recover` removes only the containers, keeps
the volumes, and starts again with a fresh credential set; `up` refuses to run
while the old containers exist, and `down` needs the directory that is gone.
