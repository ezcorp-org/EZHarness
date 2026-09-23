# Incus server apply plan — review copy, 2026-09-23

This plan targets only `dev@sandbox-server.taile1c5b0.ts.net`. It records the remaining proposed sequence and the completed first image stage. The exact Debian base was imported after six approved files were staged and rehashed. The digest-approved bootstrap created the exact pool and bridge. Its first verification returned `bootstrap_plan_drift`, then passed after source fix `5d5006763`; see the [current packet](2026-09-23-incus-server-prewrite-review.md). The revised builder has also been transferred and rehashed. Its first guest build failed because the guest had no IPv4/DNS; a separate NixOS bridge-name firewall change is proposed in the packet and has not been applied. No guest image was published, and no full setup apply has occurred. The checked-in [recipe](../../scripts/incus/recipe.json) still has `null` base, runtime, and published guest-image pins. Its provider client certificate is also absent. The full setup planner must therefore remain blocked until those inputs are reviewed and present. Repeat inspection before any further write.

## 1. Read-only prechecks

Run from the repository root on the EZHarness engine host. Set `EZH_INCUS_BUN` to the absolute path of Bun 1.3.14 and verify `"$EZH_INCUS_BUN" --version` prints `1.3.14`. Set `EZH_INCUS_SETUP_DIR` to an absolute directory outside Git, create it with mode `0700`, and keep its receipts. Make a private copy of [connection.example.json](../../scripts/incus/connection.example.json) there as `connection.json`. Verify that its target is exactly `dev@sandbox-server.taile1c5b0.ts.net`, its host-key pin is `SHA256:a3VHX02pT5agIluq6K12E9oCuTg09ErbQ5wK9Vvk8Co`, and its absolute identity and dedicated `known_hosts` paths exist and are available to the engine service account. The example paths are not proof that credentials are installed. The inspector checks every accepted host key in that file before SSH. Do not copy a private key into the repository.

```sh
"$EZH_INCUS_BUN" scripts/incus/cli.ts inspect --connection "$EZH_INCUS_SETUP_DIR/connection.json" --out "$EZH_INCUS_SETUP_DIR/initial-inventory.json"
"$EZH_INCUS_BUN" scripts/incus/cli.ts plan --recipe scripts/incus/recipe.json --inventory "$EZH_INCUS_SETUP_DIR/initial-inventory.json" --out "$EZH_INCUS_SETUP_DIR/initial-plan.json"
```

The output files must be new private paths: the CLI writes them with mode `0600` and refuses to overwrite them. Review the inventory and `blockedReasons`; do not use a stale inventory. Confirm the hostname, SSH host key, Incus server certificate fingerprint `c8d6afdbaa6b1dc094f9b8b8dcc949861aca21c98b1d736cee981a8cb107a7d1`, x86_64 architecture, Incus 6.0.6, NTP, cgroup v2, nftables, Btrfs support, root free space, address `100.81.181.39`, route non-overlap with `10.173.0.1/24`, empty guest/trust inventory, and absence or exact match of each owned resource. The planner enforces these checks. The base fingerprint now resolves locally after the approved import; verify it again before the builder launch.

## 2. Review and approve the image inputs

The [candidate manifest](2026-09-23-incus-image-inputs.md) identifies Debian 12 amd64 default build `20260923_05:24`, base fingerprint `7ccaa583b060cfec673f96fa9acd52d153a35a8090d68be4cd946280f4b61907`, Python `3.11.2-1+b1`, Docker static `docker-29.8.1.tgz`, Compose v5.5.1, and the current helper source. These remain candidates for the guest build, not checked-in recipe pins or an approved published image. Six input files were approved, staged, and verified on the server; the revised builder has not been transferred. Recheck the staged files and inspect the server before the next write. Do not substitute a moving base alias.

The read-only follow-up in the [prewrite packet](2026-09-23-incus-server-prewrite-review.md) found that the server originally had no storage pool and its default profile had no root disk or NIC. The builder's first guest requires the reviewed `ezharness-btrfs` pool and managed `ezharness0` NAT bridge. The full setup planner could not create them first because it stays blocked until the published image exists, so the separate digest-reviewed bootstrap applied exactly those two steps. Its receipt is `applied`, and the fixed read-only `bootstrap-verify` now reports `ready: true` with no failures. Do not run the old builder with an unqualified default-profile launch.

The approved split-base import into the **default** project is complete. Its server-side command was:

```sh
incus image import /home/dev/ezh-incus-image-20260923/incus.tar.xz \
  /home/dev/ezh-incus-image-20260923/rootfs.squashfs \
  --alias ezh-base-20260923 --project default
```

The transferred metadata SHA-256 `ef5a700d30426a2e237499a887f77f59b7527b66f98af8d4207354fb54d7a76a` and root SHA-256 `5f22057b045cffc162824bae27f4a0df2457aed7bb274a903d4b0f411631b973` matched before import. After it, read-only `incus image info 7ccaa583b060cfec673f96fa9acd52d153a35a8090d68be4cd946280f4b61907 --project default` resolved the exact Debian build and alias. Do not infer the published guest fingerprint from these hashes.

The staged candidate recipe sets `guestImage.sourceFingerprint`, `pythonPackageVersion`, `dockerArchiveSha256`, and `composeSha256` to the reviewed inputs and keeps `guestImage.fingerprint` null until publish. Its hash and the helper hash match the packet. The revised [builder](../../scripts/incus/build-guest-image.sh) from commit `a07761cad` was transferred and verified at the approved hash. It uses the recipe's explicit storage pool and bridge at launch. The bootstrap apply receipt and passing verification are recorded in the packet. The guest build uses this command from the staging directory holding those exact files:

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

The builder verifies file hashes and launches a temporary guest with the reviewed pool and bridge. The first live build reached `apt-get update` but failed with DNS resolution errors and exit `100` before installing Python, Docker, Compose, or the helper. Its exit trap deleted the temporary build guest. The packet records the host firewall mismatch and a separate proposed NixOS source/activation step. Do not rerun the builder until the bridge's DHCP/DNS path is verified; do not change the Python package version during the retry. A successful builder must create `sandbox` as UID/GID 1000, install the helper and private state directory, stop and publish the guest, and print the actual fingerprint. It does not remove the imported base, pool, or bridge. Record any future published fingerprint, inspect the image and alias in the default project, and only then request review of a recipe copy with `guestImage.fingerprint` set to that exact value. The checked-in recipe must change only through the normal reviewed source process.

## 3. Generate and approve the setup plan

Install and activate the approved Incus provider release first. Configure the engine-owned SSH target, identity file, dedicated known-hosts file, host-key pin, endpoint `https://sandbox-server:8443`, and stable connection-encryption secret and salt as described in the [operator README](../../scripts/incus/README.md). The engine generates the provider client private key, stores it encrypted, and puts only the public certificate and its fingerprint in the setup plan. Its actual certificate fingerprint and plan digest are unknown now. Never place the private key in the recipe or this document. Use one EZHarness control-plane process for this v1 controller.

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

1. The exact base metadata/root, Docker, Compose, helper, candidate recipe, controlled transfer path, base import, pool/bridge bootstrap, passing read-only verification, and revised builder transfer were approved and completed. The first guest build failed on DHCP/DNS. Review the separate one-line NixOS bridge-name change and its `test`/`switch` activation before any host change; then require a passing disposable-guest network proof and a new builder run on `dev@sandbox-server.taile1c5b0.ts.net`.
2. Review the actual published image fingerprint and the resulting recipe change. No published fingerprint is known today.
3. Review the fresh engine-generated certificate scope, full setup plan, and exact saved digest; approve **Apply** only for that digest. No certificate fingerprint, credentials, or approved plan digest is supplied by this document.
4. After server verification, approve and run the separate live guest qualification with its explicit cleanup scope.
