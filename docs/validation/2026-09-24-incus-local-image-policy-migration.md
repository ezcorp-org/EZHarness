# Incus local-image policy correction — 2026-09-24

Status: exact project correction applied and verified on 2026-09-24.

The isolated EZHarness setup created project `ezharness` with
`restricted.images.servers=images.linuxcontainers.org`. The pinned guest image
`57c0d028e4456a3847fb9822802d6a8f613ba4e6ef03002999e8c957a1f40c6c`
is local to the server's default image project (`features.images=false` in
`ezharness`). A disposable `incus launch` in `ezharness` failed before creating
an instance: `Image server "" isn't allowed in this project`. The project still
has zero instances.

[Incus 6.0.6's project permission code](https://github.com/lxc/incus/blob/v6.0.6/internal/server/project/permissions.go#L97-L113)
compares the source server host with the comma-delimited allowlist. A local
fingerprint source has an empty host. The existing allowlist therefore blocks
the only image source this deployment needs. This behavior is version-specific;
the reviewed recipe pins Incus 6.0.6.

A temporary restricted project with `features.images=false` and
`restricted.images.servers=,` initialized the exact pinned local image. It did
not start a guest. The temporary instance and project were deleted, with zero
cleanup errors. On this selected Incus version, `,` allows the empty local
source and no named remote server. The new checked-in recipe is version 1.2.1,
pins that value, and rejects the old remote-only value in validation. Its
focused setup suite passed 26 tests, and the scripts TypeScript and Biome
checks passed.

## Exact live correction

Target: `dev@sandbox-server.taile1c5b0.ts.net`, project `ezharness` only.
Use the pinned SSH identity and known-hosts file. Before the write, require:

1. `incus project get ezharness restricted.images.servers` is exactly
   `images.linuxcontainers.org`.
2. `incus list --project ezharness --format csv -c n` is empty.
3. The exact pinned image fingerprint above is present in the shared image
   view, and the project's `features.images` is `false`.
4. The restricted project, profile limits, client trust, firewall rules,
   storage pool, and bridge still match their reviewed state.

Then run only:

```sh
incus project set ezharness restricted.images.servers=,
```

Read back the exact comma value and repeat the zero-instance check. Next,
launch a disposable guest from the exact pinned image under the existing
`compose` profile, check guest-to-host management denial and bridge DNS/DHCP,
and delete only that disposable guest. If the policy change or guest test fails,
delete any test guest first and restore only the old key with:

```sh
incus project set ezharness restricted.images.servers=images.linuxcontainers.org
```

This correction keeps `restricted=true`, all resource limits, network and
device restrictions, and the existing project-scoped TLS client trust. The
old setup row and capacity receipt remain historical evidence of their exact
approved plans. A future reviewed operator update flow should record this
project-key migration as a first-class plan instead of relying on a manual
operator correction.

## Live result

The preflight checked the old value, zero project instances, the pinned image,
the reviewed project/profile, and the scoped client trust. A guarded timer was
armed to restore the old value if the test was interrupted. The one-key change
read back as `,`. The exact pinned image then started one disposable guest in
the restricted project. The guest received an IPv4 bridge address and resolved
`example.com`. TCP connections from the guest to the host's bridge and
Tailnet management addresses on ports 22 and 8443 were denied. The AMD host
could still reach both management ports. The guest was deleted. Fresh readback
showed zero project instances, the `,` policy, and an inactive rollback timer.

This proves the local-image source and the tested firewall paths on the
selected host. It does not prove EZHarness can yet create or control a guest.
