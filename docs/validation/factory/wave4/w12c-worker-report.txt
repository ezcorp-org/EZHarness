# Gates: W12c data image re-pin

Scope: re-pin `src/factory/reference-data/image/pinned.json` after a host-wide image removal.
Branch `wp/w12c-data-image-repin`, from `integ/w00` at `7a87aed5e`. Receipts live under
`/tmp/factory-platform-evidence/w12c/`; each `<check>.json` records the producing commit, the
dirty-tree hash, the exact command, the exit code, UTC start and end, test counts, and the log's
SHA-256.

## Cause

A host-wide image removal deleted the pinned factory data image. The coordinator re-pulled the
pinned Python base by digest and rebuilt the image with `scripts/build-factory-data-image.sh`.
The three Podman guest suites then failed with "image not known", because the pin named the old
digest. W12c ran the build script again in this worktree (it reused the local image) and
committed the regenerated pin. Only the `image` field changed. `tag`, `base`, and `lockDigest`
are unchanged.

## Finding: the image build is not reproducible

The same `uv.lock`, the same Containerfile, and the same base digest gave a different image:

| Pin | Manifest digest |
| --- | --- |
| Committed before W12c | `sha256:21a7134763a591a10e2460b860ef62bbae650e8db90496f70410caf073cdb1b0` |
| Rebuilt on 2026-09-24 | `sha256:1bf456b746c349c960a1abc43fd69c66ab990c6a46dc2125f32defc1b6da1cee` |

Hygiene follow-up (open, not in W12c scope): make the build reproducible, so that a rebuild
gives the pinned digest. Candidates: a fixed layer timestamp (`podman build --timestamp` or
`SOURCE_DATE_EPOCH`), no pip caches or `.pyc` files with build-time stamps in the layers, and a
check that fails the build when the digest differs from the committed pin. Until then, every
loss of the local image needs a re-pin commit like this one.

## Gates

- [x] G1: the regenerated pin names the local image and keeps `lockDigest`, `base`, and `tag`. CHECK: `bash scripts/build-factory-data-image.sh && git diff 7a87aed5e -- src/factory/reference-data/image/pinned.json` EXPECT: exit 0; the diff changes only `image`, to the digest of `podman image inspect localhost/ezcorp-factory-python-data:a8034aa9676cedc3706aefa3ef4e7939`. EVIDENCE: `/tmp/factory-platform-evidence/w12c/build.log`, commit `9df13f57a`.
- [x] G2: the guest unit suite passes. CHECK: `bun test --timeout 30000 ./src/factory/reference-data/guest.test.ts` EXPECT: 0 fail. EVIDENCE: `/tmp/factory-platform-evidence/w12c/guest-unit.json`
- [x] G3: the reference-data journey Podman suite passes. CHECK: `bun test --timeout 300000 ./src/factory/reference-data/journey.integration.test.ts` EXPECT: 0 fail. EVIDENCE: `/tmp/factory-platform-evidence/w12c/podman-journey.json`
- [x] G4: the applied-controls Podman suite passes. CHECK: `bun test --timeout 300000 ./src/factory/runner/applied-controls.integration.test.ts` EXPECT: 0 fail. EVIDENCE: `/tmp/factory-platform-evidence/w12c/podman-applied-controls.json`
- [x] G5: the python-guest Podman suite passes. CHECK: `bun test --timeout 300000 ./src/factory/runner/python-guest.integration.test.ts` EXPECT: 0 fail. EVIDENCE: `/tmp/factory-platform-evidence/w12c/podman-python-guest.json`
- [x] G6: static gates pass. CHECK: `bun run typecheck`, `bun run lint`, `bun scripts/gate-integrity.ts`, `bun scripts/check-factory-boundaries.ts` EXPECT: exit 0 each. EVIDENCE: `/tmp/factory-platform-evidence/w12c/{typecheck,lint,gate-integrity,boundaries}.json`
- [x] G7: coverage gates pass. CHECK: `BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts && BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts` EXPECT: exit 0. EVIDENCE: `/tmp/factory-platform-evidence/w12c/{new-file-coverage,patch-coverage}.json`
- [ ] G8 (follow-up, not W12c): a rebuild from the same lock and Containerfile gives the pinned digest. CHECK: remove the local image, rebuild, compare the digest with `pinned.json`. EXPECT: equal.
