# Incus image transfer and first-write review packet — 2026-09-23

This packet makes the image portion of the [server apply plan](2026-09-23-incus-server-apply-plan.md) concrete for `dev@sandbox-server.taile1c5b0.ts.net`. It is a proposal for review. No server directory was created, no file was transferred, and no Incus resource or image was created during this pass. The server has no storage pool, and its default profile has no root disk or network device. The revised builder from source commit `a07761cad` uses explicit storage and network flags; its exact committed bytes are staged locally and rehashed below. The checked-in recipe still has null source, runtime, and published-image pins. The separate setup plan digest and provider client certificate do not exist yet.

## Read-only evidence taken again

Strict, noninteractive SSH succeeded with `/home/dev/.ssh/id_ed25519_personal` and `/home/dev/.ssh/known_hosts`. The matching ED25519 host-key fingerprint is `SHA256:a3VHX02pT5agIluq6K12E9oCuTg09ErbQ5wK9Vvk8Co`. The private key was not read or copied. Fixed read-only SSH commands reported:

| Check | 2026-09-23 observation |
| --- | --- |
| Host and Incus | `sandbox-server`, x86_64, Incus client/server 6.0.6, active service |
| Host readiness | NTP synchronized, cgroup v2, nftables, Btrfs driver available, 214,412,595,200 root-free bytes at `2026-09-23T17:41:09Z` |
| Pins | Server certificate `c8d6afdbaa6b1dc094f9b8b8dcc949861aca21c98b1d736cee981a8cb107a7d1`; address `100.81.181.39` present; all recipe-required API extensions present |
| Existing Incus state | Only the `default` project and profile; the default profile has `devices: {}`; no storage pool, managed Incus bridge, instance, trust entry, or default-project image; no route starting `10.173.`; no HTTPS listener |
| Transfer prerequisites | `/home/dev` is writable by `dev`; proposed stage path does not exist; server has `scp`, `sha256sum`, `tar`, `python3`, and `bash`; local `scp -O` is supported |

This is a point-in-time observation. Repeat the inventory immediately before the first write. After `bun install --frozen-lockfile` restored this worktree's dependencies, Bun 1.3.14 ran the repository `cli.ts inspect` and pure `plan` successfully. Private mode-0600 outputs are under `/tmp/ezh-incus-readonly-20260923.1zPJhf/`. The plan status is `blocked`, with `guest_image_artifact_unpinned` and `provider_client_certificate_missing`. Its digest `6ddd5c3445f987c77aa9278e54b47ac1784e617ab4500cd98919233a66640ffb` is only the **blocked initial plan**, not a digest to approve or apply. Fixed read-only SSH commands independently gave the same server facts.

## Exact local files for review

The split base and runtime files are present under `/tmp/ezh-incus-image-inputs-20260923`. Their hashes were measured again in this pass. The base's metadata bytes followed by root bytes hash to `7ccaa583b060cfec673f96fa9acd52d153a35a8090d68be4cd946280f4b61907`, matching the remote Debian 12 amd64 default build `20260923_05:24` recorded in the [candidate input record](2026-09-23-incus-image-inputs.md). The staged transfer totals 229,893,575 bytes.

| Transfer name | Source | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `incus.tar.xz` | `/tmp/ezh-incus-image-inputs-20260923/incus.tar.xz` | 672 | `ef5a700d30426a2e237499a887f77f59b7527b66f98af8d4207354fb54d7a76a` |
| `rootfs.squashfs` | `/tmp/ezh-incus-image-inputs-20260923/rootfs.squashfs` | 111,468,544 | `5f22057b045cffc162824bae27f4a0df2457aed7bb274a903d4b0f411631b973` |
| `docker-29.8.1.tgz` | `/tmp/ezh-incus-image-inputs-20260923/docker-29.8.1.tgz` | 86,055,881 | `d8db66739d2e28d4933786d73e918d9be643a67fbd835db1bf740d650a259e70` |
| `docker-compose-linux-x86_64` | `/tmp/ezh-incus-image-inputs-20260923/docker-compose-linux-x86_64` | 32,333,754 | `db1889184726840f75c4f9c001048430d4f25b3be3cb084d3ddd762bc0aed576` |
| `helper.py` | `src/infrastructure/incus-guest/helper.py` | 26,038 | `804d68bd8d83ca817c6413eb3b2365216778aa26421c81fb3e9f3810b82dcb75` |
| `build-guest-image.sh` | `/tmp/ezh-incus-image-inputs-20260923/build-guest-image.sh`, copied byte-for-byte from commit `a07761cad` | 5,236 | `716e5d7bd23d76c2a0a0dd40dba13d762a5fcde05aa2775c538ad6b10a7b448d` |
| `candidate-recipe.json` | `/tmp/ezh-incus-image-inputs-20260923/candidate-recipe.json` | 3,450 | `e9ce73a3da2fd81aa6662168fe83aff607fdfa2b813951f4e9ed186ee76fde42` |

The candidate recipe is a local copy of `scripts/incus/recipe.json`. Only `guestImage.sourceFingerprint`, `pythonPackageVersion`, `dockerArchiveSha256`, and `composeSha256` were set to the table values and Python `3.11.2-1+b1`. `guestImage.fingerprint` remains null. The revised builder checks these exact pins, alias `ezharness-guest-0-1-0`, storage pool `ezharness-btrfs`, and default-project bridge `ezharness0`. The local Docker archive passes `tar -tzf`; its `docker` and `dockerd` report 29.8.1, and the Compose binary reports v5.5.1. The downloaded Bookworm package index still hashes to `9e0b5aabb2465b3d2e7a7fe27f9913846277833f7a2826e7767acccff5b588c5`. The actual `apt-get update` and exact Python install in the guest remain untested.

## Build dependency found before any write

Read-only `incus profile show default --project default` returned `devices: {}`. Read-only `incus storage list --format json` returned `[]`; `docker0` is an unmanaged host bridge. The earlier builder launched the base fingerprint in the default project without `--storage` or `--network`. Incus has [no implicit default storage pool](https://linuxcontainers.org/incus/docs/main/explanation/storage/), so that launch had no root pool. Even with a pool, this empty profile provides no NIC for the builder's `apt-get update`. Incus documents [`--storage` and `--network`](https://linuxcontainers.org/incus/docs/main/howto/instances_create/) for selecting both on a new instance; the server's 6.0.6 `incus launch --help` exposes these flags.

The exact setup pool and bridge must be pre-created as separately reviewed manual steps, because `createSetupPlan` stays blocked until a published image exists and cannot apply its own storage and network steps first. Use the planner's exact resource configuration, not a temporary or unrelated pool/bridge:

```sh
incus storage create ezharness-btrfs btrfs size=100GiB volume.size=20GiB
incus network create ezharness0 --project=default --type=bridge \
  dns.domain=sandbox.internal dns.mode=managed ipv4.address=10.173.0.1/24 \
  ipv4.nat=true ipv6.address=none
```

Run these only after a fresh read-only inventory confirms that the names remain absent, the CIDR does not overlap another route, the Btrfs driver and root capacity still meet the recipe, and the two exact commands have approval. The pool creation is the **first Incus configuration write**. Read `incus storage show ezharness-btrfs`, `incus network show ezharness0 --project default`, and a fresh inventory afterward. Confirm that the pool has `size=100GiB` and `volume.size=20GiB`, and the managed bridge has exactly the recipe's persistent config. Stop on drift or a missing NAT route. The planner compares pre-existing owned resources to the recipe and its eventual apply skips a matching step; extra persistent network config or a mismatched pool blocks it. Its capacity check accounts for the already-created 100 GiB pool.

The revised builder at `a07761cad` changes its launch line to:

```sh
incus launch "$base_fingerprint" "$name" --project default \
  --storage ezharness-btrfs --network ezharness0
```

The committed script was copied to the table's staged path, rehashed, and passed `bash -n`. The parent code pass also reports 16 focused setup tests, typecheck, and lint passing for this change. The guest must show a root disk on `ezharness-btrfs`, an `ezharness0` NIC, outbound DNS and package access, and no unexpected resource before the exact Python install. Those live observations remain untested. A successful build must leave no temporary instance after the builder's exit trap. Do not add a root disk or NIC to the shared default profile as a shortcut.

## Proposed transfer path and first write

Run these commands from this worktree only after the seven source files, host state, pool and bridge commands, and path are approved. The new directory `/home/dev/ezh-incus-image-20260923` is the controlled server staging path. **The `install -d` command below is the first server write** in the proposed order: stage and rehash, create and verify the pool and bridge, import and verify the base, then build. The host has enough reported free space for the 230 MB transfer and the planned 100 GiB pool, but repeat `df` before it. Keep the staged directory private and rehash every file on the server before import.

```sh
ssh -F /dev/null -i /home/dev/.ssh/id_ed25519_personal \
  -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o GlobalKnownHostsFile=/dev/null -o UpdateHostKeys=no \
  -o UserKnownHostsFile=/home/dev/.ssh/known_hosts \
  dev@sandbox-server.taile1c5b0.ts.net \
  'install -d -m 0700 /home/dev/ezh-incus-image-20260923'

scp -O -F /dev/null -i /home/dev/.ssh/id_ed25519_personal \
  -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o GlobalKnownHostsFile=/dev/null -o UpdateHostKeys=no \
  -o UserKnownHostsFile=/home/dev/.ssh/known_hosts \
  /tmp/ezh-incus-image-inputs-20260923/incus.tar.xz \
  /tmp/ezh-incus-image-inputs-20260923/rootfs.squashfs \
  /tmp/ezh-incus-image-inputs-20260923/docker-29.8.1.tgz \
  /tmp/ezh-incus-image-inputs-20260923/docker-compose-linux-x86_64 \
  src/infrastructure/incus-guest/helper.py \
  /tmp/ezh-incus-image-inputs-20260923/build-guest-image.sh \
  /tmp/ezh-incus-image-inputs-20260923/candidate-recipe.json \
  dev@sandbox-server.taile1c5b0.ts.net:/home/dev/ezh-incus-image-20260923/
```

After transfer, run `sha256sum /home/dev/ezh-incus-image-20260923/{incus.tar.xz,rootfs.squashfs,docker-29.8.1.tgz,docker-compose-linux-x86_64,helper.py,build-guest-image.sh,candidate-recipe.json}` over the same pinned SSH connection and compare all seven rows above. After the reviewed pool and bridge exist and match the recipe, import the base from this exact path:

```sh
incus image import /home/dev/ezh-incus-image-20260923/incus.tar.xz \
  /home/dev/ezh-incus-image-20260923/rootfs.squashfs \
  --alias ezh-base-20260923 --project default
```

That import is a separate server mutation after transfer and hash review. Confirm that `incus image info 7ccaa583b060cfec673f96fa9acd52d153a35a8090d68be4cd946280f4b61907 --project default` resolves before running the builder. The exact builder command and later digest-gated setup sequence are in the [server apply plan](2026-09-23-incus-server-apply-plan.md). Its first guest launch is still a separate write. Do not substitute the moving Debian alias or change a package version during the build.

## Open gates

The reviewed-image gate is **not complete**. The exact pool and bridge pre-creation needs review. No base import, image build, published fingerprint, helper check inside a live guest, or nested Compose qualification exists. The recipe and setup plan are blocked. The operator still needs to approve the final files, resource commands, and transfer path before the first server write, then review the published fingerprint and a fresh engine-generated setup plan digest before any setup apply. Live guest qualification remains separate.
