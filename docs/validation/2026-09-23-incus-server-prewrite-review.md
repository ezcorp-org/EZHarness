# Incus image transfer and first-write review packet — 2026-09-23

This packet makes the image portion of the [server apply plan](2026-09-23-incus-server-apply-plan.md) concrete for `dev@sandbox-server.taile1c5b0.ts.net`. It is a proposal for review. No server directory was created, no file was transferred, and no image was imported, built, or published during this pass. The checked-in recipe still has null source, runtime, and published-image pins. The separate setup plan digest and provider client certificate do not exist yet.

## Read-only evidence taken again

Strict, noninteractive SSH succeeded with `/home/dev/.ssh/id_ed25519_personal` and `/home/dev/.ssh/known_hosts`. The matching ED25519 host-key fingerprint is `SHA256:a3VHX02pT5agIluq6K12E9oCuTg09ErbQ5wK9Vvk8Co`. The private key was not read or copied. Fixed read-only SSH commands reported:

| Check | 2026-09-23 observation |
| --- | --- |
| Host and Incus | `sandbox-server`, x86_64, Incus client/server 6.0.6, active service |
| Host readiness | NTP synchronized, cgroup v2, nftables, Btrfs driver available, 214,412,595,200 root-free bytes at `2026-09-23T17:41:09Z` |
| Pins | Server certificate `c8d6afdbaa6b1dc094f9b8b8dcc949861aca21c98b1d736cee981a8cb107a7d1`; address `100.81.181.39` present; all recipe-required API extensions present |
| Existing Incus state | Only the `default` project and profile; no storage pool, instance, trust entry, or default-project image; no route starting `10.173.`; no HTTPS listener |
| Transfer prerequisites | `/home/dev` is writable by `dev`; proposed stage path does not exist; server has `scp`, `sha256sum`, `tar`, `python3`, and `bash`; local `scp -O` is supported |

This is a point-in-time observation. Repeat the inventory immediately before the first write. After `bun install --frozen-lockfile` restored this worktree's dependencies, Bun 1.3.14 ran the repository `cli.ts inspect` and pure `plan` successfully. Private mode-0600 outputs are under `/tmp/ezh-incus-readonly-20260923.1zPJhf/`. The plan status is `blocked`, with `guest_image_artifact_unpinned` and `provider_client_certificate_missing`. Its digest `6ddd5c3445f987c77aa9278e54b47ac1784e617ab4500cd98919233a66640ffb` is only the **blocked initial plan**, not a digest to approve or apply. Fixed read-only SSH commands independently gave the same server facts.

## Exact local files for review

The split base and runtime files are present under `/tmp/ezh-incus-image-inputs-20260923`. Their hashes were measured again in this pass. The base's metadata bytes followed by root bytes hash to `7ccaa583b060cfec673f96fa9acd52d153a35a8090d68be4cd946280f4b61907`, matching the remote Debian 12 amd64 default build `20260923_05:24` recorded in the [candidate input record](2026-09-23-incus-image-inputs.md). The staged transfer totals 229,893,006 bytes.

| Transfer name | Source | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `incus.tar.xz` | `/tmp/ezh-incus-image-inputs-20260923/incus.tar.xz` | 672 | `ef5a700d30426a2e237499a887f77f59b7527b66f98af8d4207354fb54d7a76a` |
| `rootfs.squashfs` | `/tmp/ezh-incus-image-inputs-20260923/rootfs.squashfs` | 111,468,544 | `5f22057b045cffc162824bae27f4a0df2457aed7bb274a903d4b0f411631b973` |
| `docker-29.8.1.tgz` | `/tmp/ezh-incus-image-inputs-20260923/docker-29.8.1.tgz` | 86,055,881 | `d8db66739d2e28d4933786d73e918d9be643a67fbd835db1bf740d650a259e70` |
| `docker-compose-linux-x86_64` | `/tmp/ezh-incus-image-inputs-20260923/docker-compose-linux-x86_64` | 32,333,754 | `db1889184726840f75c4f9c001048430d4f25b3be3cb084d3ddd762bc0aed576` |
| `helper.py` | `src/infrastructure/incus-guest/helper.py` | 26,038 | `804d68bd8d83ca817c6413eb3b2365216778aa26421c81fb3e9f3810b82dcb75` |
| `build-guest-image.sh` | `scripts/incus/build-guest-image.sh` | 4,667 | `4cf4e3b4e3a579b079a8735219653855e6825d3f590e3fa2c9f7b630ad3c6d01` |
| `candidate-recipe.json` | `/tmp/ezh-incus-image-inputs-20260923/candidate-recipe.json` | 3,450 | `e9ce73a3da2fd81aa6662168fe83aff607fdfa2b813951f4e9ed186ee76fde42` |

The candidate recipe is a local copy of `scripts/incus/recipe.json`. Only `guestImage.sourceFingerprint`, `pythonPackageVersion`, `dockerArchiveSha256`, and `composeSha256` were set to the table values and Python `3.11.2-1+b1`. `guestImage.fingerprint` remains null. The current builder accepts these exact pins and alias `ezharness-guest-0-1-0`. The local Docker archive passes `tar -tzf`; its `docker` and `dockerd` report 29.8.1, and the Compose binary reports v5.5.1. The downloaded Bookworm package index still hashes to `9e0b5aabb2465b3d2e7a7fe27f9913846277833f7a2826e7767acccff5b588c5`. The actual `apt-get update` and exact Python install in the guest remain untested.

## Proposed transfer path and first write

Run these commands from this worktree only after the seven source hashes, host state, and path are approved. The new directory `/home/dev/ezh-incus-image-20260923` is the controlled server staging path. **The `install -d` command below is the first server write.** The host has enough reported free space for the 230 MB transfer and the planned 100 GiB pool, but repeat `df` before it. Keep the staged directory private and rehash every file on the server before import.

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
  scripts/incus/build-guest-image.sh \
  /tmp/ezh-incus-image-inputs-20260923/candidate-recipe.json \
  dev@sandbox-server.taile1c5b0.ts.net:/home/dev/ezh-incus-image-20260923/
```

After transfer, run `sha256sum /home/dev/ezh-incus-image-20260923/{incus.tar.xz,rootfs.squashfs,docker-29.8.1.tgz,docker-compose-linux-x86_64,helper.py,build-guest-image.sh,candidate-recipe.json}` over the same pinned SSH connection and compare all seven rows above. The import command in the reviewed plan uses `/approved/` as a placeholder. For this exact proposed path it becomes:

```sh
incus image import /home/dev/ezh-incus-image-20260923/incus.tar.xz \
  /home/dev/ezh-incus-image-20260923/rootfs.squashfs \
  --alias ezh-base-20260923 --project default
```

That import is a separate server mutation after transfer and hash review. Confirm that `incus image info 7ccaa583b060cfec673f96fa9acd52d153a35a8090d68be4cd946280f4b61907 --project default` resolves before running the builder. The exact builder command and later digest-gated setup sequence are in the [server apply plan](2026-09-23-incus-server-apply-plan.md). Its first guest launch is still a separate write. Do not substitute the moving Debian alias or change a package version during the build.

## Open gates

The reviewed-image gate is **not complete**. No base import, image build, published fingerprint, helper check inside a live guest, or nested Compose qualification exists. The recipe and setup plan are blocked. The operator still needs to approve these exact files and this transfer path before the first server write, then review the published fingerprint and a fresh engine-generated setup plan digest before any setup apply. Live guest qualification remains separate.
