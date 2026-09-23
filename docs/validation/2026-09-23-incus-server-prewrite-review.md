# Incus image transfer and first-write review packet — 2026-09-23

This packet records the image portion of the [server apply plan](2026-09-23-incus-server-apply-plan.md) for `dev@sandbox-server.taile1c5b0.ts.net`. The private stage and seven verified input files now exist on the server, the exact Debian base image has been imported, and the digest-approved bootstrap created the recipe pool and bridge. Its apply receipt passed. The first `bootstrap-verify` returned `bootstrap_plan_drift`; after source fix `5d5006763`, an integrated read-only verification passed. The first guest build then failed because the guest had no IPv4 address and could not resolve Debian package hosts. Its temporary guest was cleaned; no guest image was published. A NixOS firewall bridge-name change is proposed below for separate review. The checked-in recipe still has null source, runtime, and published-image pins. The revised builder from source commit `a07761cad` uses explicit storage and network flags. The provider client certificate and full setup plan digest do not exist yet.

## Read-only evidence before the first write

Strict, noninteractive SSH succeeded with `/home/dev/.ssh/id_ed25519_personal` and `/home/dev/.ssh/known_hosts`. The matching ED25519 host-key fingerprint is `SHA256:a3VHX02pT5agIluq6K12E9oCuTg09ErbQ5wK9Vvk8Co`. The private key was not read or copied. Before staging, fixed read-only SSH commands reported:

| Check | 2026-09-23 observation |
| --- | --- |
| Host and Incus | `sandbox-server`, x86_64, Incus client/server 6.0.6, active service |
| Host readiness | NTP synchronized, cgroup v2, nftables, Btrfs driver available, 214,412,595,200 root-free bytes at `2026-09-23T17:41:09Z` |
| Pins | Server certificate `c8d6afdbaa6b1dc094f9b8b8dcc949861aca21c98b1d736cee981a8cb107a7d1`; address `100.81.181.39` present; all recipe-required API extensions present |
| Existing Incus state | Only the `default` project and profile; the default profile has `devices: {}`; no storage pool, managed Incus bridge, instance, trust entry, or default-project image; no route starting `10.173.`; no HTTPS listener |
| Transfer prerequisites | `/home/dev` is writable by `dev`; proposed stage path does not exist; server has `scp`, `sha256sum`, `tar`, `python3`, and `bash`; local `scp -O` is supported |

This is a point-in-time observation. Repeat the inventory immediately before the first write. After `bun install --frozen-lockfile` restored this worktree's dependencies, Bun 1.3.14 ran the repository `cli.ts inspect` and pure full `plan` successfully. Private mode-0600 outputs are under `/tmp/ezh-incus-readonly-20260923.1zPJhf/`. The full plan status is `blocked`, with `guest_image_artifact_unpinned` and `provider_client_certificate_missing`. Its digest `6ddd5c3445f987c77aa9278e54b47ac1784e617ab4500cd98919233a66640ffb` is only the **blocked full plan**, not a digest to approve or apply. Fixed read-only SSH commands independently gave the same server facts.

## Completed approved subset and current server facts

After a fresh inspection at `2026-09-23T18:02:43Z`, the approved staging subset created `/home/dev/ezh-incus-image-20260923` with mode `0700`, transferred the base metadata/root, Docker archive, Compose binary, helper, and candidate recipe, and rehashed all six files on the server. Each server hash matches its row below. The six transferred files total 229,888,339 bytes. The revised builder was **not** transferred.

The exact split base was imported in the default project. Independent read-only SSH after import found fingerprint `7ccaa583b060cfec673f96fa9acd52d153a35a8090d68be4cd946280f4b61907` with alias `ezh-base-20260923`; `incus image info` reports a private x86_64 container, Debian Bookworm default build `20260923_05:24`, with auto-update disabled. After the approved bootstrap apply, independent read-only SSH found the `ezharness-btrfs` Btrfs pool in `Created` state with `size=100GiB` and `volume.size=20GiB`, and the managed `ezharness0` bridge in `Created` state with the exact recipe DNS/NAT/CIDR config. There are no instances. No full setup apply occurred.

## Exact local files for review

The split base and runtime files are present under `/tmp/ezh-incus-image-inputs-20260923`. Their hashes were measured again in this pass. The base's metadata bytes followed by root bytes hash to `7ccaa583b060cfec673f96fa9acd52d153a35a8090d68be4cd946280f4b61907`, matching the remote Debian 12 amd64 default build `20260923_05:24` recorded in the [candidate input record](2026-09-23-incus-image-inputs.md). All seven proposed files, including the pending revised builder, total 229,893,575 bytes.

| Transfer name | Source | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `incus.tar.xz` | `/tmp/ezh-incus-image-inputs-20260923/incus.tar.xz` | 672 | `ef5a700d30426a2e237499a887f77f59b7527b66f98af8d4207354fb54d7a76a` |
| `rootfs.squashfs` | `/tmp/ezh-incus-image-inputs-20260923/rootfs.squashfs` | 111,468,544 | `5f22057b045cffc162824bae27f4a0df2457aed7bb274a903d4b0f411631b973` |
| `docker-29.8.1.tgz` | `/tmp/ezh-incus-image-inputs-20260923/docker-29.8.1.tgz` | 86,055,881 | `d8db66739d2e28d4933786d73e918d9be643a67fbd835db1bf740d650a259e70` |
| `docker-compose-linux-x86_64` | `/tmp/ezh-incus-image-inputs-20260923/docker-compose-linux-x86_64` | 32,333,754 | `db1889184726840f75c4f9c001048430d4f25b3be3cb084d3ddd762bc0aed576` |
| `helper.py` | `src/infrastructure/incus-guest/helper.py` | 26,038 | `804d68bd8d83ca817c6413eb3b2365216778aa26421c81fb3e9f3810b82dcb75` |
| `build-guest-image.sh` — transferred after bootstrap verification | `/tmp/ezh-incus-image-inputs-20260923/build-guest-image.sh`, copied byte-for-byte from commit `a07761cad` | 5,236 | `716e5d7bd23d76c2a0a0dd40dba13d762a5fcde05aa2775c538ad6b10a7b448d` |
| `candidate-recipe.json` | `/tmp/ezh-incus-image-inputs-20260923/candidate-recipe.json` | 3,450 | `e9ce73a3da2fd81aa6662168fe83aff607fdfa2b813951f4e9ed186ee76fde42` |

The candidate recipe is a local copy of `scripts/incus/recipe.json`. Only `guestImage.sourceFingerprint`, `pythonPackageVersion`, `dockerArchiveSha256`, and `composeSha256` were set to the table values and Python `3.11.2-1+b1`. `guestImage.fingerprint` remains null. The revised builder checks these exact pins, alias `ezharness-guest-0-1-0`, storage pool `ezharness-btrfs`, and default-project bridge `ezharness0`. The local Docker archive passes `tar -tzf`; its `docker` and `dockerd` report 29.8.1, and the Compose binary reports v5.5.1. The downloaded Bookworm package index still hashes to `9e0b5aabb2465b3d2e7a7fe27f9913846277833f7a2826e7767acccff5b588c5`. The actual `apt-get update` and exact Python install in the guest remain untested.

## Build dependency found before any write

Read-only `incus profile show default --project default` returned `devices: {}`. Read-only `incus storage list --format json` returned `[]`; `docker0` is an unmanaged host bridge. The earlier builder launched the base fingerprint in the default project without `--storage` or `--network`. Incus has [no implicit default storage pool](https://linuxcontainers.org/incus/docs/main/explanation/storage/), so that launch had no root pool. Even with a pool, this empty profile provides no NIC for the builder's `apt-get update`. Incus documents [`--storage` and `--network`](https://linuxcontainers.org/incus/docs/main/howto/instances_create/) for selecting both on a new instance; the server's 6.0.6 `incus launch --help` exposes these flags.

The exact setup pool and bridge must be pre-created, because `createSetupPlan` stays blocked until a published image exists and cannot apply its own storage and network steps first. Source commit `ea9c14a08`, integrated as `f11998212`, adds a separate digest-reviewed `bootstrap-plan`, `bootstrap-apply`, and `bootstrap-verify` path for only these two resources. The saved plan contains these effects; **the raw commands are shown for review, not direct execution**:

```sh
incus storage create ezharness-btrfs btrfs size=100GiB volume.size=20GiB
incus network create ezharness0 --project=default --type=bridge \
  dns.domain=sandbox.internal dns.mode=managed ipv4.address=10.173.0.1/24 \
  ipv4.nat=true ipv6.address=none
```

The bootstrap CLI's fresh read-only inventory must confirm that the names remain absent, the CIDR does not overlap another route, and the Btrfs driver and root capacity still meet the recipe. The first pre-base bootstrap digest `a830a41b4f7ec20119f78cd2359b7fa3f37b9fa6dd5f93129525c300eeafed46` is historical; importing the base changed the inventory. Source fix `6acd9af2b` also makes the plan record whether either target was present when reviewed, so a later matching resource cannot silently count as the approved action.

After the base import, a fresh private inventory at `2026-09-23T18:04:27.244Z` and the fixed bootstrap planner returned `status: ready`, no blocked reasons, and digest `25a2c72c1adf312d6f212bc1de5ec118afd0c68353d644595ea4a41061c333c5`. The two steps are exactly `storage-pool` and `managed-network`; both target-presence values were false. The dry run returned `state: dry_run`, with both actions `planned` from `absent`. That exact digest was subsequently approved and applied. Mode-0600 plan and receipts are under `/tmp/ezh-incus-bootstrap-review-20260923.XUcCYG/postbase-*`.

Generate a fresh bootstrap plan from a new private directory outside Git on the EZHarness engine host. The commands through the dry run are read-only on the server. Review the resulting `status`, both commands and expected readbacks, any blocked reasons, and the **new saved `planDigest`**. The recipe for this bootstrap is the checked-in `scripts/incus/recipe.json`; its null image and certificate pins are allowed for this limited plan.

```sh
EZH_INCUS_BUN=/home/dev/.bun/bin/bun
EZH_INCUS_SETUP_DIR=$(mktemp -d /tmp/ezh-incus-bootstrap.XXXXXX)
install -m 600 scripts/incus/connection.example.json "$EZH_INCUS_SETUP_DIR/connection.json"
"$EZH_INCUS_BUN" scripts/incus/cli.ts inspect \
  --connection "$EZH_INCUS_SETUP_DIR/connection.json" \
  --out "$EZH_INCUS_SETUP_DIR/inventory.json"
"$EZH_INCUS_BUN" scripts/incus/cli.ts bootstrap-plan \
  --recipe scripts/incus/recipe.json \
  --inventory "$EZH_INCUS_SETUP_DIR/inventory.json" \
  --out "$EZH_INCUS_SETUP_DIR/bootstrap-plan.json"
"$EZH_INCUS_BUN" scripts/incus/cli.ts bootstrap-apply \
  --recipe scripts/incus/recipe.json \
  --plan "$EZH_INCUS_SETUP_DIR/bootstrap-plan.json" \
  --connection "$EZH_INCUS_SETUP_DIR/connection.json" \
  --out "$EZH_INCUS_SETUP_DIR/dry-run.json"
```

The pool creation is the **first Incus configuration write**. The bootstrap apply reinspects before each planned effect and reads it back afterward; an uncertain result requires inspection and reconciliation of the same saved plan. The full setup planner later recognizes exact existing resources and skips matching steps. A drifted pool, extra persistent bridge config, or a conflicting route blocks it. Its capacity check accounts for the already-created 100 GiB pool.

The revised builder at `a07761cad` changes its launch line to:

```sh
incus launch "$base_fingerprint" "$name" --project default \
  --storage ezharness-btrfs --network ezharness0
```

The committed script was copied to the table's staged path, rehashed, and passed `bash -n`. The parent code pass also reports 16 focused setup tests, typecheck, and lint passing for this change. The guest must show a root disk on `ezharness-btrfs`, an `ezharness0` NIC, outbound DNS and package access, and no unexpected resource before the exact Python install. Those live observations remain untested. A successful build must leave no temporary instance after the builder's exit trap. Do not add a root disk or NIC to the shared default profile as a shortcut.

## Completed staging and base import

The first server write created `/home/dev/ezh-incus-image-20260923` with mode `0700`. The six transferred files and hashes are recorded above. The exact import command was:

```sh
incus image import /home/dev/ezh-incus-image-20260923/incus.tar.xz \
  /home/dev/ezh-incus-image-20260923/rootfs.squashfs \
  --alias ezh-base-20260923 --project default
```

That import is complete and must not be replayed. Read-only `incus image info 7ccaa583b060cfec673f96fa9acd52d153a35a8090d68be4cd946280f4b61907 --project default` resolves. The imported image does not satisfy the guest-image gate; it is only the builder's exact base.

## Applied bootstrap; verification still open

The saved post-base bootstrap plan at `/tmp/ezh-incus-bootstrap-review-20260923.XUcCYG/postbase-bootstrap-plan.json` has digest `25a2c72c1adf312d6f212bc1de5ec118afd0c68353d644595ea4a41061c333c5` and approved target state of two absent resources. The source fix `6acd9af2b` required those targets to remain absent before execution. The exact approved command below **has run once**; do not replay it. The saved receipt `/tmp/ezh-incus-bootstrap-review-20260923.XUcCYG/postbase-apply-receipt.json` reports `state: applied`: both `storage-pool` and `managed-network` went from `absent` to `executed`, exited 0, and passed per-step readback.

```sh
/home/dev/.bun/bin/bun scripts/incus/cli.ts bootstrap-apply --execute \
  --approved-plan-digest 25a2c72c1adf312d6f212bc1de5ec118afd0c68353d644595ea4a41061c333c5 \
  --recipe scripts/incus/recipe.json \
  --plan /tmp/ezh-incus-bootstrap-review-20260923.XUcCYG/postbase-bootstrap-plan.json \
  --connection /tmp/ezh-incus-bootstrap-review-20260923.XUcCYG/connection.json \
  --out /tmp/ezh-incus-bootstrap-review-20260923.XUcCYG/postbase-apply-receipt.json
/home/dev/.bun/bin/bun scripts/incus/cli.ts bootstrap-verify \
  --recipe scripts/incus/recipe.json \
  --plan /tmp/ezh-incus-bootstrap-review-20260923.XUcCYG/postbase-bootstrap-plan.json \
  --connection /tmp/ezh-incus-bootstrap-review-20260923.XUcCYG/connection.json \
  --out /tmp/ezh-incus-bootstrap-review-20260923.XUcCYG/postbase-verification.json
```

The first `bootstrap-verify` wrote `/tmp/ezh-incus-bootstrap-review-20260923.XUcCYG/postbase-verification.json` and exited 1 with `ready: false` and `failures: ["bootstrap_plan_drift"]`, despite both resources matching the planned configuration in read-only Incus output. Source fix `5d5006763` corrected the plan normalization. Integrated read-only `bootstrap-verify` at `2026-09-23T18:22:51.238Z` wrote `/tmp/ezh-incus-bootstrap-review-20260923.XUcCYG/verification-fixed-root.json` with `ready: true`, `failures: []`, and the same approved digest. Its inventory reads back the exact pool and managed bridge. The failed first verification remains part of the record; no apply was repeated. Do not run the raw pool or bridge commands above.

The approved revised builder was transferred to the existing private server directory after bootstrap verification. Independent read-only SSH confirmed its server-side SHA-256 is `716e5d7bd23d76c2a0a0dd40dba13d762a5fcde05aa2775c538ad6b10a7b448d`. The exact builder command and later digest-gated full setup sequence are in the [server apply plan](2026-09-23-incus-server-apply-plan.md). The guest must use the verified pool and bridge; do not substitute a moving Debian alias or change a package version during the build. The command below records the transfer path already used; do not replay it.

```sh
scp -O -F /dev/null -i /home/dev/.ssh/id_ed25519_personal \
  -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o GlobalKnownHostsFile=/dev/null -o UpdateHostKeys=no \
  -o UserKnownHostsFile=/home/dev/.ssh/known_hosts \
  /tmp/ezh-incus-image-inputs-20260923/build-guest-image.sh \
  dev@sandbox-server.taile1c5b0.ts.net:/home/dev/ezh-incus-image-20260923/
ssh -F /dev/null -i /home/dev/.ssh/id_ed25519_personal \
  -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o GlobalKnownHostsFile=/dev/null -o UpdateHostKeys=no \
  -o UserKnownHostsFile=/home/dev/.ssh/known_hosts \
  dev@sandbox-server.taile1c5b0.ts.net \
  'sha256sum /home/dev/ezh-incus-image-20260923/build-guest-image.sh'
```

## Failed first guest build and proposed host correction

The first run of the approved builder exited `100`; local log `/tmp/ezh-incus-guest-build-20260923.log` records `Temporary failure resolving 'deb.debian.org'` during `apt-get update` and the exact Python install. The builder launched its temporary guest and pushed the three inputs before this failure. A separate live diagnostic guest reached running systemd but, after eight seconds, `eth0` had only a link-local IPv6 address, no IPv4 address, and zero received packets. Both temporary guests were cleaned. Read-only Incus inspection found no instances and only the imported Debian base image; alias `ezharness-guest-0-1-0` was not published.

The host-side evidence points to a DHCP/DNS firewall mismatch. At NixOS source HEAD `71be0630893b82be3084b1014774668db9110520`, the `sandbox-server` block in `/home/dev/work/nixos/flake.nix` enables `my.incus` but does not set `bridgeName`. The module in `/home/dev/work/nixos/modules/incus.nix` defaults that option to `incusbr0` and uses it for per-interface TCP 53 and UDP 53/67 input permits. Read-only Nix evaluation returned `incusbr0`, and the active nft input rules permit those ports on `incusbr0`, while the approved managed bridge is `ezharness0`. The host itself resolves `deb.debian.org`. The proposed one-line source change, directly after `my.incus.enable = true;` in the `sandbox-server` extra module, is:

```diff
           my.incus.enable = true;
+          my.incus.bridgeName = "ezharness0";
           my.devContainer.enable = true;
```

This source change and any host activation are **separate, unapproved work**. The NixOS checkout has unrelated local edits, so prepare a clean, reviewed source revision containing only this line. Check that `nix eval --raw /home/dev/work/nixos#nixosConfigurations.sandbox-server.config.my.incus.bridgeName` returns `ezharness0`. On the server, `sudo nixos-rebuild test --flake /home/dev/work/nixos#sandbox-server` would change the live firewall for a temporary trial; read back its exact nft input permits and retest DHCP/DNS in a disposable guest before a separately reviewed `sudo nixos-rebuild switch --flake /home/dev/work/nixos#sandbox-server` makes the change persistent. Neither rebuild command nor a new guest test was run for this packet. Do not rerun the builder until host networking is qualified, then use the same pinned artifacts and record the new build outcome.

## Open gates

The reviewed-image gate is **not complete**. The base image is imported; the bootstrap pool and bridge have a passing apply receipt and verification; and the revised builder is transferred with the expected hash. The first build failed on guest networking. A reviewed host firewall correction, passing DHCP/DNS guest proof, successful image build, published fingerprint, helper check inside a live guest, and nested Compose qualification remain open. The full setup plan is blocked. After a guest image is published, review its fingerprint and a fresh engine-generated full setup plan digest before any full setup apply. Live guest qualification remains separate.
