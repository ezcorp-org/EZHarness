# W16b — tenant-keyed guest-broker routes on the host supervisor

Owner: Terra deployment (w16-continue), coordinator ruling 2026-09-25 (option A),
as a leaf package that merges before W16 and W01h. Branch
`wp/w16b-guest-brokers-keyed` from `integ/w00` at `27d957531`. Evidence:
`/tmp/factory-platform-evidence/w16b/`. W01 owner review: w01g-fix
(diff `/tmp/factory-platform-evidence/w16b/w01-files.diff`).

## Why

One fleet host serves every installation, and each installation binds its own
guest-broker route. A single `services.guestBroker` endpoint could reach only
one of them.

## Decisions

1. `services.guestBroker` is removed; `services.guestBrokers` maps a tenant to
   an endpoint (`baseUrl`, `serviceTokenPath`, `tls`), 1 to 64 entries.
2. The tenant is the launch intent's `request.authority.tenantId`: the lease
   (`FactoryAttemptLease`) carries no tenant. A launch that names a tenant it
   does not belong to still fails at that tenant's route, because the attempt
   token verifies only with that installation's own secret.
3. Fail closed: a tenant with no entry is refused with
   `FactoryHostBrokerTenantUnconfiguredError`
   (`factory_host_broker_tenant_unconfigured`) before any transport call, for
   every payload kind. There is no fallback route.
4. The selection lives in the caller (`createFactoryConfiguredGuestBroker`);
   `guest-broker-client.ts` is unchanged apart from its comment.

## Gates

- [x] G1: The parser accepts a tenant-keyed map and refuses the single form (alone or beside the map), an empty or padded tenant, an empty or oversized map, a non-record, and any inexact endpoint.
  CHECK: `bun test --timeout 60000 ./src/factory/runner/supervisor-process.test.ts`
  EXPECT: exit 0
  EVIDENCE: `/tmp/factory-platform-evidence/w16b/receipts/b1/focused-lcov.json` (73 pass, 0 fail) at 61bc3428b

- [x] G2: Each attempt's frame reaches only its own tenant's route, including concurrent attempts of two tenants over two real mutual-TLS routes; a tenant with no entry is refused by name and reaches no route.
  CHECK: same suite
  EXPECT: exit 0
  EVIDENCE: same receipt; tests "each attempt's frame goes to its own tenant's route and to no other" and "a frame for a tenant with no route is refused by name and reaches no route"

- [x] G3: Every in-repo producer of the supervisor document uses the keyed form: the supervisor tests, W01g's transport suite, W19a's graph-proof stack.
  CHECK: `grep -rn "guestBroker:" src scripts` over supervisor documents; the transport suite
  EXPECT: no single-form supervisor section; transport suite green
  EVIDENCE: `focused-lcov.json` (transport suite included); `scripts/factory-graph-proof/stack.ts` one entry for its tenant

- [x] G4: C05 supervisor closure unchanged: no import line changed in any runtime file.
  CHECK: `git diff 27d957531 HEAD -- <runtime files> | grep -E '^[+-](import|export .* from)'`; the boundary suites
  EXPECT: no line; boundary suites green
  EVIDENCE: `/tmp/factory-platform-evidence/w16b/receipts/b1/process-boundaries.json` (46 pass, 0 fail)

- [x] G5: Podman supervisor suite, coverage gates against 27d957531, typecheck, lint, boundaries, gate integrity.
  CHECK: `flock --close /tmp/ezcorp-validation-heavy.lock timeout 5400 bash /tmp/factory-platform-evidence/w16/repro/w16b-hold.sh <label>`
  EXPECT: every leg exit 0
  EVIDENCE: `/tmp/factory-platform-evidence/w16b/receipts/b1/` at 61bc3428b (13 receipts); rerun at fb3a990ee in `receipts/b2/` (14 receipts, all exit 0, clean at start); patch coverage 6 files; no new source file

- [x] G6: W01 owner review (w01g-fix).
  EVIDENCE: approved at 61bc3428b (fail-closed selection, C05 closure unchanged, clean trial merge with W01h f8e24804b except a tasks/lessons.md union). The audience change (ca92306c5) was sent for the same review.

- [x] G7: The guest-broker route accepts only its own audience. `FACTORY_GUEST_BROKER_AUDIENCE` is defined once in the contract leaf; the route verifies against it whatever its configuration says; a token from the same key and issuer for another audience (a pool token) is refused 401 `token_audience_refused`; the startup parser refuses any other configured audience; no copy of the literal remains.
  CHECK: `bun test ./src/factory/runner/guest-broker-transport.integration.test.ts ./src/factory/startup-config.test.ts`; `grep -rn '"factory-guest-broker"' src scripts`
  EXPECT: exit 0; one match, in the contract leaf; each negative control red
  EVIDENCE: controls at ca92306c5: route trusting its configured audience red (`/tmp/factory-platform-evidence/w16b/logs/audience-route-red.log`); parser pin removed red (`logs/audience-parser-red.log`). Hold b2 at fb3a990ee: `/tmp/factory-platform-evidence/w16b/receipts/b2/` (14 receipts, all exit 0, clean at start): PostgreSQL guest-model route 17/0, Podman supervisor 3/0, focused with lcov 140/0 (supervisor, transport, supervisor-services, startup-config, guest-model route), boundary suites 46/0, patch coverage 6 files vs 27d957531, typecheck, lint, boundaries, gate integrity

## W01i (assigned)

- Launch-peer gap from the W16b review: the host launch route authorizes by peer only, so an allowed peer can launch a guest attributed to another tenant on capacity leased to someone else. Data stays isolated (that tenant's route verifies the attempt token with its own secret), but the launch itself is not bound to the peer's tenant. Coordinator ruling 2026-09-25: package W01i, owned by w01g-fix right after W01h, lands before the combined run. Not in W16b.
