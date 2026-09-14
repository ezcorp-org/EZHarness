# W04a validation report — independent archive writer and publication readiness

**Verdict: ACCEPT**

Worktree: `/home/dev/work/EZCorp/EZHarness-worktrees/composable-factory-platform/.worktrees/w04a-archive`
Branch: `wp/w04a-archive-writer`, HEAD `11ef485046e7ff76247fbabe6161f277b577063f`, clean tree (`git status --porcelain` empty).
`git log --oneline integ/w00..HEAD` shows exactly the 10 commits the worker's report names, in the same order. `git merge-base integ/w00 HEAD` is `37f2ed3f9`, which is one commit behind `integ/w00`'s current tip `e32d49196` (see "Interface conformance" below for what that one commit is and why it does not matter).

## 1. Rerun results table

Every command below was run independently in the worker's worktree, not read off their receipts, using `PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH` and the real PostgreSQL/S3 environment from `common.md`. Full logs are under `/tmp/factory-platform-evidence/w04a-validation/receipts/`.

| Gate | Command | Exit | Result | Matches worker's claim? |
| --- | --- | --- | --- | --- |
| typecheck | `bun run typecheck` | 0 | clean | yes |
| lint | `bun run lint` | 0 | 8 pre-existing infos (unrelated `web/` files), 0 errors | yes |
| boundaries | `bun scripts/check-factory-boundaries.ts` | 0 | "Factory boundary checks passed" | yes |
| gate-integrity | `bun scripts/gate-integrity.ts` | 0 | "Gate integrity PASSED" | yes |
| G1 unit | `bun test --timeout 30000 ./src/factory/archive-writer.test.ts` | 0 | 12 pass, 0 fail, 100 expect | yes, exact |
| G3/G4/G5/G14 integration (PGlite) | `bun test --timeout 120000 --coverage ./src/factory/archive-writer.integration.test.ts` | 0 | 10 pass, 0 fail, 78 expect | yes, exact |
| G10 registration | `bun test --timeout 30000 ./scripts/factory-postgres-suite-registration.test.ts` | 0 | 5 pass, 0 fail, 17 expect | yes, exact |
| G7 real PostgreSQL/S3 | `flock ... bun test --timeout 300000 --coverage ./tests/postgres/factory-archive-writer.test.ts` | 0 | 10 pass, 0 fail, 78 expect | yes, exact |
| G13 (13-file batch, incl. `factory-releases.test.ts`, `factory-release-authority.test.ts`) | `flock ...` | 0 | 160 pass, 0 fail, 1470 expect | superset of worker's 159/1458 — see note below |
| G13 (2-file batch: `factory-private-service`, `factory-package-preparation`) | `flock ...` | 0 | 19 pass, 0 fail, 133 expect | yes, exact |
| G6/G8/G9 real SeaweedFS proof | `flock /tmp/ezcorp-validation-heavy.lock bun scripts/verify-factory-archive-writer.ts` | 0 | see below | yes, structurally byte-for-byte |
| final-focused replication (10 files) | `bun test --timeout 120000 --coverage <archive-writer x2, release-adapters, releases.integration, artifact-materials, check-factory-boundaries, factory-c13-inventory, factory-postgres-suite-registration, factory-ci-registration, gate-scripts>` | 0 | 300 pass, 0 fail, 1417 expect | yes, exact |
| new-file coverage | `BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts` (own merged LCOV) | 0 | "1 new source file(s) gated" | yes |
| patch coverage | `BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts` (own merged LCOV) | 0 | "all changed executable lines covered (2 file(s))" | yes |
| line coverage of `src/factory/archive-writer.ts` | read from own merged `coverage/lcov.info` | — | `LF:257`, `LH:257` | yes, exact (257/257) |

**The real SeaweedFS proof** (`scripts/verify-factory-archive-writer.ts`) is the most consequential rerun: it stops the shared `factory-storage-ordinary` compose service, proves the archive answers and product settlement is blocked, then restarts it. My independent run produced:

```
tenants: 10, readinessPasses: 10, refusedAttempts: 130, refusalStatuses: {"403": 130}
failureDomain: "same-host-not-independent", deployedIndependenceProven: false
archiveReadableWhileProductStoreDown: true, productSettlementBlockedWith: "Error: ECONNREFUSED"
productSettlementResumed: true
```

This matches the worker's `/tmp/factory-platform-evidence/w04a/archive-writer-real.json` field for field (only `testedAt` differs). After the run I confirmed via `docker compose ... ps` that `factory-storage-ordinary` was healthy again, restarted about 31 seconds earlier — the script correctly restored the shared infrastructure it took down, so no other agent on this host was left without the ordinary S3 service.

**G13 count note:** my 13-file batch shows 160 pass / 1470 expect against the worker's receipt of 159/1458. The worker's G13 receipts were pinned to commit `213b6f076` ("that commit already carried the helper change, and no later commit touches it"); two later commits (`8f5f8e633`, `db01ad2b3`) added test cases to `factory-archive-writer.test.ts` itself, which is one of the 13 files in that batch. Re-running the same file list at HEAD naturally picks up those additional cases. This is expected drift, not a discrepancy in the helper the gate is actually about.

**Coverage methodology note:** my first coverage merge (unit + integration + postgres LCOV only) produced a false `patch-coverage` failure on `scripts/check-factory-boundaries.ts`, because I had not included that pre-existing file's own test (`scripts/check-factory-boundaries.test.ts`) in my merge set. The worker's "final-focused" batch already included it. Adding it to my merge resolved the failure cleanly (257/257 on `archive-writer.ts`, both gates PASSED). This was a gap in my first rerun, not a defect in the delivered work.

## 2. Plan-bullet proof map (plan section 5, W04a)

| Plan bullet | Test(s) | Status |
| --- | --- | --- |
| Compose the archive adapter as the gateway's archive-writer role with separate credentials and a verified independent failure domain; test conditional create, checksum, version reads, access restrictions, loss of the ordinary store | `src/factory/archive-writer.ts:335-497` (`FactoryArchiveWriter`); G1, G7, G8, G9 | Proven, **except** "verified independent failure domain," which the package itself states is unmet on this host — see below |
| Before a dispatch claim, archive the recovery intent plus every candidate/evidence/request object and verify readability; publication stays pending when any member is unavailable or corrupt | `factory-archive-writer-suite.ts:215-268` ("the archive holds every referenced member...", "publication stays pending while a member is unavailable... and resumes when it returns", "...reads back different bytes") | Proven, with real controlled faults (a genuine DB row deletion of a material chunk, and `FaultInjectingArchive` byte substitution) |
| After a confirmed provider effect, archive the receipt before product settlement or orchestration notification; crash at each boundary and recover the same operation by identity | `factory-archive-writer-suite.ts:270-406` (crash-at-each-boundary object counts 1/4/5/6/6; receipt-before-settlement; crash between provider effect and receipt archive; lost provider response; foreign-generation receipt rejection) | Proven, with a real Postgres trigger simulating a crash at the commit boundary (`rejectAudit`) and archive-write fault injection (`failWriteFor`) |
| Prove normal product and restore credentials cannot overwrite/delete the archive; record deployed-independence evidence honestly | `scripts/verify-factory-archive-writer.ts` live run | Proven: 130 refused attempts, **all HTTP 403** (not 404s that would merely prove absence), across all 10 tenant identities plus one cross-tenant denial per tenant |

The one **unproven-and-explicitly-labeled-as-such** item is "deployed-independent failure domain." The package's own `FACTORY_ARCHIVE_DEPLOYED_INDEPENDENCE` constant, the `factoryArchiveFailureDomain()` classifier (`archive-writer.ts:203-224`), the live run, and `tasks/factory/w04a-GATES.md`'s opening section all agree: `failureDomain: "same-host-not-independent"`, `deployedIndependenceProven: false`. This is exactly what the plan's pass criteria permit ("If an independent store is unavailable, continue code and isolated adapter tests and record the resulting end-to-end milestone blocker").

## 3. Interface conformance

- **Consumed exactly:** `FactoryScopedArtifactReader.read(scope, artifactReference, signal?)` at `archive-writer.ts:376`; `FactoryArtifactReference`, `assertFactoryArtifactReference`, `snapshotFactoryMaterialScope` from W04's `artifact-materials.ts` (all pre-existing exports, none added by this package); `FactoryReleaseArchive`, `FactoryArchiveObject`, `FactoryProviderReceipt`, `FactoryReleaseOperation`, `FactoryReleaseProvider`, `FactoryReleaseMaterial` from W07's `releases.ts` (implemented/read, never redefined).
- **No modification found** of `src/factory/artifact-materials.ts`, `src/factory/releases.ts`, `src/factory/release-adapters.ts`, or `src/factory/grants.ts` (`git diff integ/w00..HEAD` empty for all four). I independently confirmed the exact `releases.ts` behavior the report cites: `prepare()` archives intent then material before setting `archive_ready = TRUE` (`releases.ts:439-446`), `claim()` refuses without it (`:491`), and `dispatch()`/`reconcile()` archive the receipt before settling the product row (`:526-528`, `:551-552`).
- **Shared registries touched additively only**, matching the plan's established "append your row, coordinator merges" pattern: one `REQUIRED_SHARED_IMPORTS` row in `scripts/check-factory-boundaries.ts`, one key in `scripts/coverage-thresholds.json`, one line in `.github/workflows/db-postgres.yml`.
- **One deviation found**, low severity: `git diff integ/w00..HEAD` on `docs/plans/2026-09-13-composable-factory-platform-interfaces.md` shows one line "removed" — a W01/W02 "guest control-channel shim" addendum under section 16. Root cause: the branch's merge-base with `integ/w00` (`37f2ed3f9`) is one commit behind `integ/w00`'s current tip (`e32d49196`), and that tip commit is a docs-only, single-line addition unrelated to W04a. This is a stale-branch artifact of when the branch last fast-forwarded, not content the worker deleted; a plain merge/rebase onto `integ/w00` restores the line with no conflict. Worth the coordinator's attention before final integration, not a defect in this package.

## 4. Gate integrity and DRY

No `.skip`/`.only`/`.todo`, no assertion-free tests, no empty `catch {}` in any touched test file (checked with a Python-based scan across all 8 touched test/source files after a grep hiccup in my shell gave an inconsistent one-off result — the Python scan is authoritative and clean). The lone `Bun.sleep(250)` (in `scripts/verify-factory-archive-writer.ts`'s `waitForRead`) is a bounded poll-until-real-read-succeeds loop after restarting a real service, not a fixed-sleep-as-proof. All tests pin time via a frozen `now: () => 1_700_000_000_000` or compare identities/counts; no wall-clock assertions found. No duplicate inventory/queue/approval/blob/audit implementation exists elsewhere in `src/factory` — `S3FactoryArchiveInventory` is the only class named `*Inventory` in the tree. No credential values appear anywhere in the diff or in `/tmp/factory-platform-evidence/w04a`; only field names and obviously-fake test placeholders (`"archive-id"`/`"archive-secret"`).

## 5. Negative-path depth (team lead's item b)

- **Archive-before-claim** (dispatch impossible while any member is unavailable or corrupt): `src/__tests__/helpers/factory-archive-writer-suite.ts:235-257` deletes a real `factory_artifact_material_chunks` row to make a member genuinely unavailable, and confirms `claim()` is refused (`factory_release_not_claimable`) even when presented with an approval ID that was never issued — i.e., the archive check runs before any consent check. Lines 259-268 corrupt a member's read-back bytes via `FaultInjectingArchive.corruptReadFor` and prove the same refusal, then recovery once the fault clears.
- **Receipt-before-settlement** (crash after the provider effect but before the archive write, recovered by identity without a second dispatch): `factory-archive-writer-suite.ts:305-341` uses a real Postgres trigger (`rejectAudit`) to reject the settlement transaction's audit insert after the receipt has already reached the archive, proving `world.provider.publishes` stays at 1 through the crash and through recovery, and that the archive precedes the orchestration outbox (`["release_uncertain"]` before recovery, `["release_uncertain","release_settled"]` after). Lines 343-368 cover the complementary case — a crash **before** the receipt reaches the archive at all (`failWriteFor = "providerReceiptId"`) — where recovery correctly refuses (`no_archived_receipt`) rather than inventing a settlement, and an operator must reconcile by hand. Lines 383-406 prove a receipt naming any other generation/operation/request/object/account/provider is never used to settle.

Both properties are demonstrated with genuine, targeted faults (a real DB delete, a real Postgres trigger, byte-substring fault injection keyed to specific archive payloads) rather than a stub that always succeeds or always fails.

## 6. Security posture

No credential values in logs, receipts, or code (checked the diff and the full `/tmp/factory-platform-evidence/w04a` tree). No authority check was removed — `releases.ts` is untouched. Access restriction is proven live: 130 refused attempts across all 10 tenant identities, every one an HTTP 403 (an authorization denial, distinguishable from a 404 that would only prove absence), plus a cross-tenant archive-credential denial per tenant.

## 7. Interface questions — assessment (team lead's item i)

1. **"Member objects share the archive name `material`."** Not a real defect. `releases.ts`'s `writeImmutable` name union is W07's surface and correctly untouched; content-addressing means members, the manifest, and the outer material object never collide (verified in `archive-writer.test.ts:135-159`). Severity: low, naming clarity only, resolvable unilaterally by W07 if desired.
2. **"A release operation carries no attempt id, but a material scope needs one."** Real gap, but correctly out of this package's scope. It is composition's job (whoever supplies `factoryArchivePublicationSet`'s resolver — W07, W08, or W09) to produce that mapping. Severity: medium — real production releases cannot archive real members until someone supplies it — but the seam `FactoryArchivePublicationSet` is sound and this package cannot close it without inventing a mapping the plan does not give it authority over.
3. **"`reconcile()` still performs provider I/O and archive writes inside an open transaction (`releases.ts:541,545,549,552`)."** Confirmed still true at HEAD by direct inspection. This is a real, pre-existing violation of the interface freeze's own stated invariant ("No provider network I/O inside a transaction. This is violated today"), already recorded there and assigned to W07. `FactoryArchiveRecovery.recover()` calls `releases.reconcile()`, so it inherits this lock-hygiene/latency risk, though no correctness failure was demonstrated in testing. Severity: medium, but it predates this branch and is squarely W07's file to fix.

## 8. Overstatements found

`tasks/factory/w04a-GATES.md`'s G13 describes the fifteen `tests/postgres/factory-*` suites in that rerun as ones that "use the shared PostgreSQL storage helper." Two of the fifteen — `factory-releases.test.ts` and `factory-release-authority.test.ts` — do not import `tests/postgres/helpers/factory-storage.ts` at all (confirmed by direct inspection of their imports). The extra breadth is harmless — it is more verification of release-path suites, not less — but the gate's own description overclaims what property justifies including those two files.

## 9. Conclusion

Every reproducible, numeric claim in the worker's report and gate file was independently reproduced, including one live rerun that stops and restarts a shared piece of infrastructure and reproduces the worker's JSON output structurally exactly. Static gates (typecheck, lint, boundaries, gate-integrity) are clean. Coverage gates pass under an independently assembled merged LCOV, with `src/factory/archive-writer.ts` at 257/257 lines. The two required ordering properties are proven with genuine controlled faults, not stubs. No out-of-scope file was modified; the one interface-freeze-doc deviation found is a stale-branch artifact that resolves on a plain merge. The failure-domain honesty requirement — the single most important non-functional property this package had to get right — holds at every layer: the type definitions, the classifier's refusal to overclaim, the tests, the live run, and the gate file's prose all agree that this host proves credential separation only.

Findings are limited to two low-severity documentation notes (the G13 wording, and the stale merge-base) and two already-disclosed, correctly-out-of-scope interface gaps for other packages (W07/W08/W09) to close. None require a change to this package before integration.

**Verdict: ACCEPT.**
