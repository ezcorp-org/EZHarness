# Gates: W12 real data reference pack (Sol domain)

Scope: `docs/plans/2026-09-13-composable-factory-platform-completion.md` section 5, W12; contract
C10 "Reference data factory v1" and the shared S3 release adapter; interface freeze sections 7, 9,
10 and 16. Receipts live under `/tmp/factory-platform-evidence/w12/`; each `logs/<label>.json`
records the producing commit, the SHA-256 of every dirty file, the exact command, the exit code,
UTC start and end, duration, and the log's own SHA-256.

Branch `wp/w12-data-pack`, from `integ/w00` at `1d3edf5b0`, then merged with the coordinator's
`integ/w00` at `2377caaa4` (W03's work-list scans addendum) as `02457a858`. No conflicts.

Commits:

| SHA | Subject |
| --- | --- |
| `755ff7982` | feat(factory): pinned PyArrow guest and the strict reference-data grammar |
| `1172ed92a` | feat(factory): seal the reference-data guest and pin its image by digest |
| `2e9fd85fb` | feat(factory): independent Parquet reader and the protected reconciliation |
| `bb80e9654` | feat(factory): run reference.data.v1 end to end as real isolated attempts |
| `7eaf0877b` | feat(factory): publish the reference-data export through W08 and hold the 256 MiB bound |
| `8fb72bc31` | test(factory): register the reference-data gates and cover every new module |
| `997552e26` | docs(factory): W12 gates, checklist, review, and lessons |
| `02457a858` | merge: integ/w00 at 2377caaa4 |
| `66e697ad4` | fix(factory): give each reference-data step its own material operation |
| `05e10a46f` | docs(factory): close every W12 gate with its receipt |
| `b83ca7c0e` | test(factory): run the two data boundary cases in separate invocations |
| `849d3bb8c` | docs(factory): record the shared-store fault and the head-commit receipts |
| `5c8c66d3e` | fix(factory): widen the W04 object margin and stop giving the guest a world-writable directory |
| `f48cf4bb8` | test(factory): make the faithful full-file run the reference-data producer |
| `88162a98d` | test(factory): one faithful full-file run, not three |
| `a74f65606` | docs(factory): record the validator findings and the commit that closes each |

## The one thing that blocked this package, and what was done about it

**An isolated guest had no byte path out above one mebibyte for its whole life.** Measured, not
inferred: `packages/@ezcorp/extension-runner/src/protocol.ts:87-89` accumulates `this.received`
across the WHOLE execution and fails with `output_limit` once it passes `frameBytes`;
`podman.ts:479-484` pins `frameBytes = Math.min(limits.outputBytes, 1024 ** 2)` and
`executionLimits.outputBytes` is exactly that. The guest is `--network=none` with a read-only root
and a read-only `/channel` mount, so the execution gateway's material routes are unreachable from
inside one too. A 10,000-row partition at C10's own 256 MiB bound is about 2.6 MiB of CSV and a
similar amount of Parquet, so no domain pack could return its real output. W11's PNG has the same
problem.

This was raised with the coordinator before any code was written and the proposed fix was landed
here as a disclosed additive change rather than a fork: `StartRequest` gains an optional
`materials` directory, bind-mounted read-write at `GUEST_MATERIALS_PATH` (`/materials`). Absent
means no mount, so no existing caller changes, and every C05 control is untouched: still
`--network=none`, still `--read-only`, still `--cap-drop=ALL`, still uid 65534, still no credential
and no device. The host writes the guest's inputs into that directory before the start and reads
its outputs back afterwards, digest-verified, through W04's material service.

## Gates

- [x] G1: The pinned Python/PyArrow runner image is BUILT FROM THE COMMITTED LOCK, and its closure
  is verified inside a live guest before any artifact is sealed.
  CHECK: `bash scripts/build-factory-data-image.sh`; the `closure` build lane in
  `logs/journey-pglite.json`
  EXPECT: exit 0; the guest's own importable distributions equal the declared closure
  EVIDENCE: `logs/data-image-build.log`, exit 0. PyArrow was added to the committed
  `src/factory/runner/python/uv.lock` through `uv lock`, and the image installs exactly the
  non-development closure that `uv export --locked` produces, hash-verified with
  `pip install --require-hashes --only-binary=:all:` on W02's digest-pinned CPython 3.13.12 base.
  The recorded release lock is `src/factory/reference-data/image/pinned.json`:
  `localhost/ezcorp-factory-python-data@sha256:21a7134763a591a10e2460b860ef62bbae650e8db90496f70410caf073cdb1b0`,
  tag `a8034aa9676cedc3706aefa3ef4e7939` derived from the lock and the Containerfile.
  `factoryReferenceDataImage()` recomputes that tag and refuses the lock if it no longer matches its
  inputs, so a stale pin is a readiness failure rather than a silently wrong image. The observed
  closure is `attrs==26.1.0, jsonschema-specifications==2025.9.1, jsonschema==4.25.1, pip==25.3,
  pyarrow==25.0.1, referencing==0.37.0, rpds-py==2026.6.3`, recorded rather than assumed:
  `PythonPodmanRunner.build` reads it back out of a real guest and fails with
  `dependency_closure_changed` on any drift.

- [x] G2: The strict grammar refuses every kind of silent coercion C10 names, in BOTH runtimes, on
  the same committed vectors.
  CHECK: `bun test --timeout 400000 ./src/factory/reference-data/csv.test.ts`;
  `bash scripts/python-quality.sh test`
  EXPECT: exit 0 on both; 29 shared vectors get the same verdict in Bun and in Python
  EVIDENCE: `logs/focused-suites.json` and `logs/python-quality.json`.
  `src/factory/reference-data/fixtures/grammar.json` holds the accept and reject vectors and both
  parsers read it. Refused by name: `amount_overflow` at 2**63, `amount_charset` for `-1`, `+1`,
  `1.5`, `1e3`, a leading space and an Arabic-Indic digit that `BigInt` and `int` would both have
  read as five, `amount_leading_zero` for `007`, `record_id_duplicate`, `row_field_count`,
  `record_id_empty`, `category_empty`, `record_id_bytes` and `category_bytes` measured in BYTES not
  characters, `header_mismatch`, `header_missing`, `row_empty`, `row_carriage_return` rather than
  stripping it, `row_blank_line`, `encoding_invalid` rather than a replacement character, and
  `byte_limit` and `row_limit` as refusals rather than clamps. The whole signed-64-bit domain is
  carried exactly and a global total that leaves it is still exact, because every amount is a
  `bigint` and every sum crosses the wire as a decimal string.

- [x] G3: The exported Parquet is decoded by a reader that shares no code with the writer.
  CHECK: `bun test --timeout 120000 ./src/factory/reference-data/parquet.test.ts
  ./src/factory/reference-data/thrift.test.ts`
  EXPECT: exit 0
  EVIDENCE: `logs/focused-suites.json`. `thrift.ts` is a compact-protocol decoder and `parquet.ts`
  a strict footer and PLAIN page reader; neither calls PyArrow. All seventeen fixtures in
  `src/factory/reference-data/fixtures/parquet/` are bytes the real pinned writer produced. The
  reader reads the golden three rows, the whole signed-64-bit domain, a negative amount faithfully
  so the reconciliation can refuse it, and two row groups concatenated in file order; it refuses a
  nullable column (`parquet_repetition`), a dictionary page (`parquet_encoding`), compression
  (`parquet_codec`), a v2 data page (`parquet_page_version`), and an extra, renamed, or narrowed
  column (`parquet_schema`). Flipping every byte of a real footer and every byte of its column
  chunks, one at a time, produces only this reader's own refusals: the sweep found a `TextDecoder`
  `TypeError` escaping from a Thrift string field, which is now `thrift_text`.

- [x] G4: The protected reconciliation recomputes every claim from the immutable input and the
  exported bytes, and never from a counter the transform reported.
  CHECK: `bun test --timeout 120000 ./src/factory/reference-data/reconcile.test.ts`
  EXPECT: exit 0; 17 cases
  EVIDENCE: `logs/focused-suites.json`. The comparison is made against BOTH the input and the
  manifest, which is what closes the self-certification case: a defective transform that also wrote
  a matching manifest agrees with itself and still disagrees with the source (`total_source`). Row
  values are compared position by position, never as sets, so a reordered export fails
  `source-row-values` while every total still adds up. A malformed manifest or an undecodable
  export fails `output-schema` and leaves the rest `INCONCLUSIVE`, never `PASS`: C10's decision rule
  treats only `PASS` as satisfying a required claim. Every report is checked against
  `validateFactoryValidatorClaimReport` whatever its verdicts.

- [x] G5: C10's whole graph runs as real isolated attempts, and the golden three-row input passes
  every protected claim.
  CHECK: `flock /tmp/ezcorp-validation-heavy.lock bun test --timeout 1800000
  ./src/factory/reference-data/journey.integration.test.ts`
  EXPECT: exit 0
  EVIDENCE: `logs/journey-pglite.json`, exit 0, 8 pass / 0 fail at the time it was taken (10 with
  the publication and boundary legs added). Four real guest executions in order -
  `snapshotCsv`, `parseCsv`, `transformPartition`, `orderedReduce` - each with the pinned image, a
  sealed artifact, a fresh per-attempt material directory, one framed `extension/invoke`, and a
  result the shared C02 contract admits. The exported Parquet says `parquet-cpp-arrow version
  25.0.1` and decodes to `a/alpha/100 b/beta/250 c/alpha/50`; the manifest says row count 3, total
  400, alpha 2/150, beta 1/250, which is exactly C10's stated expectation.

- [x] G6: Nothing the guest says is believed without the host measuring it.
  CHECK: the same suite, plus `bun test --timeout 60000 ./src/factory/reference-data/pack.test.ts`
  EXPECT: exit 0
  EVIDENCE: `logs/journey-pglite.json` and `logs/focused-suites.json`. Every file the guest leaves
  is re-hashed by the host and compared with what the guest reported before it becomes a durable
  material (`reference_data_guest_disagrees`), and the snapshot step is a real cross-check: the
  guest hashes the bytes it was actually given, and a disagreement with the sealed input is the one
  thing a snapshot exists to rule out. A request the shared contract would not admit never reaches
  a guest; a result it would not admit is refused before anything reads it; a guest that asks for a
  reverse capability it does not have is refused.

- [x] G7: Every C10 negative fixture stops the run and names its own reason.
  CHECK: the journey suite, case "every C10 negative fixture stops the run at the parse step"
  EXPECT: exit 0
  EVIDENCE: `logs/journey-pglite.json`. Duplicate `record_id`, an amount at 2**63, a two-field row,
  a header that is not the pinned one, a negative amount, and a header with no rows each fail the
  parse attempt with the grammar's own code carried out of the guest. A duplicate that spans two
  partitions is caught too, because the guest holds a global identifier index across the whole
  stream rather than one per partition.

- [x] G8: A defective transform is caught by the reconciliation and repaired only as a new pinned
  revision.
  CHECK: the journey suite, case "a defective transform is caught by the reconciliation"
  EXPECT: exit 0
  EVIDENCE: `logs/journey-pglite.json`. A transform that drops the last row of every partition is
  built as a SECOND artifact with its own digest; its export is internally consistent, and the
  reconciliation still fails `source-row-values` and `row-count-unique-ids` against the immutable
  input. The repair is a different pinned artifact, and rerunning the defective one fails again:
  nothing was fixed in place.

- [x] G9: Correcting the input is a new snapshot and a new run.
  CHECK: the journey suite, case "correcting the input is a new snapshot and a new run"
  EXPECT: exit 0
  EVIDENCE: `logs/journey-pglite.json`. The input is sealed BEFORE anything expands it, and W04
  refuses to re-begin the same object version with different bytes
  (`factory_material_conflict`), so the snapshot a run was decided against cannot be replaced. A
  corrected input is a different run with a different input and snapshot digest.

- [x] G10: The export publishes through W08 and reads back byte for byte from a real object store.
  CHECK: `postgres-env flock /tmp/ezcorp-validation-heavy.lock bun test --timeout 5400000
  ./tests/postgres/factory-reference-data.test.ts`
  EXPECT: exit 0
  EVIDENCE: `logs/postgres-journey.json` at `f48cf4bb8`, exit 0, 11 pass. W08's own profile resolves the accepted
  publication into the frozen request, pinning each member's media type, digest, byte count, and
  chunk count from its sealed W04 record, and W08's own provider stages every member privately and
  writes `manifest.json` last as the publication point. The published Parquet is then read back out
  of the store and decoded by this pack's independent reader to exactly `a/alpha/100 b/beta/250
  c/alpha/50`, and the published dataset manifest still reconciles against the immutable input read
  straight out of W04. The suite deletes exactly the object versions its publication created, by
  key and version id, and nothing else. The only stub is the provenance lookup that reads a release
  operation, which is W09's row to write; the verified attempt it returns is this journey's real
  attempt.

- [x] G11: A 256 MiB input runs the whole graph and reconciles exactly, and one byte more is
  refused.
  CHECK: the same producer
  EXPECT: exit 0
  EVIDENCE: `logs/postgres-journey.json` at `f48cf4bb8`, exit 0, 11 pass. The generator streams exactly 268,435,456 bytes
  of valid input at C10's declared field bounds (706,409 rows, 71 partitions, five categories),
  because "at most 256 MiB" is a boundary and not an approximation. **This case found a real
  defect**: the seal wrote one chunk per incoming block, so a 256 MiB input arriving in
  one-mebibyte blocks ran thirty-two chunks past its own declared plan and W04 refused it with
  `factory_material_chunk_index_invalid`. The stream is now repacked to the plan, which is what a
  caller's block size has nothing to do with. One byte past the bound never reaches a guest: the
  material service refuses to seal it, so the run has no snapshot to expand.

- [x] G11a: The maximum row count runs the whole graph, and one row more is refused.
  CHECK: `postgres-env flock /tmp/ezcorp-validation-heavy.lock bun test --timeout 5400000
  --test-name-pattern "maximum row count" ./tests/postgres/factory-reference-data.test.ts`
  EXPECT: exit 0
  EVIDENCE: `logs/postgres-journey.json` at `f48cf4bb8`, exit 0, 11 pass / 0 fail. The case is
  declared LAST in the suite, so the faithful full-file run is what proves it rather than an
  isolated one; an earlier isolated receipt, `logs/postgres-maximum-rows.json`, passed while the
  full run did not, which is the whole of validator finding F1. One million
  rows, a hundred ordered partitions, and a manifest total of 500,000,500,000 - which is
  `n(n+1)/2` and which no double holds exactly, so the decimal-string sums are doing real work.
  One row more fails the parse attempt with `row_limit` carried out of the guest. **This case found
  a real defect**: W04 admits at most 256 objects under one C02 operation, and a hundred partitions
  produce three materials each, so a full-size run wrote 304 and was refused with
  `factory_material_operation_full`. One operation for a whole journey was a simplification, not
  the contract. Each graph step now writes under its own operation - `source` 2 objects,
  `partitions` 200, `export` 102 - and everything W08 publishes stays inside the single `export`
  operation, because `FactoryS3AcceptedPublication` names exactly one.

- [x] G12: W18's Python lanes stay green, with 100% line and branch coverage of every Python file.
  CHECK: `bash scripts/python-quality.sh all`
  EXPECT: exit 0
  EVIDENCE: `logs/python-quality.json`. W02's 131 existing tests still pass alongside this pack's,
  and every Python source file is at 100% line and branch coverage. Two lanes were not measuring
  what they claimed and are fixed rather than worked around: `mypy` resolved its configuration
  relative to the repository root, which holds no `pyproject.toml`, so the locked project's
  `[tool.mypy]` section was read by nothing; and discovery only ever looked in one directory.

- [x] G13: Static gates.
  CHECK: `bun run typecheck`; `bun run lint`; `bun scripts/check-factory-boundaries.ts`;
  `bun scripts/gate-integrity.ts`; `bun scripts/check-factory-lanes.ts`;
  `bun test ./scripts/factory-c13-inventory.test.ts ./scripts/factory-postgres-suite-registration.test.ts`
  EXPECT: all exit 0
  EVIDENCE: `logs/static-gates.json`.

- [x] G14: Coverage of every new file and every changed executable line.
  CHECK: `BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts`;
  `BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts`
  EXPECT: both exit 0
  EVIDENCE: `logs/coverage-gates.json`, exit 0. "New-file coverage gate PASSED: 13 new source
  file(s) gated" and "Patch coverage gate PASSED: all changed executable lines covered (12
  file(s))", merged from five producers: the focused suites, the gate-script tests, the embedded
  journey, the real-PostgreSQL journey, and `scripts/python-quality.sh coverage`, which is the only
  instrumenter that can measure Python. Every Python file is at 100% LINE and BRANCH coverage.

- [x] G15: The shared runner is unchanged for every caller that does not name a material directory.
  CHECK: `flock /tmp/ezcorp-validation-heavy.lock bun test --timeout 1800000
  ./packages/@ezcorp/extension-runner/tests/podman.integration.test.ts
  ./src/factory/runner/python-guest.integration.test.ts
  ./src/factory/runner/applied-controls.integration.test.ts`
  EXPECT: exit 0
  EVIDENCE: `logs/shared-runner-regression.json`, exit 0, 33 pass / 0 fail across three files.
  W01's shared Podman suite, W02's isolated Python guest, and W02's applied-control probe all pass
  on the changed runner. The applied-control probe is the one that matters most: it reads every
  control back from `podman inspect` on the live container and asserts the absence of any
  read-write mount but `/tmp`, which is exactly what a mount added unconditionally would have
  broken.

## Independent validation, and the commit that closes each finding

Verdict ACCEPT-WITH-FIXES (`/tmp/factory-platform-evidence/w12-validation/results.json`).

| Finding | Closed by | What changed |
| --- | --- | --- |
| F1 HIGH: the maximum-row case failed a faithful full-file rerun with `factory_material_operation_full` and passed only in isolation | `5c8c66d3e`, proved by `logs/postgres-journey.json` | Root cause was the MARGIN, not the ordering: at C10's hundred partitions the `partitions` operation wrote one partition CSV and one summary each, 200 objects against W04's frozen cap of 256. The hundred summaries are now ONE material, so the widest operation at C10's maximum holds 102 of 256. The reduction still reads durable bytes, because it reads that material back rather than whatever the host happens to still hold. W04's limit is untouched. The case is declared LAST in the suite, so the faithful full-file run is what proves the budget after every sibling. Each case already used a distinct project, run, attempt and operation id, and each fixture's database is dropped on close, so nothing leaks between them. |
| F2 MEDIUM: the gate file was never committed | `05e10a46f` | `.gitignore` line 8 ignores `tasks`, so `git add -A` skipped it silently and the commit meant to carry it had nothing to commit and failed. Force-added, which is how every sibling package's gate file got in. |
| F3 MEDIUM: `tasks/todo.md` claimed completion at a commit preceding the receipt it rested on | `5c8c66d3e` | The review now states the actual order of events, including the full-file failure F1 records. |
| F4 MEDIUM: an unapproved change to a shared file outside W12's ownership | `7ac4b261d` | CLOSED by consuming rather than carrying. `integ/w00` at `f30da62fa` was merged and its version of `StartRequest.materials`, `GUEST_MATERIALS_PATH` and `runnerMaterialMount` was taken wholesale in both Terra packages; this branch's copy is deleted. W11 was told to consume the canonical one too. |
| F5 LOW: `shared-runner-regression.log` was truncated to 0 bytes, orphaning its receipt's SHA-256 | `f48cf4bb8` | Re-run and re-recorded. Every receipt's `logBytes` now equals its log's size on disk. |
| F6 LOW: the guest output directory was 0o777 | `5c8c66d3e`, kept through `7ac4b261d` | It is handed to the guest's own uid with `podman unshare chown 65534:0` at mode 0o770: the mapped uid owns it, this user is its group, and other gets nothing. Inputs stay host-owned at 0o644, so a guest cannot replace what it was given. A host with no container runtime fails closed rather than widening the mode, and leaves nothing behind. |
| W01c hardening: `collect()` and `produced()` followed symbolic links | `7ac4b261d` | Both now go through the shared `openRunnerMaterial` and `listRunnerMaterials`, which refuse a symbolic link, a device, a socket and a FIFO rather than following one. This was a real hole: the name grammar stopped traversal and a second path segment, but nothing stopped a link AT the final component, and the guest owns its output directory precisely so it can write there. The digest comparison did not save it either, because a guest that plants a link and reports the target's digest agrees with itself. `src/factory/reference-data/materials.test.ts` plants one and asserts the refusal. |
| W02b migration: `RunnerReference.manifestName` | `7ac4b261d` | The scoped package and the unscoped manifest name simply differ now, so the reconciliation this pack carried is deleted along with the paragraph explaining why the two landed rules could not both hold. `factoryReferenceDataRunner` is the one place the reference is built, and `FACTORY_REFERENCE_DATA_MANIFEST_NAME` is derived by the SDK's `manifestNameOf` rather than written twice. |
| F7 INFO: two platform-level interface conflicts | not W12's | The v4 manifest-name grammar against `releaseFacts()` is assigned to W02; the host-side reconciliation waits on W09's composition. Both stated under "Interface questions" below. |

## Shared-store incident

The ordinary SeaweedFS service was OOM-killed twice under this package's load, at its own 768 MiB
container limit and not for want of host memory. Recorded by the coordinator at
`/tmp/factory-platform-evidence/w00/shared-store-incidents.jsonl`; the limit was raised to 2 GiB on
`integ/w00` at `c054c6430` and documented in `docs/factory-local-storage.md`. As of this gate file
the ARCHIVE service carries 2147483648 and the ORDINARY one still carries 805306368 and is exited,
which is reported to the coordinator.

Nothing here restarted, recreated, reconfigured, or pruned either service. What this package did
change is its own footprint: the real leg is ONE faithful full-file run, not three. Repeating the
two boundary cases in separate invocations added no proof the full run does not already make and
doubled the object volume on that service.

## Receipts

Every receipt below was recorded from a clean committed tree, and every log's size on disk equals
its own recorded `logBytes`.

| Receipt | Commit | Result |
| --- | --- | --- |
| `logs/postgres-journey.json` | `f48cf4bb8` | exit 0, 11 pass / 0 fail, 240 s. **MUST BE RE-RUN** - see the window note below. |
| `logs/journey-pglite.json` | `f48cf4bb8` | exit 0, 11 pass / 0 fail |
| `logs/shared-runner-regression.json` | `f48cf4bb8` | exit 0, 33 pass / 0 fail |
| `logs/static-gates.json` | `f48cf4bb8` | exit 0, 18 pass / 0 fail |
| `logs/focused-suites.json` | `f48cf4bb8` | exit 0, 89 pass / 0 fail |
| `logs/script-gates.json` | `f48cf4bb8` | exit 0, 18 pass / 0 fail |
| `logs/python-quality.json` | `f48cf4bb8` | exit 0, 100% line and branch |
| `logs/coverage-gates.json` | `88162a98d` | exit 0, 13 new files gated, 12 changed files covered |

`f48cf4bb8..88162a98d` changes exactly one file, `scripts/factory-reference-data-coverage.sh`, and
no code under test, so the real-services receipt is a proof of this head's behaviour.

**The real-services receipt was taken against a degraded store and is not final.** The coordinator
records that a stale compose file in another worktree recreated the ordinary service at its old
768 MiB limit at 16:02 UTC, and it was OOM-killed again at 16:19:34 UTC. Checked against that
window, three of this package's receipts touched the ordinary store inside it:

| Receipt | Window UTC | Disposition |
| --- | --- | --- |
| `logs/postgres-journey.json` | 16:14:55 to 16:18:56 | exit 0, 11 pass, and it finished 38 seconds before the store died. It PASSED, but against an under-provisioned service, so it is marked for re-run in the next round rather than counted as final. |
| `logs/superseded-postgres-boundary-bytes.json` | 16:19:26 to 16:19:35 | exit 1, `ECONNREFUSED`. A repeat leg that no longer exists; renamed `superseded-` so it is not read as a current failure. |
| `logs/superseded-postgres-boundary-rows.json` | 16:20:05 to 16:20:12 | exit 1, `ECONNREFUSED`. Same. |

Every other receipt in the table above runs no object store at all, so the window does not reach
them. G10, G11 and G11a rest on `logs/postgres-journey.json` and are therefore provisional until
that one re-run lands.

**Standing rule observed.** This package has never run `scripts/setup-factory-storage.sh`,
`docker compose ... up`, `docker restart`, or anything that creates, recreates, or restarts the
shared S3 or PostgreSQL services. Its only container commands are against its own pinned image and
its own per-attempt directories: `podman build`, `podman run`, `podman rmi` on its own tag, and
`podman unshare chown`. When a store was down it recorded a named readiness failure and messaged
the coordinator.

## Landed deviations for the coordinator

1. **`StartRequest` gains an optional `materials` directory, and `PodmanRunner` mounts it
   read-write at `/materials`.** This is the byte path no domain pack had. Absent means no mount,
   so no existing caller changes, and every C05 control is unaffected. `GUEST_MATERIALS_PATH` is a
   fixed path rather than an environment variable, because C05 permits a guest exactly three
   declared variables and this is not one of them. Additive, and W11 needs the same thing.
2. **PyArrow is in the committed `src/factory/runner/python/uv.lock`.** Added through `uv lock`, as
   an exact pin. The conformance guest's own closure is unchanged: it still runs the stock
   interpreter image with `pip==25.3` only, because the closure a guest declares is per image and
   this pack's image is its own.
3. **`scripts/python-quality.sh` gains an explicit test-root list and an explicit mypy config
   file.** Discovery is explicit rather than a walk from the project root, because that root also
   holds `.venv`. The `--config-file` is the fix for a nested `[tool.mypy]` section that nothing
   read; it is why the PyArrow override had no effect until it was passed.
4. **`src/factory/runner/python/pyproject.toml` gains a `pyarrow.*` mypy override.** PyArrow ships
   no `py.typed` marker and no stub package exists, so strict mypy cannot follow the import at all.
   The override is scoped to that one distribution; everything this repository writes stays
   strictly typed.
5. **The dataset manifest is `dataset-manifest.json`, not `manifest.json`.** A real publication
   found that `manifest.json` is reserved by the shared S3 adapter for the publication manifest it
   writes last as the publication point, and no member may take it. The two are different
   documents.
6. **`scripts/coverage-thresholds.json` gains nine keys** and **`scripts/check-factory-boundaries.ts`
   gains seven `REQUIRED_SHARED_IMPORTS` rows**, both as required by common.md.
7. **`scripts/factory-reference-data-coverage.sh` is the producer**, rather than a
   `db-postgres.yml` step, because this journey needs a container runtime AND the pinned PyArrow
   image, which is built from the committed lock. It fails closed when the image is absent, which
   is C10's readiness rule rather than a skip.

## One instruction that did not survive contact, and what was done instead

The round's instruction was to "remove the 0o777 chmod (the runner owns the directory mode now)".
The first half is done and the second half does not hold: `runnerMaterialMount` mounts the path and
adds `noexec`, `nosuid` and `nodev`, but it sets no mode and no owner, and `launchDetached` does not
chown it either. Measured against the merged mount, a guest running as uid 65534 cannot write to an
ordinary host-owned directory at all:

```
drwx------ 1001 .../out
/bin/sh: can't create /materials/out/g.txt: Permission denied
```

Removing the handover outright would have shipped a pack whose every guest write fails, and
re-adding 0o777 would have reopened F6. So the handover is KEPT in the form F6 asked for:
`podman unshare chown 65534:0` on the output directory at mode 0o770, which is not world-writable
and not world-readable. If the Terra owner would rather the runner did this, the four lines in
`ReferenceDataGuestDirectory.create` are the whole of it and they should move there, because every
domain pack needs the same thing.

## Interface questions

1. **CLOSED by W02b in `7ac4b261d`.** `RunnerReference` now carries `manifestName` beside the
   scoped `package`, and `releaseFacts()` compares that, so the two no longer have to agree. The
   original finding, kept because it is why the field exists:
   **`FactoryPackagePreparations.releaseFacts` and `validateManifest` cannot both hold.**
   `packages/@ezcorp/extension-contract/src/validation.ts:126` requires a v4 manifest name to match
   `^[a-z][a-z0-9-]{0,63}$`, so no scoped npm name can ever be one;
   `src/factory/package-preparation.ts:84` requires the manifest name to EQUAL the runner
   reference's package, and `references.ts` writes `@ezcorp/reference-data`. A real build breaks
   one of them. This guest keeps the rule a real build enforces and declares `reference-data`;
   W10, W11 and W13 all hit the same wall. An owner has to decide whether the manifest grammar
   widens or the package reference narrows.
2. **The protected reconciliation runs host-side.** C10 names `@ezcorp/reference-data-validator` as
   a separate pinned validator package, and W05's validator-materials machinery dispatches
   validators as attempts. The reconciliation here is a host-side module with its own strict entry
   point, independent of the transform in code and in runtime, but it is not yet dispatched through
   W05. Wiring it needs W05's `bindTaskAttemptInTransaction` and a composition root that does not
   exist on this branch.
3. **The graph's four exports all sit on one package.** `references.ts` puts `snapshotCsv`,
   `parseCsv`, `transformPartition` and `orderedReduce` on `@ezcorp/reference-data`, so they share
   one runtime; this pack makes all four Python, which is consistent and needs no SDK change. If
   the SDK owner would rather split them, that is a domain-graph change and a disclosed checkpoint.

## What is NOT proven here

- No acceptance, approval, or release operation is created. `referenceDataAcceptedPublication`
  emits the accepted candidate W08 asked this pack for, and the publication leg drives W08's real
  profile and provider, but the provenance lookup that reads a release operation is stubbed with
  this journey's real attempt: that row is W09's to write.
- The end-to-end journey through the started application waits on W09's composition, as the brief
  says. Everything above is isolated attempts and product journeys.
