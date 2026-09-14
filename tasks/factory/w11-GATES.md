# W11 — Real image reference pack (Terra domain)

Scope: `reference.image.v1` (C10 "Reference image factory v1"), plan section 5
W11. Interface freeze sections 6 (per-attempt device contract), 9 (strict
validator report), 10 (acceptance and rejection events), 16.

Branch `wp/w11-image-pack`. Base `integ/w00` at `1d3edf5b0`.
Evidence `/tmp/factory-platform-evidence/w11/`, receipts index
`/tmp/factory-platform-evidence/w11/receipts.json`.

**AMD execution is reported separately from production GPU isolation
certification, which stays unmet.** Every generation below ran on this host's
AMD Radeon RX 7900 XTX under `flock $XDG_RUNTIME_DIR/ezcorp-factory-local-gpu.lock`,
held for the whole run. None of the eight unmet criteria in
`docs/factory-local-gpu.md` is satisfied, weakened, or inferred from these
results. Nothing here reconfigured the GPU and nothing reimaged anything.

## Commits

| SHA | Subject |
| --- | --- |
| `37ea6b4e6` | feat(factory): pin the reference image pack's model, runtime, and check configuration |
| `2f925bcc4` | feat(factory): seal the image pack's guest image and decide its rounds |
| `6b3c9ab75` | feat(factory): execute the image pack's seeds on the local AMD GPU |
| `77e9a8ad5` | test(factory): cover the image pack's staging seam and model reader |
| `71d478f9c` | fix(factory): put the image pack's test helpers where the gate can see them |
| `2744c4bc9` | feat(factory): publish a real image variant through the S3 adapter |

## Gates

- [x] G1: One committed lock pins the SDXL revision, every weight digest, the
      base and guest images, the interpreter, the C10 generation settings, the
      PNG normalization, the OCR configuration and threshold, and the evaluation
      configuration, under one digest that changes when any of them does.
      CHECK: `bun test --timeout 30000 ./src/factory/reference-image/lock.test.ts`
      EXPECT: 53 pass / 0 fail, 186 assertions. Seeds 11, 23, 37, 53; 30 steps; guidance 7.5;
      1,024 by 1,024; at most 10,485,760 bytes; OCR confidence 60; three
      evaluations with a quorum of two and every evaluation decisive. Changing a
      seed, the OCR threshold, or one weight digest changes the lock digest;
      reordering the document's keys does not.
      EVIDENCE: `src/factory/reference-image/sdxl-lock.json`, revision
      `462165984030d82259a11f4367a4eed129e94a7b`, lock digest
      `sha256:0dfe2b80…` before the guest image was sealed into it. Thirty-four
      one-field defects are each refused by name.

- [x] G2: Every byte of the weight closure is bound to a digest the lock
      declared before the download started, and the closure is sealed read-only.
      CHECK: `bun scripts/fetch-factory-sdxl-weights.ts`
      EXPECT: exit 0; 18 files; 6,941,187,536 bytes; every file `0444`.
      EVIDENCE: `/tmp/factory-platform-evidence/w11/logs/sdxl-closure-receipt.json`
      and `logs/sdxl-fetch.log`. Source `https://huggingface.co`, repository
      `stabilityai/stable-diffusion-xl-base-1.0`, revision
      `462165984030d82259a11f4367a4eed129e94a7b`. The four weight files carry the
      model host's SHA-256: unet `sha256:83e012a805b84c7c…`, text encoder two
      `sha256:ec310df2af79c318…`, text encoder one `sha256:660c6f5b1abae9dc…`,
      vae `sha256:bcb60880a46b63de…`. The fourteen small files carry the
      upstream Git object identifier, which is computed over their content.
      HISTORY: the first run exited 1 and is kept. It refused the text encoder
      because the checker applied the Git identifier to weight bytes, and for an
      LFS-backed file that identifier names the pointer object rather than the
      content. The downloaded bytes were correct and the rule was wrong; the
      binding is now one per file and the comment in `model-lock.ts` records it.

- [x] G3: The guest image is built from the pinned base, the pinned wheels, the
      pinned OCR engine, and the sealed closure, and its own digest is sealed
      back into the lock.
      CHECK: `bash scripts/build-factory-image-guest.sh --seal`
      EXPECT: exit 0; a `sha256:` image digest; the launched interpreter imports
      torch and diffusers; the OCR engine answers `--version`.
      EVIDENCE: `logs/image-guest-receipt.json`. Guest image
      `localhost/ezcorp-reference-image@sha256:7f8682bbe3c95549519d15b73ac8267283aff8cdd59ea124783308270449ef35`,
      base `docker.io/rocm/pytorch@sha256:0f6e6e98…`, Python 3.13.15, torch
      `2.12.0+rocm7.14.1`, diffusers `0.40.0`, tesseract 5.3.4, 146
      distributions, 6,941,187,536 closure bytes.
      HISTORY: three earlier builds are kept because each looked fine and was
      not. Repointing `/usr/local/bin/python3` at the virtual environment
      interpreter built cleanly and reported nineteen system distributions with
      no torch, because CPython derives its prefix from the invoked path.
      Writing the wrapper onto that name with a redirect followed the symlink
      and overwrote `/usr/bin/python3.13`, after which the wrapper exec'd itself
      and the build spun at full CPU until it was killed. Re-applying `chmod` to
      the copied closure copied all seven gigabytes into a second layer for no
      change. All three are recorded in the Containerfile next to their fixes.

- [x] G4: The guest is sealed through the shared Python recipe machinery, with
      the observed distribution closure and the model weight pins, and a
      distribution that drifted would fail the build.
      CHECK: the journey below; `bun test --timeout 30000 ./src/factory/reference-image/closure.test.ts`
      EXPECT: the build reaches `succeeded`; the closure declares 146
      distributions and 4 model pins; the guest's own 180 Python tests run
      inside the image before it becomes an artifact.
      EVIDENCE: `logs/journey-four-seeds.json`, guest artifact digest
      `a0db67c45c66ad245d114304368e5c67228cf06623ebb0a2918110ef68351f62`. The
      pack extends `PythonPodmanRunner` rather than forking a launch path, so
      the fail-closed probe, the private artifact store, the read-only channel
      mount, the frame policy, and the device contract are the same code W02
      proved. `PythonPodmanRunner.build` compares the guest's real
      `importlib.metadata` closure with the recorded list and fails with
      `dependency_closure_changed` on any difference.

- [x] G5: The four recorded seeds execute with exactly the C10 settings, each in
      its own isolated GPU attempt on the local AMD profile.
      CHECK: `flock $XDG_RUNTIME_DIR/ezcorp-factory-local-gpu.lock flock /tmp/ezcorp-validation-heavy.lock timeout 6600 bun scripts/verify-factory-image-pack.ts --label four-seeds-c10 --fixtures`
      EXPECT: exit 0; four attempts; 30 steps, guidance 7.5, 1,024 by 1,024;
      torch reports a ROCm build.
      EVIDENCE: `logs/journey-four-seeds.json`. Seeds 11, 23, 37, 53 produced
      2,368,441, 998,116, 2,425,924 and 2,432,539 bytes in 41.6, 29.7, 32.6 and
      31.3 seconds. Observed runtime `torch 2.12.0+rocm7.14.1`, `hip 7.14.60850`.
      One attempt per seed is the faithful reading of mapping four seeds over
      isolated GPU generation, and it is also what the platform allows (G15).

- [x] G6: A GPU attempt reaches exactly the device nodes its held grant names,
      and a CPU attempt from the same sealed artifact reaches none although the
      host runner is configured with three.
      CHECK: same journey
      EXPECT: each generation attempt carries `/dev/kfd`,
      `/dev/dri/renderD128`, `/dev/dri/renderD129`; the fixture attempt carries
      an empty list; `hostConfiguredDevices` is the full three either way.
      EVIDENCE: `logs/journey-four-seeds.json`, `cpuAttemptDevices: []` against
      `hostConfiguredDevices` of three. The grant is derived from the held
      allocation through `factoryHeldAllocationDevices` and
      `factoryAttemptDeviceGrant`, never from the host, and the runner is
      deliberately constructed with the full host-global list that a start must
      not inherit.

- [x] G7: The PNG frame, size, colour, and payload constraints are measured on
      real generated bytes rather than on a fixture.
      CHECK: same journey
      EXPECT: all four seeds PASS `png-single-frame`, `png-dimensions-color`,
      `png-size` and `png-no-extra-payload` at 1,024 by 1,024 RGB, 8-bit.
      EVIDENCE: `logs/journey-four-seeds.json`. The parser is the pack's own
      standard-library reader: it verifies every chunk length and CRC, refuses
      bytes after IEND rather than ignoring them, and reads the frame count from
      `acTL` so "exactly one frame" is a measurement. Normalization decodes and
      re-encodes from the pixels alone, so the output holds only IHDR, IDAT and
      IEND; every generated variant normalized to byte-identical output, which
      is the idempotence the publication claim needs.

- [x] G8: The OCR threshold is measured by the pinned Tesseract English engine,
      and a blank control proves the engine does not report text on any frame.
      CHECK: same journey, `--fixtures`
      EXPECT: the caption fixture FAILs `ocr-no-text` and PASSes the four
      byte-level claims; the blank control PASSes all five.
      EVIDENCE: `logs/journey-four-seeds.json`. The caption reads `SALE` at
      confidence 83.92; the blank control scores zero candidate tokens. On the
      real generations the claim discriminated without being told to: seed 23
      PASSed with 19 candidate tokens all below 60, while seeds 11, 37 and 53
      FAILed on marks the model painted (`'a'` at 63.99, `'aff'` at 61.21, and
      `'2'`, `'&'`, `'Ay'` at 64.24, 76.60 and 70.39).

- [x] G9: Ordered collect semantics: one dense input-ordered slot per seed with
      failed slots kept, and the first accepted variant in input order selected.
      CHECK: `bun test --timeout 30000 ./src/factory/reference-image/variants.test.ts`
      EXPECT: 30 pass / 0 fail, 63 assertions. A later accepted variant never displaces an
      earlier one; a failed generation keeps its slot so later seeds keep their
      positions; a reordered round is refused rather than sorted; a round
      carrying a seed the lock does not record is refused by value.
      EVIDENCE: `logs/journey-four-seeds.json` shows all four variants visible
      with their own verdicts, plus the unit suite.

- [x] G10: Three strict protected semantic evaluations with the required quorum
      and error rules. Two passes and one error is not a quorum.
      CHECK: `bun test --timeout 30000 ./src/factory/reference-image/semantic-quorum.test.ts`
      EXPECT: 33 pass / 0 fail, 57 assertions. Two complete passes and one measured failure
      satisfy the quorum; two passes and one unusable result do NOT, and report
      `quorum.evaluations.indecisive` ahead of any threshold arithmetic. A
      missing field, an extra field, a string in place of a boolean, prose
      around the object, and an empty answer are each unusable rather than a
      denial. Only an unusable evaluation is eligible for a bounded rerun; a
      measured failure never is.
      EVIDENCE: the suite. The scored result records the shared model and
      configuration with `independent: false`, so agreement between three
      evaluations is never presented as three opinions.

- [x] G11a: The wrong-size and SALE-caption fixtures each fail for their own
      recorded reason, and nothing else.
      CHECK: `bun scripts/verify-factory-image-pack.ts --label fixture-wrong-size --seeds 11 --width 512 --height 512`
      and the `--fixtures` leg of the main journey.
      EXPECT: the wrong-size variant FAILs `png-dimensions-color` alone; the
      caption FAILs `ocr-no-text` alone.
      EVIDENCE: `logs/fixture-wrong-size.json`, exit 0. A real 512-pixel
      generation, 468,108 bytes, digest `sha256:6a875f16…`, fetched and verified
      against that digest. It FAILs exactly one claim, `png-dimensions-color`,
      with the summary `size 512x512 is not 1024x1024`, and PASSes the other
      four including the OCR claim at zero candidate tokens. The caption rows in
      `logs/journey-four-seeds.json` are the mirror image: four byte-level
      PASSes and `ocr-no-text` FAIL reading `SALE` at 83.92, against a blank
      control that PASSes all five.
      The caption is drawn inside the guest from
      a bitmap font defined in `reference_image/fixtures.py`, because a model
      asked to render a specific word produces it unreliably and the fixture's
      defect would then be luck rather than construction.

- [x] G12: The accepted publication names the accepted bytes and the evidence
      document, and refuses to publish anything the round did not accept.
      CHECK: `bun test --timeout 30000 ./src/factory/reference-image/publication.test.ts`
      EXPECT: 19 pass / 0 fail, 30 assertions. The file list is sorted by name and satisfies
      W08's own `assertFactoryS3AcceptedPublication`. A round that accepted
      nothing, a second round after an accepted first round, a digest that is
      not the accepted variant's, and a byte count that disagrees are each
      refused by name.
      EVIDENCE: the suite. The evidence document carries every variant of every
      round with its status and reason code, so a four-seed round is never
      reduced to its winner.

- [x] G13: At most two candidate rounds, with the second only when the first
      accepted nothing.
      CHECK: `bun test --timeout 30000 ./src/factory/reference-image/publication.test.ts`
      EXPECT: a publication whose first round already accepted a variant is
      refused with `reference_image_publication_late_round`.
      EVIDENCE: the suite. The bound itself is W06's and unchanged:
      `referenceImageV1` declares `candidate-rounds.maxIterations: 2` and
      `acceptance.maxRepairs: 1`, clamped by
      `FACTORY_LIMITS.maxCandidateGenerations`.

- [x] G14: The repository gates stay green and every new file is fully covered.
      CHECK: `bun run typecheck`; `bun run lint`; `bun scripts/check-factory-boundaries.ts`;
      `bun scripts/gate-integrity.ts`; `bun test --coverage ./src/factory/reference-image/`;
      `bash scripts/python-quality.sh coverage`
      EXPECT: all exit 0; 100% of every new file.
      EVIDENCE: TypeScript 151 pass / 0 fail, 383 assertions, and 100% of
      `closure.ts` (32/32), `lock.ts` (113/113), `model-lock.ts` (41/41),
      `publication.ts` (80/80), `semantic-quorum.ts` (111/111) and `variants.ts`
      (153/153). Python 180 test cases in this project and 100% of 671
      statements and 206 branches. `gate-integrity.ts` reports no
      gate-weakening change; the only gate-file edit widens enforcement by
      adding `src/factory/reference-image/python/**/*.py` to `SOURCE_GLOBS`.

- [x] G14a: The backend pool runs on this branch, and the failures it reports
      are inherited rather than introduced.
      CHECK: `flock /tmp/ezcorp-validation-heavy.lock timeout 2400 bun run test`
      EXPECT: the run completes; every failure is in a file this branch does not
      touch.
      EVIDENCE: `logs/backend-pool.log`, exit 1, **26,930 pass / 7 fail across
      1,795 files**. The seven failures are in five files: two extension
      examples (`auto-note/e2e-server-pipeline`, `docs-updater/subprocess`),
      `extension-contract/schema`, `extension-runner/tests/trusted-local`, and
      `substack-pilot-installer`. `git diff --name-only 1d3edf5b0 HEAD` lists
      only `src/factory/reference-image/**` and six scripts, so every file those
      tests read is byte-identical to the base and the failures exist there too.
      They reproduce on an individual rerun, so they are defects rather than
      load flakes. `git diff --name-only 1d3edf5b0 integ/w00` touches none of
      those areas, so the newer integration branch does not fix them either.
      The `extension-contract/schema` one is worth naming: the authoritative
      type carries `devices` ("Exactly the devices this start may use. Absent
      means none.") and the generated wire schema does not, which is W02's
      per-attempt device contract from `ea1bd94de` with its schema unregenerated.
      Not fixed here: `packages/@ezcorp/extension-contract` is W02's surface and
      editing it while that package's validator may be running would be a worse
      outcome than reporting it.

- [ ] G15: **A variant larger than one mebibyte cannot leave an isolated guest.**
      This is a platform finding, recorded as an unmet row rather than worked
      around.
      CHECK: `grep -n received packages/@ezcorp/extension-runner/src/protocol.ts`
      EXPECT: `received` accumulates for the worker's whole life and is compared
      against a ceiling that `podman.ts` hard-caps at 1,048,576 bytes whatever
      the attempt's `outputBytes` says.
      EVIDENCE: an earlier four-seed run failed with `Worker control output
      exceeded policy` after one 1,024-pixel variant, and is kept. Chunking does
      not help because the budget is cumulative, and a fresh worker holds no
      state so slicing across workers is not available either. W04's auxiliary
      material service is the natural home for large-artifact egress and is
      HTTPS, which an attempt running `--network=none` cannot reach. The journey
      now measures every claim inside the guest that holds the bytes and fetches
      only a variant that fits the remaining budget, which keeps the chunked,
      digest-bound transfer proved (the caption and control fixtures at 10,158
      and 5,331 bytes are fetched and verified) while recording anything larger
      as `deferred-over-budget` with its digest.

- [ ] G16: The three semantic evaluations against the real provider.
      CHECK: blocked.
      EXPECT: open. `ANTHROPIC_API_KEY` is not set on this host and no configured
      provider reference was supplied; plan section 9 makes a missing model
      credential an explicit readiness failure rather than a substitute.
      EVIDENCE: none, deliberately. The quorum rules, the strict answer reader,
      and the claim shapes are implemented and fully covered (G10); only the
      live provider leg is missing. Two further seams are needed even with a
      credential: `broker.invoke` on `IsolatedFactoryAttemptRuntime` has no
      production implementation, and the evaluator needs the variant's bytes,
      which G15 blocks.

- [ ] G17: The car and retained reviewed tree fixtures.
      CHECK: blocked on G16.
      EXPECT: open. Both fixtures' defects are semantic, so neither can be
      rejected or confirmed without the evaluator. The tree fixture is retained
      by digest from the four-seed run rather than by bytes, because G15 blocks
      the egress.
      EVIDENCE: partial. `logs/fixture-car.json`, exit 0, records a real car
      generation at 1,024 by 1,024, 1,186,782 bytes, digest
      `sha256:1b4a9cd1…`. It PASSes all four byte-level claims, which is the
      point: the car's defect is that it is not an oak tree, and no byte-level
      claim can say so. It also FAILed `ocr-no-text` on a mark the model
      painted, which is an incidental rejection rather than the fixture's
      intended one. The retained tree fixture is seed 23 of the four-seed run,
      digest recorded in `logs/journey-four-seeds.json`, the only variant that
      passed every byte-level claim. Neither fixture's semantic verdicts exist.
      **No verdict in this package was recorded by a human.** C10 asks for a
      retained human-reviewed tree fixture, and the reviewer here was an agent.
      Treat the retained verdicts as unreviewed until a human signs them.

- [x] G18a: A real generated variant publishes through W08's S3 adapter against
      the real local store, and the bytes read back are byte-identical.
      CHECK: `EZCORP_FACTORY_STORAGE_SECRETS_DIR=... flock /tmp/ezcorp-validation-heavy.lock bun scripts/verify-factory-image-publication.ts --variant <png>`
      EXPECT: exit 0; two files published; every file re-fetched from the store
      and its SHA-256 recomputed; a repeat refused.
      EVIDENCE: `logs/publication.json`, exit 0. The published variant is the
      one this pack generated on the GPU, 468,108 bytes, digest
      `sha256:6a875f163127277e84e05d603c8bcf5dd4a06bdca7628d3bd242841f971e5889`,
      and the digest recomputed from the bytes read back out of the store is the
      same value; `matchesReceipt` and `matchesSource` are both true for it and
      for the 2,602-byte evidence document. `verifyReceipt` accepted the exact
      receipt, and a second publication of the confirmed set was refused with
      `factory_s3_manifest_published` rather than repeated. The run deleted
      exactly the two object keys and the manifest key it created.
      Two things are stubbed and both are named in the receipt's own fields
      rather than in prose: `semanticQuorum` records that the quorum's field
      values are asserted because no credential exists, and
      `attemptProvenance` records that the database-backed attempt source is a
      stub here, as it is in W08's own store proof.

- [ ] G18b: Publication of an ACCEPTED 1,024-pixel variant, end to end.
      CHECK: blocked on G15 and G16.
      EXPECT: open. G18a publishes a real variant's exact bytes, but that
      variant is a 512-pixel fixture small enough to leave the guest. At the
      contract's size the bytes cannot leave the guest at all (G15), and no
      variant can reach acceptance without the semantic quorum (G16).
      EVIDENCE: none, deliberately.

## Proven

- The pack no longer names an SDXL revision in prose. One document pins the
  revision, all eighteen files, the images, the interpreter, the settings, the
  normalization, the OCR threshold, and the evaluation configuration, and its
  digest changes when any of them does.
- Real SDXL generation runs on this host's AMD card through the factory's own
  launch path, at exactly the C10 settings, one isolated attempt per seed.
- The per-attempt device contract holds inside this pack, not just in W02's
  probe: a generation attempt reached its three granted nodes and a check
  attempt from the same sealed artifact reached none, while the host runner was
  configured with all three.
- The deterministic claims are decided by the pack's own standard-library PNG
  reader and encoder, so "no extra embedded payload" is a measurement of the
  container rather than a hope about an imaging library. Normalization is
  idempotent on every real variant it produced.
- The OCR claim discriminates on real output. It rejected three of four
  generated variants for marks the model painted and accepted the fourth, and a
  blank control scored zero tokens.
- A claim that could not be measured is kept distinct from one that failed
  everywhere: in the guest's report, in the variant assessment, and in the round
  verdict. The four-seed round is `round.unmeasured`, not `round.rejected`,
  because the semantic quorum never ran.

## Deviations and findings

1. `scripts/python-quality.sh` now iterates a list of locked Python projects
   instead of one hard-coded path. This is a W02-owned file. The change is
   additive and the second project is measured on exactly the same terms; both
   projects stay green. Disclosed here because it is a shared file.
2. `scripts/coverage-config.ts` gains one `SOURCE_GLOBS` entry for the image
   pack's Python. It widens enforcement rather than narrowing it, and
   `gate-integrity.ts` passes.
3. The image pack's Python project pins interpreter 3.13.15, which is the
   interpreter the ROCm image ships and is NOT the repository's `.python-version`
   of 3.13.12. Those pins answer different questions: the repository pin governs
   the host toolchain that lints, types and measures this source, and the lock's
   pin governs the interpreter that executes it inside the image. Both are
   enforced; `closure.test.ts` asserts they differ so the distinction cannot be
   collapsed by accident.
4. C10's PNG claims allow RGB or RGBA. The lock pins RGB, because the pack's
   encoder writes what the pipeline produced and SDXL produces RGB. A pack that
   needs alpha changes the lock, which changes the lock digest.

## Open

1. **G15, large-artifact egress. Owned by W12 as of this writing.** The shared
   runner's control-output budget is a per-worker lifetime limit of one
   mebibyte, so an isolated guest cannot return a 1,024-pixel variant at all.
   This blocks G16, G17 and G18b as much as the missing credential does. W12 is
   implementing the per-attempt output mount; W11 consumes it and writes none of
   it. See "Cross-package coordination".
2. **G16, the model credential.** No `ANTHROPIC_API_KEY` and no configured
   provider reference. Recorded as a readiness failure.
3. **`broker.invoke` has no production implementation.** Every existing use of
   `IsolatedFactoryAttemptRuntime` supplies a test stub. A guest-initiated model
   call has nowhere to land today.
4. **`resourceClass: "gpu"` versus `POOL_RESOURCE_CLASSES`.** The definition's
   `generate-four-seeds` node declares the class `"gpu"`, and the pool knows
   `cpu | memory | provider | gpu-host`. Nothing translates one to the other, so
   `normalizePoolResourceVector` would refuse it. This journey holds a
   `gpu-host` allocation directly and does not go through the pool, so the
   mismatch is untouched rather than fixed. It will surface the moment the pack
   asks the pool for capacity.
5. **The retained fixture verdicts are not human-reviewed.** See G17.
6. **W09 composition.** The end-to-end journey through the started application
   is not attempted here; it follows the merge, as the brief directs.

## How to reproduce

```
bun scripts/fetch-factory-sdxl-weights.ts
bash scripts/build-factory-image-guest.sh --seal --out <receipt>
flock $XDG_RUNTIME_DIR/ezcorp-factory-local-gpu.lock flock /tmp/ezcorp-validation-heavy.lock \
  timeout 6600 bun scripts/verify-factory-image-pack.ts --label four-seeds-c10 --fixtures --out <report>
EZCORP_FACTORY_STORAGE_SECRETS_DIR=<secrets> flock /tmp/ezcorp-validation-heavy.lock \
  bun scripts/verify-factory-image-publication.ts --variant <png> --out <report>
bun test --timeout 30000 --coverage ./src/factory/reference-image/
bash scripts/python-quality.sh all
```

The weight fetch needs about seven gigabytes of disk and eight minutes, and the
image build needs about forty gigabytes and twenty minutes. Both are idempotent:
a second fetch verifies rather than refetches, and a second build reuses layers.

## Cross-package coordination

**G15 is now owned by W12.** W12 measured the same cap independently, from the
same two call sites, and proposed the fix: an optional per-attempt read-write
output directory on `StartRequest`, bind-mounted at a fixed guest path inside
the private per-attempt tree the channel already uses, with the host reading the
files back and storing them through W04's `FactoryAttemptMaterials`. Absent
means no mount, so no existing caller changes and C05 stays intact.

W11 confirmed it is touching nothing in `packages/@ezcorp/extension-runner` and
will consume W12's seam rather than write a second one. The requirements W11
gave W12 for it: binary files, writable by the guest's uid 65534 under the
read-only root, a directory rather than a single file, and a declared byte
ceiling, because a bind mount out of the private attempt tree is disk-backed
rather than charged against `limits.tmpBytes` and an unbounded one lets a guest
fill the host disk.

W11 also asked for one addition: the guest should report `{name, digest, bytes}`
per file in its small result frame, and the host should refuse any file whose
recomputed digest or length disagrees. Without that binding a truncated write is
indistinguishable from a complete one, and a partial PNG still decodes. That is
the property the chunked transfer has today and the only one worth carrying
forward. Once the seam lands, W11 deletes the guest's `fetch` tool and the
host's reassembly loop, which is a net simplification.

Numbers given to W12 as evidence: the four real 1,024-pixel variants were
998,116, 2,368,441, 2,425,924 and 2,432,539 bytes, so three of four exceed the
entire per-worker budget on their own before base64 adds a third, and C10 allows
up to 10 MiB per PNG.

## Interface questions for the coordinator

1. ~~Who owns large-artifact egress from a `--network=none` guest?~~ Settled
   directly with W12: they implement the per-attempt output mount in
   `wp/w12-data-pack` and W11 consumes it. See "Cross-package coordination".
   The coordinator's remaining decision is whether that seam integrates before
   or after W13, because G18b and G16 both wait on it.
2. Is there a configured Anthropic provider reference I should resolve, or does
   the missing credential stay a readiness failure through W19?
3. `FactoryS3AcceptedPublication` is W08's shape and W08 asked W11 and W12 to
   emit it. This pack emits it with two files, the accepted PNG under the run's
   output name and `evidence.json`. If a domain pack should not be choosing the
   evidence file's name, that belongs in W08 rather than here.
4. Should the `"gpu"` resource class in `references.ts` become `"gpu-host"`, or
   should the pool learn the definition-level name? Either is a shared-surface
   change and neither is mine to make.
