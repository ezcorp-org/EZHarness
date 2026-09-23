# W14 live console, scoped API, and browser journeys

Owner: Sol product. Branch `wp/w14-console` from `integ/w00` at `260855e57`, merged with
`integ/w00` again at `3c4adb144` (documents only). Evidence: `/tmp/factory-platform-evidence/w14/`.

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
| Save racing publish on one revision; replayed and reused idempotency keys | real journey | `factory-services-console.spec.ts` |
| Two installations with overlapping identifiers, users, restricted keys, service principals, expiry, revocation, transactional audit failure | `factory-console-suite.ts` | PGlite and PostgreSQL (two isolated databases) |
| The `factory-services` lane: stack launcher, Playwright config, spec, lane manifest, evidence map, CI guard | `web/e2e/factory-services/`, `web/playwright.factory-services.config.ts` | lane tests; real runs below |

| Coordinator items after the first report | see "Rulings applied" | route tests, suites, real journey |

Thirteen routes are registered in `src/api-registry.ts`. Six session-only routes are listed in
`route-contract.test.ts`, and `handleFactoryConsoleSessionApi(` is a recognised session guard.

## Rulings applied

- **Route kit (option a).** Merged W18a-2's `c2ef2fac3`. The ten JSON console kinds go through
  `handleFactoryApi` with a registered console dispatcher (`web/src/lib/server/factory/console-dispatch.ts`,
  registered from `hooks.server.ts`). The events stream, downloads, and shared bytes use
  `handleFactoryConsoleRaw`, built on `resolveFactoryPrincipal` and `mappedFactoryError`. My copies
  of principal, request, response, and error handling are gone.
- **One additive route-kit hook.** A registered dispatcher answers JSON only, so its refusals had no
  status. `registerFactoryErrorFamily` (3e5479ff2) adds a family to the same mapping and refuses a
  class a built-in family owns. Reported to the coordinator.
- **`_shared.ts` edits, as allowed.** The console mutation kinds in `MUTATION_KINDS`; the trusted-validator error family (W09d O4): a contract naming unregistered,
  unpublished, unprotected, or untrusted material is 422, not an opaque 500. Reproduced first.
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
  rebuilt after W15 lands in integ/w00.

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
terminator, and the Node orchestrator, over the shared PostgreSQL and S3 stores. Run `journeys-7`
at `096fa0944`, clean: 7 passed, 0 failed (receipts `logs/journeys-7-*`, `journeys-7.json`).

1. The administrator grants itself `factory.trust` in the console.
2. The console binds the built guest release, reviews its reach, and trusts it.
3. The console imports and publishes the definition that runs the guest.
4. A save and a publish race on one revision; one consistent winner; a replayed key answers the
   first result and a reused key with other bytes is 409.
5. A run started from the version list is watched live to its terminal status; the list row follows
   it; no overflow at 1440 or 390 px.
6. Scoped API: ticket and download headers, forged ticket 403, forged cursor 400, a read-only key, a
   service principal that is 403 for a real and a missing run alike until granted, exact reads after,
   refusal after revocation, and a share that exposes only the named digest.
7. Quarantine review and a purge request that deletes nothing.

Earlier runs found and fixed: the stack root under `/tmp`, the setup password policy, the
service-credential setup, a stale "queued" run row, a "not yet" note on a finished run, cramped
390 px run cards, a spaced-out purge count, and a 500 for an unavailable shared artifact after the
route-kit move.

## Mutation (web/src/lib/factory/*, web/src/lib/graph/layout.ts, threshold 80)

| | Score | Scope |
| --- | --- | --- |
| Before, at `260855e57` | 79.74% | client 79.60, download 30.77, layout 68.63, model 83.02 |
| After, at `096fa0944` | 93.62% | client 97.67, download 100, layout 98.04, model 95.43, preview 96.09, run-format 90.70, run-stream 85.44, workspace-view 91.67 |

## Final sweep

Receipts: `sweep-5/receipts.txt`, every step at `096fa0944` with a clean tree.

| Check | Result |
| --- | --- |
| SDK build and SDK tests | pass |
| Console suite, PGlite and PostgreSQL; PostgreSQL validator materials and package preparation | pass |
| Run lifecycle, application, attempt composition, scope and session scans, API docs, OpenAPI, route contract, lanes, evidence | pass |
| Web check (svelte-check) | 0 errors, 0 warnings |
| Web Vitest pool under coverage | 7654 pass; web Vitest coverage check passes |
| Factory mock browser specs under Chromium coverage | pass |
| Real-stack `factory-services` lane | 7 pass |
| Lint, typecheck, factory boundaries, gate integrity | pass |
| Mutation | 93.62% (before 79.74%) |
| New-file coverage, BASE_REF=integ/w00 | pass |
| Patch coverage, BASE_REF=integ/w00 | 0 uncovered W14 lines; 4 W18a-2 files from the route-kit merge lack their producers in this focused run (`sweep-5/patch-partition.txt`) |

The partition diffs against `refs/w14/patch-base` (integ/w00 merged with `c2ef2fac3`), so only
lines W14 changed count as W14's.

## Open

- W15 restore signing waits for W15 to land in integ/w00 (prototype at `refs/w14/restore-prototype`).
- No product route or role prepares a trusted package; the stack prepares it with the product's
  own classes after the console trusts it.
- W02 constructs no quarantine fence: the preview counts live attempts, the transition stops nothing.
- Purge preconditions are closing-work checks; W15/W16 preconditions are not yet wired into them.
- Two installations with overlapping identifiers are proven at the service level (two databases),
  not with two HTTP servers.
- The lane needs `FACTORY_TEMPORAL_CLI` on the `factory-real` runner; nothing was provisioned.
- The integ/w00-based patch gate flags four W18a-2 files whose producers are W18a-2's.
