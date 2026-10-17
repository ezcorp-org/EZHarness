# Incus guest image 0.1.2 build review — 2026-09-24

Status: new image built, guest Docker/Compose canary passed, and source pins updated; EZHarness release integration pending.

## Reason

The published guest image `57c0d028e4456a3847fb9822802d6a8f613ba4e6ef03002999e8c957a1f40c6c` has a working `ezh-docker.service`, but its Unix socket is `0:1001:660`. Incus exec with the approved explicit UID/GID `1000:1000` has only group `1000`, so EZHarness guest processes cannot use Docker Compose. A direct disposable-guest test reproduced the mismatch and removed the guest. The source fix in commit `26bfb4a06` makes dockerd create its socket in group `sandbox` (GID 1000), then requires a Docker API check with UID/GID 1000 and no supplementary groups before publishing.

## Exact inputs and target

Target: `dev@sandbox-server.taile1c5b0.ts.net`; private stage `/home/dev/ezh-incus-image-20260924` (new, mode `0700`); transient build instance in the `default` project; new alias `ezharness-guest-0-1-2`. The old image and alias remain untouched. The reviewed builder and candidate recipe are:

| File | Source | SHA-256 |
| --- | --- | --- |
| Builder | `scripts/incus/build-guest-image.sh` | `cb3448563139b92cc62197579767bedc7c121889eab807e045689d9bfc3b39f2` |
| Build recipe | `/tmp/ezh-incus-image-review-20260924/build-recipe.json` | `49581b69947c2f4b2210dcbd45d87dffb5b2a35f45d0420f157256992b3fa0e9` |
| Docker 29.8.1 archive | existing private server stage | `d8db66739d2e28d4933786d73e918d9be643a67fbd835db1bf740d650a259e70` |
| Compose binary | existing private server stage | `db1889184726840f75c4f9c001048430d4f25b3be3cb084d3ddd762bc0aed576` |
| Guest helper | existing private server stage | `804d68bd8d83ca817c6413eb3b2365216778aa26421c81fb3e9f3810b82dcb75` |

The recipe pins base fingerprint `7ccaa583b060cfec673f96fa9acd52d153a35a8090d68be4cd946280f4b61907`, Debian Python package `3.11.2-1+b1`, the three artifact hashes above, existing Btrfs pool `ezharness-btrfs`, and bridge `ezharness0`. Its output fingerprint is unset until the new image is built and independently read back. The new alias is absent. The server currently has zero instances in both `default` and `ezharness`; the old image remains available.

## Bounded sequence

1. Recheck the exact stage is absent, no instances exist in either project, the base image and old artifact hashes match, the new alias is absent, and the reviewed pool/bridge/project policy is unchanged.
2. Create only `/home/dev/ezh-incus-image-20260924` as mode `0700`; transfer the exact builder and build recipe there as mode `0600`; compare their server hashes with the table. **Completed:** the two server hashes match exactly. The old artifact hashes and zero-instance checks also passed immediately before staging.
3. Run the reviewed builder with the new recipe, base fingerprint, Python package, the three existing artifact paths and digests, and new alias. It creates one transient build instance, tests Docker under explicit UID/GID 1000, sanitizes guest machine identity and runtime state, and publishes one new image. Its cleanup trap removes the build instance.
4. Read back the new image fingerprint, alias, type, expiry, and exact guest base. Launch one disposable guest from the new fingerprint under the restricted `ezharness` project and `compose` profile. As UID/GID 1000 without supplementary groups, prove Docker API and a pinned Compose fixture work. Delete the disposable guest and verify zero instances.
5. Pin the new fingerprint and alias in the source recipe and provider preset, then build, verify, review, and activate a new v4 provider release. The active 0.1.1 release and existing setup remain unchanged until that later reviewed release step.

If any verification fails, leave the new image unqualified and inspect the exact transient instance/image before another attempt. Do not replace the old alias, weaken the project, or claim EZHarness Compose support from the builder test alone. EZHarness-owned guest creation, provider qualification, and feature flow remain separate gates.

## Live result

The staged builder and recipe hashes matched. Preflight found no instances in
either project, the new alias absent, the pinned base image present, the
reviewed Btrfs pool and bridge present, and the restricted project's local
image policy unchanged. The builder exited 0 and published image
`2f8868763f6cbec0452ab0d4db82ecb315c4aff1b9a3d2d1777cd878017e9fa1`.
Independent Incus readback found the exact new alias target, a private
container image, and expiry `2099-12-31T00:00:00Z`.

A disposable guest from that fingerprint started under project `ezharness`
and profile `compose`. Its Docker socket was `0:1000:660`; Docker API version
`29.8.1` answered as explicit UID/GID `1000:1000`. A pinned BusyBox Compose
fixture printed `ezh-compose-ok` under the same identity. The guest was
deleted, and fresh counts showed zero instances in both projects. This proves
the corrected image's guest Docker access. It does not yet prove EZHarness
guest dispatch or feature readiness.

The checked-in operator recipe now identifies version `1.2.2`, alias
`ezharness-guest-0-1-2`, and the new fingerprint. The provider manifest and
package identify release `0.1.2` and bind both presets to that fingerprint.
The source pin tests passed (32/32). These source changes do not activate a
provider release or change the prior verified setup record.
