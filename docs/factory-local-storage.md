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
Each service has a 768 MiB memory limit, one CPU, and a 256-process limit. Their S3 and admin ports bind to `127.0.0.1` by default. The
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
conditional writes, multipart uploads, version reads, and restart persistence.
After a restart, the conformance runner also waits for an object read because
SeaweedFS registers durable volumes after its master election completes.

Run `bun scripts/verify-factory-archive-writer.ts` with the same credential
directory exported to test the archive-writer role itself: conditional create,
checksum, version reads, the archive inventory, and a refusal for every product
and restore attempt to read, overwrite, or delete an archive object, across all
ten tenant identities. It stops the ordinary service for one step, so run it
under `flock /tmp/ezcorp-validation-heavy.lock` on a shared host. Its receipt
records `failureDomain: "same-host-not-independent"` and the unmet criterion
`deployed-independent-failure-domain`, because that is what one host can show.

Each SeaweedFS server allows up to 400 volumes of 64 MiB (about 25 GiB). The
first limit of 100 volumes was exhausted during the ten-tenant campaign because
every tenant collection grows seven volumes at a time; the master then reported
"failed to find writable volumes" and every upload failed. Raising the limit
only changes the server command; the named data volumes and credential files
are kept. Tests must still delete the objects they create.

Each server has a 2 GiB memory limit. The first limit of 768 MiB killed the
ordinary service (exit 137, `OOMKilled`) after 186 volumes were loaded and a
256 MiB object arrived through the S3 gateway; the same service idles at about
211 MiB with those volumes loaded. Raising the limit changes only the container
configuration. A recreate keeps the named data volumes and the credential files.

## Engine, and recovery after a reboot

The script drives Compose through `scripts/lib/container-engine.sh`: Podman by
default on a developer host (Compose is pointed at the rootless socket through
`DOCKER_HOST`), Docker under CI, and `EZCORP_CONTAINER_ENGINE=podman|docker` to
choose. A host reboot clears the credential directory, which lives on tmpfs
below `XDG_RUNTIME_DIR`, while the containers and their data volumes survive.
`scripts/setup-factory-storage.sh recover` removes only the containers, keeps
the volumes, and starts again with a fresh credential set; `up` refuses to run
while the old containers exist, and `down` needs the directory that is gone.
