# Gates: W01i peer-to-tenant binding on the host routes

Branch `wp/w01i-launch-tenant` (worktree `.worktrees/w01i-launch-tenant`), from integ/w00 `b10b7ea1a` with W01h's head
`34b3b0a74` merged in, because W01i changes the host launch and stop routes and the router W01h also changed.
Evidence: `/tmp/factory-platform-evidence/w01i/`. Owner: w01g-fix. Lands before the wave4f combined run.

## The defect (found in the W16b review)

The host launch, attach, result and stop routes authorized by mTLS peer only (`services.allowedPeers`). One host
serves every installation of its fleet, so any admitted installation could start, reattach to, read, or stop a
guest attributed to another tenant, on capacity leased to someone else. Data stayed isolated (the tenant's
guest-broker route verifies the attempt token with its own secret), but the launch and the stop were not bound
to the caller's tenant.

## The rulings (coordinator, 2026-09-27)

1. `services.peerTenants: { [peerIdentity]: tenantId }` replaces `allowedPeers` as the one fact; `allowedPeers`
   is refused by name, as W16b did with `guestBroker`. W01i updates every producer on integ; W16's renderer is
   w16-continue's (expected change below).
2. The stop route is bound the same way: a stop that names no tenant uses the tenant recorded at launch for that
   guest; a stop from a peer bound to another tenant is refused with the same code before any supervisor call.
3. The refusal is `403 forbidden_tenant`, beside `forbidden_host`.
Also ruled into W01i (from the W16b review): the guest-broker route requires a single string `aud`, and a
genuine token with an `aud` list lacking the route's audience answers `token_audience_refused`; a forged token
stays plain `unauthorized`.

## The change

- `src/factory/runner/host-peer-tenants.ts` (new leaf): the map's type and validation (1 to 64 peers, exact
  identities), `forbidden_tenant`, and `FactoryHostGuestTenants`, a bounded record (4096, oldest first) of the
  tenant of each guest a peer launched or reattached.
- Launch route: the intent's `request.authority.tenantId` must be the peer's tenant, checked after the host
  check and before the supervisor is called, on launch, attach and result; the admitted guest's tenant is
  recorded. An unknown peer stays `401 unauthorized`.
- Stop route: the guest's tenant is the recorded one, else the one the request names (`tenantId`, new optional
  field); a named tenant that contradicts the record, a tenant that is not the peer's, or a guest whose tenant is
  known neither way is refused before the supervisor. The product's stop client names the cancel command's tenant.
- Router: one `FactoryHostGuestTenants` shared by both routes.
- Supervisor document: `services.peerTenants`; `allowedPeers` is refused with "services.allowedPeers is replaced
  by services.peerTenants, which binds each peer identity to its tenant".
- Guest-broker route: an `aud` list is `token_audience_refused` even when it names this route; `otherAudience`
  reads a listed audience, and a list naming this route that fails verification stays `unauthorized`.
- Producers: supervisor tests, W01g's transport suites, the host-launch suite helper (`factoryLaunchPeerTenants`
  in the launch fixture), W19a's `stack-documents.ts` (`peerTenants: { "tenant-a": TENANT }`), and W19b's
  `diagnostics.ts` (`peerTenants` is a configuration key and a data map, like `hosts`).

## W16 renderer change expected (w16-continue's file, after W01i lands)

`src/factory/provisioning/host.ts`, supervisor document:

```diff
-        hostname: "127.0.0.1", port: this.identity.ports.supervisor, allowedPeers: admitted.map((entry) => entry.harnessIdentity),
+        hostname: "127.0.0.1", port: this.identity.ports.supervisor, peerTenants: Object.fromEntries(admitted.map((entry) => [entry.harnessIdentity, entry.tenantId])),
```

and in `src/factory/provisioning/host.test.ts` each `services.allowedPeers` expectation becomes the map, for example
`expect(supervisor.services.peerTenants).toEqual({ "harness.tenant-01": "tenant-01", "harness.tenant-02": "tenant-02" })`.
The same `entry.tenantId` already keys `guestBrokers`, so both sections name the same tenants.

## Gates

- [x] G1: The launch route refuses another tenant's intent before the supervisor, on all three paths.
  CHECK: `bun test ./src/factory/runner/host-launch-service.test.ts`
  EXPECT: forbidden_tenant with no supervisor call and no record; the bound peer goes through and is recorded;
  an unknown peer 401; red without the check (3 of 18)
  EVIDENCE: `logs/unit1/`, `logs/negative/launch-tenant.log`
- [x] G2: The stop route: recorded and named paths, contradiction, unknown, before the supervisor.
  CHECK: `bun test ./src/factory/runner/host-stop-service.test.ts ./src/factory/runner/supervisor-services.test.ts`
  EXPECT: 5/0 and 22/0; red without the tenant check (3 of 5), without the named-versus-recorded check (1 of 5),
  and without the shared record (1 of 22)
  EVIDENCE: `logs/unit1/`, `logs/negative/stop-*.log`, `logs/negative/router-shared-record.log`
- [x] G3: The document: `peerTenants` parsed; `allowedPeers` refused by name; every producer updated.
  CHECK: `bun test ./src/factory/runner/supervisor-process.test.ts ./src/factory/graph-proof-diagnostics.test.ts`
  EXPECT: 41/0 (incl. the by-name refusal, alone and beside peerTenants; the 64-peer bound) and 17/0
  EVIDENCE: `logs/unit1/`, `logs/commit-binding.log`
- [x] G4: The broker route: a listed `aud` is token_audience_refused; a forged list stays unauthorized.
  CHECK: under the lock, `bun test ./src/factory/runner/guest-broker-transport.integration.test.ts`
  EXPECT: green; red without the single-string check
  EVIDENCE: `logs/heavy/guest-broker-transport.integration.log` (13/0), `logs/heavy/negative-broker-listed-aud.log`
  (12/1: the listed-aud case), `logs/commit-broker.log` (hook 13/0)
- [x] G5: Transport, PostgreSQL and Podman suites under the lock, gated.
  EVIDENCE (`w01i-commit-locked.sh`, one hold, 2026-09-27 07:10Z to 07:16Z, head `9737238ff`): transport
  guest-broker 13/0, host-launch 6/0, host-stop 2/0, lost-result 4/0; PostgreSQL factory-host-launch 1/0; Podman
  lost-result 1/0, e2e 1/0 (`logs/heavy/`). Gates passed before each leg (df 123 GB, at least 12 GiB available,
  6.3 GiB swap free).
- [x] G6: 100 percent on the new file and on W01i's changed lines; typecheck, lint, boundaries (C05, closure).
  EVIDENCE: coverage leg 132/0; new-file gate PASSED (host-peer-tenants.ts, threshold 100); patch gate PASSED, 7
  files, BASE_REF `03d577fe9` (the W01h merge), `logs/heavy/coverage-gates.log`; typecheck, lint and the boundaries
  script exit 0 (`logs/typecheck-3.log`, `logs/lint-1.log`, `logs/boundaries-1.log`); C05 17/0, closure 16/0,
  check-factory-boundaries 31/0 (`logs/unit1/`).

## Commits

| Commit | What it is |
| --- | --- |
| `03d577fe9` | merge wp/w01h-runner-outcome 34b3b0a74; hook cap skip by coordinator ruling 2026-09-27 06:45Z; the 17 listed suites run outside the hook, all green (`logs/merge-w01h-suites/`; the Podman one under the lock); shared `.git/config` sha256 `44962525f1ca1a8b` before and after (`logs/shared-config-hash.txt`) |
| `95ebd50f4` | the peer-to-tenant binding on the launch and stop routes, the document, the producers (hook ran its 7 suites under the lock) |
| `9737238ff` | the guest-broker route accepts only a single string audience (hook ran its 1 suite under the lock) |
| `88fedcf89` | merge integ/w00 d2bc674c7 (W14) so the real-lane stack can be ported; hook cap skip by coordinator ruling 2026-09-27 07:20Z; workspace packages rebuilt first; all 36 listed suites green outside the hook (`logs/merge-integ-suites/`); config hash unchanged |
| `2f1f2791e` | the real-lane stack (`web/e2e/factory-services/stack.ts`) writes `peerTenants: { "tenant-a": TENANT }` |
| `124f7043e` | the runtime's post-result stop names its tenant without a cancel command (the lane-found defect below; hook ran its 3 suites under the lock) |
| `b0152056b` | merge W01h's fix round `aefcf828f` (a stop sealed first owns the attempt's end; no stop-settlement hot loop), the fix for the loop this lane found; clean; the hook ran its 7 suites green; typecheck, boundaries, and W01i's host-route, supervisor, composition and C05 suites green after it; transport suites under the lock at `4d2b76a84`: guest-broker 13/0, host-launch 6/0, host-stop 2/0, lost-result 4/0 (`logs/remerge2/transport-driver.log`) |

## The real lane (the coordinator's condition for the e2e stack)

- First run at `2f1f2791e` (2026-09-27 08:18Z to 08:29Z): the stack held with `peerTenants`; Playwright 4 passed,
  1 failed, 7 did not run. The product log named the cause: `attempt-dispatch:outcome-unknown` failed with
  "TypeError: undefined is not an object (evaluating 'request.cancelReference.tenantId')". W01h's post-result stop
  reaches the host stop client through `factoryIntentPhysicalStop` with only the physical coordinates, and W01i's
  client read the cancel command's tenant unconditionally. Every unit and transport suite had stayed green; only
  the real lane found it. Evidence: `logs/lane-playwright.log`, `logs/lane-processes/web.log`.
- Fix `124f7043e`: `FactoryPhysicalStopExpectation.tenantId` (optional), filled by the adapter from
  `intent.request.authority.tenantId`; the client names the tenant from the cancel command, else the expectation,
  else sends none (the host then decides by its launch record; with no record, 403 forbidden_tenant). Regression
  test in `host-stop-transport.integration.test.ts`: the runtime's request shape through the real client and host
  route; on the previous client it fails with the lane's exact TypeError (1 of 2 red,
  `logs/negative/post-result-stop-red.log`). The adapter test pins `tenantId`.
- Disclosed: while reproducing, the single-file `host-stop-transport.integration.test.ts` (a local TLS pair, no
  store, no container) ran twice outside the heavy lock, within the coordinator's carve-out.
- Second run at `124f7043e` (2026-09-27 10:33Z to 10:37Z, one lock hold, gated): the stack held; Playwright
  12 passed (3.3 m); stack exit 0; shared config hash `44962525f1ca1a8b` before and after
  (`logs/fix-lane-driver.log`, `logs/lane2-playwright.log`, `lane2.json`).
- Coverage of the commits after the integ merge (the stack port and the fix), BASE_REF `88fedcf89`, under the
  lock: 53/0; new-file gate PASSED (no new file); patch gate PASSED, every changed executable line covered in 3
  files (`logs/cov2/`).
- Found in the second run's product log, reported to the coordinator (W01h territory, not a W01i change):
  `stop-settlement:fault` fails `factory_task_stop_corrupt` 174 times for one attempt. The host refused its stop
  (500 stop_failed), the guest then died (container exit 1), W01h's lost-result path recorded a typed failed
  result, and the stop sealed earlier with reason `cancelled` (no terminal result then, `task-stops.ts:443`) is
  re-derived as `failed` on every retry (`task-stops.ts:610`) and called corrupt. The W14 baseline lane shows the
  same refused stop but no such loop (its attempt ended unknown). The other background-role lines match the W14
  baseline (usage hold without a receipt, stale epoch, release consent absent).

## Baseline background-role lines from this lane (OPEN, owners ruled by the coordinator 2026-09-27)

Counted in the second lane run's product log (`logs/lane2-processes/web.log`) and in the W14 validator's baseline
lane at integ, which has no W01h code. Pre-existing; W01h and W01i do not cause them.

| Line | This lane | W14 baseline | Owner |
| --- | --- | --- | --- |
| `usage-reconciliation:transient … factory_usage_hold_unresolved: no-operation-receipt` | 157 | 153 | W03f (reserved-bound settlement for unpriced operations, in progress) |
| `usage-reconciliation:fault … Factory run epoch is stale or unavailable` (the EXECUTION epoch in the run fence, moved by the lane's restore case) | 15 | 15 | W15f, w15b-fix: mark once, name the run and both epochs, no retry storm; this lane's logs are the reproduction |
| `release-outcome:transient … factory_release_consent_absent` | 21 | 17 | W09e: backpressure by design, but it must back off rather than retry every pass |

## Open

- W16's renderer change above (w16-continue), and the live check in W16's self-hosted proof once it renders
  `peerTenants`: a launch from another installation's peer answers `403 forbidden_tenant`.
- If validator-2's W01h findings change W01h's head, W01i re-merges that head before its commits are final.
