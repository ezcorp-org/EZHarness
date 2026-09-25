# W14 live console, scoped API, and browser journeys

Owner: Sol product. Branch `wp/w14-console` from `integ/w00` at `260855e57`, merged with
`integ/w00` again at `3c4adb144` (documents only) and at `bea254b2a` (W18b). Round-2 head:
`28a720913`, on top of `d6f143ccb`. Evidence: `/tmp/factory-platform-evidence/w14/`.

Files in flight elsewhere are consumed and not edited: `_shared.ts`, `private-service.ts`,
`task-stops.ts`, `orchestration-process.ts`, `pool/process.ts` (W18a-2); `release-declaration.ts`
and the profile composition in `installation-startup.ts` (W09c); the guest broker, the guest SDK,
and the runner result path (W01g).

## What the package delivers

| Area | Where | Proof |
| --- | --- | --- |
| Run inspection read model: nested runs, attempts and iterations, blockers, costs, artifacts and evidence, acceptance reasons, releases; one scoped read, bounded keyset pages | `src/factory/run-inspection.ts` | console suite on PGlite and on PostgreSQL; real journey |
| Snapshot plus contiguous SSE cursor: signed cursor (15 min), 410 past committed, forged cursor 400, authority recheck per batch, revocation closes the stream, 50-event pages, 16 KiB inline payloads | `src/factory/run-events.ts`, `console-tokens.ts`, `_console.ts` | suite; route tests; real journey (forged cursor 400, stream closes drained) |
| Client stream state machine: connecting, live, lagging, catching-up, reconnecting, offline, ended, revoked; duplicates counted, gaps re-read, re-snapshot on 410 | `web/src/lib/factory/run-stream.ts` | unit tests; mock-tier journeys at 1440 and 390 px |
| Package installation, trust, quarantine, revocation, affected-run preview; human session plus tenant administrator; audited | `src/factory/package-admin.ts`, four routes | suite; real journey (bind, review, trust, quarantine preview) |
| Grant administration panel over the existing grant routes | `FactoryAdministration.svelte` | component tests; real journey (grants itself `factory.trust`) |
| Administrator purge request with closing-work preconditions and the audit rows a purge would remove; deletes nothing | `src/factory/purge-requests.ts`, two routes | suite; real journey |
| Artifact tickets (60 s, bound to tenant, project, run, artifact, digest, bytes, principal), attachment download headers, escaped previews, re-encoded rasters, cross-project named-byte shares | `artifact-tickets.ts`, `preview.ts`, `FactoryArtifactPreview.svelte` | suite; real journey (headers, forged ticket 403, share exposes only the named digest) |
| Start a run from the version list, pinned to the exact version, digest, and the caller's current `factory.run` grant revision | `FactoryConsole.svelte`, `client.startRun` | component and mock-tier tests; real journey starts its run through this dialog |
| JSON/YAML/SDK/editor digest parity for the four reference factories plus branch and join; unknown schema versions refused by every path | `round-trip.unit.test.ts` | Vitest |
| Save racing publish on one revision, and both fixed orders; replayed and reused idempotency keys | real journey | `factory-services-console.spec.ts` |
| Reconcile an uncertain release from the inbox (keep uncertain, confirm no effect, attach receipt) | `FactoryReleaseInbox.svelte` | component test; mock journey |
| A definition a newer server wrote is read-only and exportable | `src/factory/definitions.ts`, `FactoryConsole.svelte` | definitions suite; component test; mock and real journeys |
| Event cursor lifetime is an installation setting (`EZCORP_FACTORY_CONSOLE_CURSOR_TTL_MS`, 5 s to 1 h, default 15 min) | `src/factory/console.ts` | `console.test.ts`; the real lane runs at 60 s to prove the 410 |
| Two installations with overlapping identifiers, users, restricted keys, service principals, expiry, revocation, transactional audit failure | `factory-console-suite.ts` | PGlite and PostgreSQL (two isolated databases) |
| The `factory-services` lane: stack launcher, Playwright config, spec, lane manifest, evidence map, CI guard | `web/e2e/factory-services/`, `web/playwright.factory-services.config.ts` | lane tests; real runs below |

Fourteen routes are registered in `src/api-registry.ts`. Six of them are session-only and listed in
`route-contract.test.ts`; their handlers use the existing session guard.

## Rulings applied

- **Route kit (option a).** Merged W18a-2's `c2ef2fac3`. The ten JSON console kinds go through
  `handleFactoryApi` with a registered console dispatcher (`web/src/lib/server/factory/console-dispatch.ts`,
  registered from `hooks.server.ts`). The events stream, downloads, and shared bytes use
  `handleFactoryConsoleRaw`, built on `resolveFactoryPrincipal` and `mappedFactoryError`. My copies
  of principal, request, response, and error handling are gone.
- **One additive route-kit hook (ruling 1, accepted).** `registerFactoryErrorFamily` adds a family to
  the same mapping. It refuses a class that overlaps a registered family, by name, in either
  direction of inheritance; the refusal has its own test.
- **`_shared.ts` edit, as allowed.** The console mutation kinds in `MUTATION_KINDS`. The
  trusted-validator answers (W09d O4) live in the route kit's one error table: a contract naming
  unregistered, unpublished, unprotected, or untrusted material is 422, not an opaque 500.
- **W09d O2.** `GET /projects/:projectId/validator-materials` reads a version's or a lock's
  registered material (the contract a release approval pins, no runtimes). The run inspection
  carries its version's material and the acceptance card shows it.
- **Raw routes in the scope scan.** The accepted entry names the call pair
  (`resolveFactoryPrincipal(event, { scope: "read" })` through `handleFactoryConsoleRaw(event,`), and a
  test pins that exactly the events, download, and shared-artifact routes use it, that each handler
  is only the wrapper, and that the principal and its refusal come before `route.run(`.
- **W15 restore signing: deferred by ruling.** W15 is in round two. I had merged its head and built the
  route and console action; the branch was rebuilt from `a4d12a231` without W15's commits (the
  previously reported head `2a9164c57` is superseded). The prototype is kept at
  `refs/w14/restore-prototype` (parents: this branch at `a4d12a231` and W15 `0fe67b822`) and will be
  rebuilt after W15 lands in integ/w00. `d6f143ccb` superseded `2a9164c57`. When it returns, the
  restore routes are session-only (review L4), the restore journey creates its report through W15's
  production path (M3), and the restore findings reasons wrap instead of ending in an ellipsis.

## Static-review fixes

| Item | Fix | Commit |
| --- | --- | --- |
| H1 | `purge-requests.ts` reads the audit log; its row is in the C13 inventory | `921fbb971` |
| M1 | One tenant-administrator rule (`src/factory/tenant-administrator.ts`); a NULL role or status fails closed | `8e5088906` |
| M2, L1 | One error table in the route kit; an overlapping error family is refused by name | `8dcea65a2` |
| L2, L3 | One keyset cursor helper for grants and run inspection; the console signer states why it is separate (millisecond expiry against an injected clock, a tenant-salted key) | `d89eda0a4` |
| L5 | An unmapped stream failure is logged as an error, a 5xx as a warning | `6b3718e87` |
| L7 | A package reference and a cursor are parsed only after authorization | `7abdd0685` |
| L4, M3 | Apply to the restore routes when W15 lands (above) | waiting |

## Round 2 proof map

Real lane: `web/e2e/factory-services-console.spec.ts` (the `factory-services` lane), run
`journeys-11` at `28a720913` with a clean tree. Suite: `src/__tests__/helpers/factory-console-suite.ts`
on PGlite (`src/factory/console.integration.test.ts`) and on PostgreSQL
(`tests/postgres/factory-console.test.ts`). "Waiting" names the package that must land first.

1. **Uncertain release: UI and action.** Done in the console; the real proof waits.
   The inbox shows a reconcile form for `release_uncertain` (keep uncertain, confirm no effect,
   attach receipt) and calls the release reconcile route. Proof: `FactoryReleaseInbox.component.test.ts`
   and the mock journey in `factory-authoring-console.spec.ts`. Real lane: waits on W01g (no real run
   produces a completed candidate, so no real release exists) and on W09c (the web process composes
   no release operations, so the web inbox answers 503 "Release services are not ready").
2. **Repair, replan, and approval actions.** Partly real.
   Real lane, "a run waiting on an approval streams live, shows the approval blocker, and a revoked
   reader's stream closes as revoked": a published approval definition creates a pending approval,
   the console shows the live run and the approval blocker. The decision waits on W09c (same 503).
   Repair and replan wait on W01g (they need a rejected candidate).
3. **Deterministic idempotency, both orders.** Real lane, "a save racing a publish leaves one
   consistent winner; in either fixed order a replayed key answers the same and a reused key is
   refused": save then publish, and publish then save, each with a replayed key (same answer) and a
   reused key with other bytes (409).
4. **Unknown versions are read-only and exportable.** Real lane, "a draft a newer server wrote opens
   read-only in the console and still exports its exact bytes". The stack rewrites the stored draft
   as `factory.v9` (a stated deployment fact). Also the definitions suite (read refused with
   `factory_definition_version_unsupported`, validate gives a schema diagnostic, export gives the
   exact bytes, a stranger's export is forbidden) and `FactoryConsole.component.test.ts`.
5. **Transactional audit failure.** Suite, PGlite and PostgreSQL: "a failed audit write rolls back a
   purge request and a share, and leaves no receipt"; the trust-publish audit failure is inside
   "install, preview, publish, quarantine, and revoke run through W02's fence with exact revisions".
   A database trigger rejects the audit insert; the real lane has no fault hook, so this stays at the
   service level on the real PostgreSQL store.
6. **Grant revocation and expiry.** Real lane, "grant expiry and revocation take effect on the next
   request, and a download ticket rechecks them": an 8-second grant stops at expiry; a console
   re-grant and revoke take effect on the next request.
7. **Download and cached-reply rechecks.** Real lane: the same test, a ticket minted while the
   grant held is refused once the grant expires. Suite: "a download and a cached reply recheck current authority;
   neither is served from the past" (a cached share or unshare reply is not replayed to another
   principal).
8. **Release authority does not transfer across a share.** Real lane, "the scoped API: tickets,
   download headers, a read-only key, a service credential, and a named share": the reader of the
   target project reads the named bytes; the source run's inspection, a download ticket, release
   trust, and validator materials are refused. Suite: "a read-sharing grant carries no release authority and no other access to the
   source".
9. **Two installations.** Service level, by ruling, until W16: "an installation with the same
   identifiers sees only its own rows" on two isolated databases.
10. **SSE 410, gaps and catch-up, lag, revocation mid-stream.** Real lane, "a run started from the
    version list is watched live to a terminal status with its attempts, costs, and evidence": a
    cursor from the first snapshot catches up after the run ends, contiguous with no duplicates, and
    the same cursor past its 60-second lifetime is 410. The approval test: a reader's stream closes
    with `{"reason":"revoked"}` when its grant is revoked mid-stream. Lag and gap repair are proven in
    `run-stream.unit.test.ts` and the mock tier; the real lane has no hook to hold the projector back.
11. **Console errors, dark theme, long labels, large map.** Real lane: every journey fails on a
    console error (`afterEach` guard), and "long labels and a large map read cleanly at 1440 and
    390 px, in light and dark" renders a 40-node map with long labels, checked by the layout
    overflow helper, which now also fails a clipped or off-screen view tab.
12. **Validator-materials GET.** Real lane, the scoped API test: 404 for an unregistered version,
    400 for a bad query, 403 for a reader. No production path registers material, so the 200 is
    proven in `tests/postgres/factory-validator-materials.test.ts` only.
13. **Purge preconditions and quarantine commit.** Waiting. Purge preconditions for W15 and W16
    wait on those packages; the real quarantine commit waits on W02c `af25914d3` (then
    `createFactoryPackageTrusts` and `FactoryPackageFence`).

Validator items: (1) the run journey asserts `failed` with `FACTORY_RUN_FAILED` / `RUNNER_CANCELLED`,
disclosed as expected until W01g's result path lands; (2) the preview journey compares the rendered
text with the bytes a ticket downloads; (3) the 390 px tab rail shows all four tabs (`6fa08d72b`), and the layout check fails a clipped or off-screen tab,
and the restore findings ellipsis is fixed with the restore work after W15; (4) every receipt above
is at a clean committed head.

## Round 3, items that need no merge (validator ACCEPT-WITH-FIXES on round 2)

Code head `754d7b29b`. Real lane `journeys-13`: 11 of 11 at a clean head. Sweep `sweep-10` at the same
head: every W14 check passes; patch coverage has 0 uncovered W14 lines (the 4 W18a-2 files remain).

- **F1, the graph canvas ignored the app theme** (`281ba1dc6`, `754d7b29b`). `FactoryGraph.svelte` used
  `colorMode="system"`. The canvas now follows the app's `.dark` class through
  `web/src/lib/factory/document-theme.ts`, draws with the app's tokens, and its first view never zooms
  below 0.8, so labels render at 11 px or more. Proof: the real-lane journey "long labels and a large map
  read cleanly at 1440 and 390 px, in light and dark" now runs all four pairs and fails on
  `factoryGraphProblems` (canvas theme, controls, minimap, and grid brightness, label size, read from the
  rendered page). The mock tier runs the same check with the system scheme opposite the app theme; against
  the old graph file all four fail (canvas theme, controls, minimap, grid, labels at 7.1 px), and with the
  fix all four pass (`logs/r3-theme-*.log`).
- **F2, todo checkboxes** (`62e2a3305`). The purge, console-UI, and two-installation items are unchecked
  and name what they wait on (items 13, 1 and 2, and 9).
- **F3, run-format mutants died only by timeout** (`c0f087368`). `run-format.unit.test.ts` pins every
  label, plural, boundary, and grouping exactly. Focused Stryker on `run-format.ts`:

  | Head | Score | Killed | Timeout | Survived |
  | --- | --- | --- | --- | --- |
  | Before, `281ba1dc6` | 91.86% | 19 | 60 | 7 |
  | After, `754d7b29b` | 97.98% | 97 | 0 | 2 |

  The two survivors are equivalent (`<` against `<=` at an edge where both branches return 0). The whole
  mutation gate at `754d7b29b` is 94.08%; `run-stream.ts` still has 97 of its 316 mutants caught only by
  timeout (a stream loop that hangs when mutated), so the overall score moves with host load.
- **F4, the narrow run strip showed a different run from the inspector** (`c0f087368`). The selected card
  is scrolled into the strip by the least distance (`horizontalRevealOffset`, unit-tested; component test
  with laid-out positions). Seen in `journeys-13` at 390 px dark.

Cross-owner findings, closed by the coordinator: validator material registration exists at integ/w00
`873b04759` (my base predated it); a revoked share that cannot be granted again, and the grants panel's
missing display names, go to W04b. W14 consumes the W04b API when it lands.

Housekeeping: `podman image prune -f` runs after every lane build; the lane tags no image of its own
(image lists before and after `journeys-12` are identical). One leftover test database from a failed
restore proof, `factory_services_product_1790204490942_e8f74f`, remains on the shared PostgreSQL:
the permission layer refused my drop, and the coordinator surfaced it to the user.

## Round 3, part 2 (worker w14-continue, 2026-09-25)

Base: branch at `46237000f` (round 3 part 1 plus the restore port). Merged integ/w00 `2b2e12550` as
`2252e5a39`. Final code head `4b96f6f77`; the documents follow it. Evidence:
`/tmp/factory-platform-evidence/w14/` (`receipts/` holds one JSON receipt per leg at the code head).

Carried over: `journeys-14` (12 of 12) and `sweep-11` (every leg exit 0) at `46237000f`, both clean.
Author check: every branch commit after integ/w00 is archy's. `754d7b29b` (fixture identity) was
rewritten by the 2026-09-24 04:02 reset-author rebase to `5ea00bea8`, and `ba47466e0` to `dabed0733`;
both pairs have identical trees (`4aba010`, `60b6847`).

Merge hunks (`2252e5a39`), each keeping both sides: the SDK export lists (W14 console types and W01g
guest-material names); `installation-startup.ts` application (W14 `restoreSigner` and W09c's composed
release routes); `evidence-covers.json`; `tasks/todo.md`; and the package-preparation suite, where
integ's general `factoryPackageRelease(runner, …)` replaced W14's narrower helper. W04b made
`displayName` required on a grant resource, so W14's grant fixtures name one.

- [x] G-R3b-1: W02c. The console composes `createFactoryPackageTrusts`, so a quarantine or revocation
  cancels every run with a live attempt on the package in the decision's transaction. The preview
  counts live attempts with the fence's own query and lists a run the fence reaches even when its lock
  does not name the package. `GET …/packages/{referenceId}/affected-runs` serves the sealed record
  (read scope, keyset pages, trust-revision filter, authority before the cursor), and the
  administration panel shows it after a commit.
  CHECK: console suite on PGlite and PostgreSQL; route and component tests; real journey 7.
  EXPECT: suites pass; real journey 7 commits a quarantine under a held live attempt, shows one
  "cancel requested" row, reads the same record over the API, and lifts it at revision 3.
  EVIDENCE: `receipts/bun-console-integration.json`, `receipts/bun-pg-console.json`,
  `receipts/web-vitest.json`, `receipts/real-lane.json` (`journeys-26.json`).
- [x] G-R3b-2: W04b. The grants panel names each grantee by display name, with the kind and
  identifier on their own line. EVIDENCE: `receipts/web-vitest.json`, real captures.
- [x] G-R3b-3: W09c. The web process composes command approvals beside W09c's release operations
  (`factoryCommandApprovals`). The installation's release store now carries the command-approval
  authority; without it one approval-node notification made `GET …/release/notifications` refuse
  for everyone (reproduced in `journeys-22`, fixed in `c5b14cb49`). Real journey 5 approves a release
  in the console inbox; real journey 8 denies an approval node there.
  EVIDENCE: `receipts/bun-installation-startup.json`, `receipts/real-lane.json`.
- [x] G-R3b-4: W01g and W09d. The lane guest stages its bytes with the shipped staging client and
  completes; the declared validator (the same release pinned with a configuration digest, bound and
  trusted in the console) answers PASS. Real journey 5: the run is accepted, the approver consents in
  the inbox, the running release-outcome role publishes, and the run ends `succeeded`. The stack
  removes every object version the release published under its per-run prefix when it stops.
  EVIDENCE: `receipts/real-lane.json`.
- [x] G-R3b-5: `run-stream.ts`. A strict harness (scripted snapshots and opens, violation on a read
  past the end, a two-second deadline) with exact state, cursor, sleep and lock assertions; the default
  sleep with fake timers. EVIDENCE: `receipts/web-vitest.json`. The mutation score cannot be measured
  on this toolchain (finding below).
- [x] G-R3b-6: Final passes at the code head, every leg a receipt. EVIDENCE: `receipts/*.json`.

Console changes found by the real captures and fixed: a pin's configuration no longer hides its trust
revision; two pins of one package are told apart in the row and its actions; the install form binds an
optional model and configuration digest; an approval node's declared choices are neutral buttons; the
fence record wraps at 390 px; a grant's revoke button stays on its row at 390 px.

### Final passes at `4b96f6f77` (clean; `final-13/`, receipts in `receipts/`)

| Leg | Result |
| --- | --- |
| Builds (six packages), lint, typecheck, factory boundaries, gate integrity, schema drift | exit 0 |
| SDK tests | 226 pass |
| Console suite, PGlite and PostgreSQL | 22 and 22 pass; console unit 3 |
| Package fence, PGlite and PostgreSQL | 17 and 17 pass |
| Package preparation, PGlite and PostgreSQL | 22 and 22 pass |
| Installation startup; startup config | 51; 45 pass |
| Run lifecycle, PGlite and PostgreSQL | 73 and 73 pass |
| Definitions, PGlite and PostgreSQL; PostgreSQL restore | 11 and 12; 13 pass |
| Validator materials, PGlite and PostgreSQL | 10 and 10 pass |
| Process boundaries (`factory-process-boundaries.test.ts`); boundaries script test | 15; 31 pass |
| Application, attempt composition, keyset cursor, tenant administrator, grants, service credentials, scope, session scope, API docs, OpenAPI, route contract, lanes, evidence map, C13 inventory | all pass |
| Svelte check; web Vitest pool under coverage; its coverage check | 0 errors; 7741 pass; pass |
| Factory mock browser specs under Chromium coverage | 24 pass |
| Real `factory-services` lane | 12 of 12 (`journeys-26`) |
| New-file coverage and patch coverage, BASE_REF=`2b2e12550` | pass (no uncovered changed line) |
| Mutation, report-only | 11.49% (tooling finding below) |

### Findings for other owners
- **Mutation tooling (main).** Since `96e7ee58c` (Vitest 4.1.11 to 5.0.0) Stryker runs almost no tests
  per mutant. The control pass on `run-format.ts` scored 97.98% at `46237000f` (97 killed, 2
  survived) and 64.65% on the merged tree (9 killed, 55 timeouts, 35 survivors). The sweep's
  report-only gate under the heavy lock scored 11.49% with 0.16 tests per mutant. CI's report-only
  mode hides this. Evidence: `logs/mutation-run-format-control.log`, `final-13/mutation.log`.
- **Denied approval never ends the run (W03 stop path).** After the console's denial the approval
  blocker clears and projection lag is 0, but the run stays `running`. Replaying the definition through
  the kernel: a denial moves the run to `stopping` with a `cancel-node` for the gate, and the stop of a
  control node, which has no attempt, does not settle in the real stack. Evidence:
  `logs/kernel-definitions-check.log`, `journeys-24.json`.
- **Quarantined live attempt stays cancelling (W02c/W03, known).** The fenced run's usage hold stays
  unresolved (`factory_usage_hold_unresolved: no-operation-receipt`) and the host refuses the stop
  (HTTP 500 `stop_failed`), as W02c disclosed.

### Open
- **W16.** Two HTTP installations and the W16 purge preconditions wait until W16 lands in integ/w00.
- **Repair, replan, and a real uncertain release.** They need a rejected candidate or an uncertain
  provider outcome; the lane has no fault hook for either. They stay proven in components and the mock
  tier.
- **User decisions.** Two databases a failed stack kept for diagnosis remain on the shared
  PostgreSQL: `factory_services_product_1790204490942_e8f74f` (round 3) and
  `factory_services_product_1790299766758_3b88ee` (`journeys-15`). The permission layer refused the drop.

## Decisions and assumptions

- **The lane needs the Temporal CLI dev server.** The Java test server cannot report task-queue
  pollers, so the orchestrator never reports ready on it (an orchestrator test asserts exactly
  this). The CI job and the collector now require `FACTORY_TEMPORAL_CLI`; the provisioning document
  names the secret. Nothing was provisioned.
- **Package preparation is a stated deployment fact.** No product route or role prepares a trusted
  package. The stack prepares it with the product's own classes after the console trusts it.
- **Quarantine does not fence live attempts.** W02 constructs no quarantine fence, so the preview
  counts live attempts and the transition records the state; it stops nothing.
- **Purge preconditions are closing-work checks only.** W15 and W16 are not on this branch.
- **Two installations are proven at the service level.** One database holds one installation, so
  the proof uses two isolated databases, not two HTTP servers.
- **W02 audit action fixed.** Trust transitions recorded `factory.package.trust.publishd`; they
  now record `published`, `quarantined`, and `revoked`.

## Real-stack journeys

The committed launcher `web/e2e/factory-services/stack.ts` boots the built web server, pool
admission, the host supervisor with Podman, the Temporal CLI dev server behind a mutual-TLS
terminator, and the Node orchestrator, over the shared PostgreSQL and S3 stores. Run `journeys-11`
at `28a720913`, clean: 11 passed, 0 failed (receipts `logs/journeys-11-*`, `journeys-11.json`).
The proof map above names the journey for each round-2 item.

Earlier runs found and fixed: the stack root under `/tmp`, the setup password policy, the
service-credential setup, a stale "queued" run row, a "not yet" note on a finished run, cramped
390 px run cards, a spaced-out purge count, a 500 for an unavailable shared artifact after the
route-kit move, the 390 px tab rail that clipped "Administration", a lone run card that left an
empty band at 390 px, a purge caption that showed the tenant identifier in capitals, and an
evidence capture that waited without bound on a page holding a live stream.

## Mutation (web/src/lib/factory/*, web/src/lib/graph/layout.ts, threshold 80)

| | Score | Scope |
| --- | --- | --- |
| Before, at `260855e57` | 79.74% | client 79.60, download 30.77, layout 68.63, model 83.02 |
| After, at `28a720913` | 95.60% | client 97.67, download 100, layout 98.04, model 98.92, preview 98.44, run-format 93.02, run-stream 88.29, workspace-view 91.67 |

## Final sweep

Receipts: `sweep-8/receipts.txt`, every step at `28a720913` with a clean tree.

| Check | Result |
| --- | --- |
| Lint, typecheck, test typecheck, factory boundaries, gate integrity | pass |
| SDK build and SDK tests | pass (196) |
| Console suite, PGlite and PostgreSQL | 20 and 20 pass |
| Definitions suite, PGlite and PostgreSQL | 11 and 12 pass |
| PostgreSQL package preparation and validator materials | 22 and 10 pass |
| Run lifecycle, application, attempt composition, scope and session scans, API docs, OpenAPI, route contract, lanes, evidence, keyset cursor, tenant administrator, grants, service credentials, C13 inventory | pass |
| Web check (svelte-check) | 0 errors, 0 warnings |
| Web Vitest pool under coverage | 7658 pass in 613 files; web Vitest coverage check passes |
| Factory mock browser specs under Chromium coverage | 20 pass |
| Real-stack `factory-services` lane | 11 pass (`journeys-11`) |
| Mutation | 95.60% (before 79.74%) |
| New-file coverage, BASE_REF=integ/w00 | pass |
| Patch coverage, BASE_REF=integ/w00 | 0 uncovered W14 lines; 4 W18a-2 files from the route-kit merge lack their producers in this focused run (`sweep-8/patch-partition.txt`) |

The partition diffs against `refs/w14/patch-base` (integ/w00 merged with `c2ef2fac3`), so only
lines W14 changed count as W14's.

## Open

Round 3 part 2 closed the W15, W02c, W09c, and W01g items that were open here. What remains is listed
under "Round 3, part 2" above: W16, repair and replan with a real rejected candidate, a real uncertain
release, and the findings for other owners.
- The lane needs `FACTORY_TEMPORAL_CLI` on the `factory-real` runner; nothing was provisioned.
