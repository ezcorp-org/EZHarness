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
credential files. Their S3 and admin ports bind to `127.0.0.1` by default. The
script refuses a non-loopback bind address. Set the generated directory in
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
After a restart, the conformance runner also waits for an object read because
SeaweedFS registers durable volumes after its master election completes.
