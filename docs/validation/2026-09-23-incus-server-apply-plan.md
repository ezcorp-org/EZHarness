# Incus server apply plan — review copy, 2026-09-23

This plan targets only `dev@sandbox-server.taile1c5b0.ts.net`. It records a proposed sequence. No server write, image import, image build, or setup apply was done for this document. The checked-in [recipe](../../scripts/incus/recipe.json) still has `null` base, runtime, and published guest-image pins. Its provider client certificate is also absent. The setup planner must therefore remain blocked until those inputs are reviewed and present. The last read-only inventory in the [image input record](2026-09-23-incus-image-inputs.md) found Incus 6.0.6 and no images in the default project; repeat inspection immediately before any write.

## 1. Read-only prechecks

Run from the repository root on the EZHarness engine host. Set `EZH_INCUS_BUN` to the absolute path of Bun 1.3.14 and verify `"$EZH_INCUS_BUN" --version` prints `1.3.14`. Set `EZH_INCUS_SETUP_DIR` to an absolute directory outside Git, create it with mode `0700`, and keep its receipts. Make a private copy of [connection.example.json](../../scripts/incus/connection.example.json) there as `connection.json`. Verify that its target is exactly `dev@sandbox-server.taile1c5b0.ts.net`, its host-key pin is `SHA256:a3VHX02pT5agIluq6K12E9oCuTg09ErbQ5wK9Vvk8Co`, and its absolute identity and dedicated `known_hosts` paths exist and are available to the engine service account. The example paths are not proof that credentials are installed. The inspector checks every accepted host key in that file before SSH. Do not copy a private key into the repository.

```sh
"$EZH_INCUS_BUN" scripts/incus/cli.ts inspect --connection "$EZH_INCUS_SETUP_DIR/connection.json" --out "$EZH_INCUS_SETUP_DIR/initial-inventory.json"
"$EZH_INCUS_BUN" scripts/incus/cli.ts plan --recipe scripts/incus/recipe.json --inventory "$EZH_INCUS_SETUP_DIR/initial-inventory.json" --out "$EZH_INCUS_SETUP_DIR/initial-plan.json"
```

The output files must be new private paths: the CLI writes them with mode `0600` and refuses to overwrite them. Review the inventory and `blockedReasons`; do not use a stale inventory. Confirm the hostname, SSH host key, Incus server certificate fingerprint `c8d6afdbaa6b1dc094f9b8b8dcc949861aca21c98b1d736cee981a8cb107a7d1`, x86_64 architecture, Incus 6.0.6, NTP, cgroup v2, nftables, Btrfs support, root free space, address `100.81.181.39`, route non-overlap with `10.173.0.1/24`, empty guest/trust inventory, and absence or exact match of each owned resource. The planner enforces these checks. The source input record's remote image lookup does not mean that a bare fingerprint is available locally.

## 2. Review and approve the image inputs

The [candidate manifest](2026-09-23-incus-image-inputs.md) identifies Debian 12 amd64 default build `20260923_05:24`, base fingerprint `7ccaa583b060cfec673f96fa9acd52d153a35a8090d68be4cd946280f4b61907`, Python `3.11.2-1+b1`, Docker static `docker-29.8.1.tgz`, Compose v5.5.1, and the current helper source. These are candidates, not recipe pins or an approved build. The operator must approve the exact versions, artifact hashes, and transfer path before the first server write. Recheck all staged files against the manifest and inspect the actual server state again. If the remote build is gone, use only the already verified split-image files; do not substitute a moving alias.

The proposed first write imports the exact reviewed split base image into the **default** project. The server-side import command is:

```sh
incus image import /approved/incus.tar.xz /approved/rootfs.squashfs --alias ezh-base-20260923 --project default
```

Before that command, verify the transferred metadata SHA-256 `ef5a700d30426a2e237499a887f77f59b7527b66f98af8d4207354fb54d7a76a` and root SHA-256 `5f22057b045cffc162824bae27f4a0df2457aed7bb274a903d4b0f411631b973`. After it, read `incus image info 7ccaa583b060cfec673f96fa9acd52d153a35a8090d68be4cd946280f4b61907 --project default`; stop if the local fingerprint does not resolve. Do not infer the published guest fingerprint from these hashes.

Prepare a separately reviewed copy of the recipe with `guestImage.sourceFingerprint`, `pythonPackageVersion`, `dockerArchiveSha256`, and `composeSha256` set to the candidate values below; keep `guestImage.fingerprint` null until publish. Confirm that `sha256sum src/infrastructure/incus-guest/helper.py` still equals the recipe's helper hash. The build script rejects any null or mismatched input. Transfer that reviewed recipe, [builder](../../scripts/incus/build-guest-image.sh), helper, and the two runtime files to the approved server through a controlled operator path. Verify the transferred files there. Then run this **proposed** command from the directory holding those exact files:

```sh
bash build-guest-image.sh reviewed-recipe.json \
  7ccaa583b060cfec673f96fa9acd52d153a35a8090d68be4cd946280f4b61907 \
  3.11.2-1+b1 docker-29.8.1.tgz \
  d8db66739d2e28d4933786d73e918d9be643a67fbd835db1bf740d650a259e70 \
  docker-compose-linux-x86_64 \
  db1889184726840f75c4f9c001048430d4f25b3be3cb084d3ddd762bc0aed576 \
  helper.py 804d68bd8d83ca817c6413eb3b2365216778aa26421c81fb3e9f3810b82dcb75 \
  ezharness-guest-0-1-0
```

The builder verifies file hashes, launches a temporary guest, installs the exact Python package, Docker, Compose, and helper, creates `sandbox` as UID/GID 1000 and the private helper state directory, stops and publishes the guest, and prints the actual published fingerprint. The first real `apt-get update` and exact Python install remain untested. If either fails, stop and review; do not change the package version during the run. Its exit trap deletes the temporary build guest. It does not remove the imported base or a published image. Record the output fingerprint, inspect the image and alias in the default project, and only then request review of a recipe copy with `guestImage.fingerprint` set to that exact value. The checked-in recipe must change only through the normal reviewed source process.

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

1. Approve the exact base metadata/root hashes, Docker and Compose binaries and hashes, Python package version, helper source hash, controlled transfer path, and base import plus image build on `dev@sandbox-server.taile1c5b0.ts.net`.
2. Review the actual published image fingerprint and the resulting recipe change. No published fingerprint is known today.
3. Review the fresh engine-generated certificate scope, full setup plan, and exact saved digest; approve **Apply** only for that digest. No certificate fingerprint, credentials, or approved plan digest is supplied by this document.
4. After server verification, approve and run the separate live guest qualification with its explicit cleanup scope.
