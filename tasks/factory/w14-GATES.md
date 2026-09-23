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

- **W15.** Restore signing, its console action, the restore findings wrap, L4, and M3 wait for W15
  in integ/w00 (prototype at `refs/w14/restore-prototype`). Purge preconditions for W15 and W16 too.
- **W02c.** After `af25914d3` lands: `createFactoryPackageTrusts` in `console.ts`,
  `FactoryPackageFence` for previews, and a real quarantine commit in the real lane.
- **W09c.** The web process composes neither command approvals nor release operations, so the web
  inbox answers 503 "Release services are not ready". Approval decisions and release reconciliation
  are proven in components and the mock tier until then.
- **W01g.** No real run yet produces a completed candidate. The run journey asserts the disclosed
  `failed` / `RUNNER_CANCELLED` state; repair, replan, and a real uncertain release follow W01g.
- **W16.** Two installations are proven at the service level on two databases, by ruling.
- **Findings for other owners.** No production path registers validator material (only tests do).
  A revoked artifact share cannot be granted again (`factory_artifact_grant_conflict`, W04). No
  product route or role prepares a trusted package; the stack prepares it as a stated deployment
  fact. The grants panel names users by identifier, because the grant API returns no display name.
- The lane needs `FACTORY_TEMPORAL_CLI` on the `factory-real` runner; nothing was provisioned.
- The integ/w00-based patch gate flags four W18a-2 files whose producers are W18a-2's.
