# Incus server apply plan — review copy, 2026-09-23

This plan targets only `dev@sandbox-server.taile1c5b0.ts.net`. It records the remaining proposed sequence and completed server work. The exact Debian base was imported, and the digest-approved bootstrap created the exact pool and bridge. Its read-only verification passed after source fix `5d5006763`. The first guest build failed on DHCP/DNS; the approved one-line NixOS firewall fix was tested and switched persistently, and a disposable guest proved DHCP/DNS. The faulty second image was removed. The third build published fingerprint `57c0d028e4456a3847fb9822802d6a8f613ba4e6ef03002999e8c957a1f40c6c`; disposable guests passed helper, Docker, identity-uniqueness, and nested Compose checks. The builder still exited 1 on publish-message parsing, and a separate image edit set finite expiry `2099-12-31T00:00:00Z`. See the [current packet](2026-09-23-incus-server-prewrite-review.md). No full setup apply has occurred. The checked-in [recipe](../../scripts/incus/recipe.json) still has `null` base, runtime, and published guest-image pins. Its provider client certificate is also absent. The full setup planner must therefore remain blocked until those inputs are reviewed and present. Repeat inspection before any further write.

## 1. Read-only prechecks

Run from the repository root on the EZHarness engine host. Set `EZH_INCUS_BUN` to the absolute path of Bun 1.3.14 and verify `"$EZH_INCUS_BUN" --version` prints `1.3.14`. Set `EZH_INCUS_SETUP_DIR` to an absolute directory outside Git, create it with mode `0700`, and keep its receipts. Make a private copy of [connection.example.json](../../scripts/incus/connection.example.json) there as `connection.json`. Verify that its target is exactly `dev@sandbox-server.taile1c5b0.ts.net`, its host-key pin is `SHA256:a3VHX02pT5agIluq6K12E9oCuTg09ErbQ5wK9Vvk8Co`, and its absolute identity and dedicated `known_hosts` paths exist and are available to the engine service account. The example paths are not proof that credentials are installed. The inspector checks every accepted host key in that file before SSH. Do not copy a private key into the repository.

```sh
"$EZH_INCUS_BUN" scripts/incus/cli.ts inspect --connection "$EZH_INCUS_SETUP_DIR/connection.json" --out "$EZH_INCUS_SETUP_DIR/initial-inventory.json"
"$EZH_INCUS_BUN" scripts/incus/cli.ts plan --recipe scripts/incus/recipe.json --inventory "$EZH_INCUS_SETUP_DIR/initial-inventory.json" --out "$EZH_INCUS_SETUP_DIR/initial-plan.json"
```

The output files must be new private paths: the CLI writes them with mode `0600` and refuses to overwrite them. Review the inventory and `blockedReasons`; do not use a stale inventory. Confirm the hostname, SSH host key, Incus server certificate fingerprint `c8d6afdbaa6b1dc094f9b8b8dcc949861aca21c98b1d736cee981a8cb107a7d1`, x86_64 architecture, Incus 6.0.6, NTP, cgroup v2, nftables, Btrfs support, root free space, address `100.81.181.39`, route non-overlap with `10.173.0.1/24`, empty guest/trust inventory, and absence or exact match of each owned resource. The planner enforces these checks. The base fingerprint now resolves locally after the approved import; verify it again before the builder launch.

## 2. Review and approve the image inputs

The [candidate manifest](2026-09-23-incus-image-inputs.md) identifies Debian 12 amd64 default build `20260923_05:24`, base fingerprint `7ccaa583b060cfec673f96fa9acd52d153a35a8090d68be4cd946280f4b61907`, Python `3.11.2-1+b1`, Docker static `docker-29.8.1.tgz`, Compose v5.5.1, and the current helper source. These reviewed inputs are not yet checked-in recipe pins. Six input files and builder revision `91fb13898` were approved, staged, and verified on the server. Its SHA-256 is `94492fa4b8be8fc16fa84460de26ffd8ca51e99a870fad0149a6c884bcfe93a0`. Follow-up builder commit `ba4998e9c` is repo-only, SHA-256 `35512f9cfb55ce4ca342b3117500f3b0f77fe8a2f210fda47f95a5adf2f39015`; it has not been transferred or live-tested. Recheck the staged files and inspect the server before the next write. Do not substitute a moving base alias.

The read-only follow-up in the [prewrite packet](2026-09-23-incus-server-prewrite-review.md) found that the server originally had no storage pool and its default profile had no root disk or NIC. The builder's first guest requires the reviewed `ezharness-btrfs` pool and managed `ezharness0` NAT bridge. The full setup planner could not create them first because it stays blocked until the published image exists, so the separate digest-reviewed bootstrap applied exactly those two steps. Its receipt is `applied`, and the fixed read-only `bootstrap-verify` now reports `ready: true` with no failures. Do not run the old builder with an unqualified default-profile launch.

The approved split-base import into the **default** project is complete. Its server-side command was:

```sh
incus image import /home/dev/ezh-incus-image-20260923/incus.tar.xz \
  /home/dev/ezh-incus-image-20260923/rootfs.squashfs \
  --alias ezh-base-20260923 --project default
```

The transferred metadata SHA-256 `ef5a700d30426a2e237499a887f77f59b7527b66f98af8d4207354fb54d7a76a` and root SHA-256 `5f22057b045cffc162824bae27f4a0df2457aed7bb274a903d4b0f411631b973` matched before import. After it, read-only `incus image info 7ccaa583b060cfec673f96fa9acd52d153a35a8090d68be4cd946280f4b61907 --project default` resolved the exact Debian build and alias. Do not infer the published guest fingerprint from these hashes.

The staged candidate recipe sets `guestImage.sourceFingerprint`, `pythonPackageVersion`, `dockerArchiveSha256`, and `composeSha256` to the reviewed inputs and keeps `guestImage.fingerprint` null. Its hash and the helper hash match the packet. The bootstrap receipt, passing verification, host firewall activation, and disposable-guest DHCP/DNS proof are recorded there. The bad second image was deleted, and the third build published the content-qualified fingerprint `57c0d028e4456a3847fb9822802d6a8f613ba4e6ef03002999e8c957a1f40c6c` with alias `ezharness-guest-0-1-0`. Do not rerun the builder against this alias. The third build used this command from the server staging directory:

```sh
bash build-guest-image.sh candidate-recipe.json \
  7ccaa583b060cfec673f96fa9acd52d153a35a8090d68be4cd946280f4b61907 \
  3.11.2-1+b1 docker-29.8.1.tgz \
  d8db66739d2e28d4933786d73e918d9be643a67fbd835db1bf740d650a259e70 \
  docker-compose-linux-x86_64 \
  db1889184726840f75c4f9c001048430d4f25b3be3cb084d3ddd762bc0aed576 \
  helper.py 804d68bd8d83ca817c6413eb3b2365216778aa26421c81fb3e9f3810b82dcb75 \
  ezharness-guest-0-1-0
```

The third build verified file hashes, launched a temporary guest with the reviewed pool and bridge, installed pinned Python, Docker, Compose, helper, `iptables`, and `nftables`, checked Docker readiness, and published the image. It exited 1 because it parsed stdout for the human `incus publish` fingerprint message, which this Incus wrote to stderr. Zero-expiry publish and edit attempts retained the base image's `2026-10-23` expiry; a separately reviewed image edit set `2099-12-31T00:00:00Z`, confirmed by direct API readback. Disposable canaries passed helper `hello`, Docker readiness, two-guest machine-ID uniqueness, and BusyBox Compose over localhost HTTP with recipe limits of 8 GiB and 1024 PIDs; see the packet. Both guests were deleted. Do not change the Python package version. Builder fix `ba4998e9c` uses before/after image inventory and direct image-object readback with finite expiry; it is repo-only and has not had a fresh live build. The existing image does not need replacement solely to record that source fix. Review the exact fingerprint and checked-in recipe pins before generating the full setup plan. The checked-in recipe must change only through the normal reviewed source process.

## 3. Generate and approve the setup plan

Install and activate the approved Incus provider release first. Configure the engine-owned SSH target, identity file, dedicated known-hosts file, host-key pin, endpoint `https://sandbox-server:8443`, and stable connection-encryption secret and salt as described in the [operator README](../../scripts/incus/README.md). The engine generates the provider client private key, stores it encrypted, and puts only the public certificate and its fingerprint in the setup plan. Never place the private key in the recipe or this document. Use one EZHarness control-plane process for this v1 controller. A private recipe copy at `/tmp/ezh-incus-bootstrap-review-20260923.XUcCYG/reviewed-recipe.json` (SHA-256 `7caa4bbead4d0ae86bb88119983624ad82ec8a620b4afaa0d527ffc1632d1385`) changes the staged candidate only by pinning the published guest fingerprint. A fresh read-only plan at `/tmp/ezh-incus-bootstrap-review-20260923.XUcCYG/full-setup-plan.json` has 14 steps but status `blocked`, reason `provider_client_certificate_missing`, and digest `91054dd5a18a46d15ccda57d1280618b5abd334470625bffd0049d2201cc8520`. This digest is **not applicable** and must not be approved for Apply. Generate and review a fresh plan after the engine creates its client identity.

In **Extensions → Set up Incus**, select the approved installation and create a fresh inspection and plan. Review the saved recipe digest, inventory, `ready` status, `blockedReasons`, every command and expected readback, the restricted certificate scope, and the exact plan digest. The expected effects are a 100 GiB loop-backed Btrfs pool `ezharness-btrfs` with 20 GiB default volumes, managed NAT bridge `ezharness0` on `10.173.0.1/24`, restricted project `ezharness` with the recipe quotas, bounded unprivileged `compose` profile, Incus HTTPS listener at `100.81.181.39:8443`, and one restricted client certificate for that project. The precise 15-step command list comes from the saved plan, not from this summary.

The administrator must approve that exact saved digest in the setup screen before **Apply**. The engine reinspects and applies only that saved plan, reads each step back, and keeps a durable receipt. For an offline operator run, inspect again after image publication and create a **new** plan from the reviewed recipe. The initial plan with null pins is not an apply input. Review the new plan before its dry run and explicit execution gate:

```sh
"$EZH_INCUS_BUN" scripts/incus/cli.ts inspect --connection "$EZH_INCUS_SETUP_DIR/connection.json" --out "$EZH_INCUS_SETUP_DIR/ready-inventory.json"
"$EZH_INCUS_BUN" scripts/incus/cli.ts plan --recipe "$EZH_INCUS_SETUP_DIR/reviewed-recipe.json" --inventory "$EZH_INCUS_SETUP_DIR/ready-inventory.json" --out "$EZH_INCUS_SETUP_DIR/ready-plan.json"
"$EZH_INCUS_BUN" scripts/incus/cli.ts apply --recipe "$EZH_INCUS_SETUP_DIR/reviewed-recipe.json" --plan "$EZH_INCUS_SETUP_DIR/ready-plan.json" --connection "$EZH_INCUS_SETUP_DIR/connection.json"
"$EZH_INCUS_BUN" scripts/incus/cli.ts apply --execute --approved-plan-digest <exact-approved-digest> --recipe "$EZH_INCUS_SETUP_DIR/reviewed-recipe.json" --plan "$EZH_INCUS_SETUP_DIR/ready-plan.json" --connection "$EZH_INCUS_SETUP_DIR/connection.json" --out "$EZH_INCUS_SETUP_DIR/apply-receipt.json"
```

The second command is a server mutation and must be used only after the generated plan has separate approval. The offline CLI does not generate or store the provider private key. Prefer the setup screen for that identity and the persisted approval record.

## 4. Failure, reconciliation, and verification

Stop on any blocked preflight, fingerprint mismatch, drift, package failure, or unexpected resource. A timeout, disconnect, conflict, or ambiguous “already exists” result requires a fresh read-only inspection and comparison with the saved receipt before any retry. The apply code skips a step only when its expected state is observed; it does not repeat an uncertain effect automatically. Do not delete pre-existing or possibly shared resources to force a clean plan.

There is no automatic whole-plan rollback. A failed image build removes its temporary guest through the builder trap. For an imported base image, published guest image, storage pool, bridge, project, profile, listener, or trust entry, first identify ownership and dependents from a fresh inventory. Prepare and approve a separate, exact removal plan before a destructive cleanup. Keep the saved plan and receipt for reconciliation.

After apply, use the setup screen's server verification and read-only provider probe, or run the offline verification against a new private output path:

```sh
"$EZH_INCUS_BUN" scripts/incus/cli.ts verify --recipe "$EZH_INCUS_SETUP_DIR/reviewed-recipe.json" --plan "$EZH_INCUS_SETUP_DIR/ready-plan.json" --connection "$EZH_INCUS_SETUP_DIR/connection.json" --out "$EZH_INCUS_SETUP_DIR/verification.json"
```

Require `ready: true`, no failures, matching image fingerprint and alias, matching scoped trust and server listener, and recorded per-step readback. This proves server setup only. The live guest gate still requires a real create → edit → Compose → test → reconnect → destroy run with cleanup receipt, per [integration gate](../../gates/incus-live-integration.md) and [image gate](../../gates/incus-live-image.md). Keep the release and PR in draft until those gates and hosted CI pass.

## Approvals still needed

1. The approved base import, pool/bridge bootstrap, NixOS firewall activation, faulty-image cleanup, and replacement image canaries are complete. The third image fingerprint is `57c0d028e4456a3847fb9822802d6a8f613ba4e6ef03002999e8c957a1f40c6c`, with confirmed expiry `2099-12-31T00:00:00Z`. Review the image fingerprint, finite retention, and resulting checked-in recipe pins. Builder follow-up `ba4998e9c` is repo-only and has no clean live exit proof; it must not replace the published alias without a new exact cleanup approval.
2. Prove the checked-in recipe and host preflight match the published image, helper, and artifact digests. The disposable image canaries do not establish the full operator setup or EZHarness end-to-end path.
3. Review the fresh engine-generated certificate scope, full setup plan, and exact saved digest; approve **Apply** only for that digest. No certificate fingerprint, credentials, or approved plan digest is supplied by this document.
4. After server verification, approve and run the separate live guest qualification with its explicit cleanup scope.
