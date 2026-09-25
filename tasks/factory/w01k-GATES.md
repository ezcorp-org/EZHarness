# W01k — private-https client certificate verification

Owner: w16-continue (coordinator ruling 2026-09-25: security defect, top priority,
leaf package). W01 owner review: w01g-fix. Validator: validator-4. Branch
`wp/w01k-private-https-verify` from `integ/w00` at `03538e909`. Evidence:
`/tmp/factory-platform-evidence/w01k/`.

## Defect

`startFactoryPrivateHttps` (`src/factory/private-https.ts`) accepted a client
certificate from ANY authority and handed its CN to the handler as the verified
peer identity. Anyone who could reach a factory listener could present a
self-made certificate named, for example, `supervisor.<fleet>` or
`harness.tenant-01` and pass the mutual-TLS identity check. Found by W16's live
proof (a tenant's harness certificate reached the guest-broker route handler).

Cause: `Bun.listen` calls `handshake(socket, success, authorizationError)`.
`success` reports the handshake alone; chain verification failures (unknown
authority, expired) arrive in `authorizationError`; `socket.authorized` reads
true even then; and `rejectUnauthorized: true` is not enforced. The code read
`success` as "authorized".

Probe (`/tmp/factory-platform-evidence/w01k/probe.ts`, and validator-4's
`/tmp/factory-platform-evidence/w01k-validation/probe/tls-cases.ts`), Bun 1.3.14.
Before the fix every case below except "none" reached the handler with its CN
as the peer identity, and `socket.authorized` was true in each:

| Client | success | authorizationError |
| --- | --- | --- |
| trusted | true | null |
| unrelated authority | true | "unable to verify the first certificate" |
| expired, trusted authority | true | "certificate has expired" |
| not yet valid, trusted authority | true | "certificate is not yet valid" |
| serverAuth only, trusted authority | true | "unsupported certificate purpose" |
| self-signed | true | "self signed certificate" |
| none | false | null |

## Fix

The handshake callback is the enforcement, and says so: a peer identity is taken
only when `success` is true and `authorizationError` is null. Otherwise the peer
stays unset and the existing 401 applies before any handler.

## Gates

- [x] G1: Each untrusted client certificate (unrelated authority with the same subject; expired, not yet valid, and serverAuth-only from the trusted authority; self-signed) is refused 401 `unauthorized` before any handler, one test each; no certificate fails the handshake (no response); a trusted client reaches the handler with its identity.
  CHECK: `bun test --timeout 60000 ./src/factory/private-https.integration.test.ts`; `W01K_REPO=<worktree> bun /tmp/factory-platform-evidence/w01k-validation/probe/tls-cases.ts`
  EXPECT: exit 0; each of the five untrusted-case tests red on the unfixed listener; the probe exits 0
  EVIDENCE: fixed 15/0 (`/tmp/factory-platform-evidence/w01k/logs/private-https-fixed-3.log`); unfixed 10/5, the five untrusted cases red (`logs/private-https-red-3.log`); validator-4's probe exit 0, every untrusted case refused, trusted 200 (`logs/validator-probe.log`)

- [x] G1b: The Node pool server (`startPoolAdmissionHttps`, used by the Node pool bundle and `tests/postgres/factory-pool-mtls.test.ts`, so not dead code) reads a peer identity only from an authorized socket.
  CHECK: `bun test ./src/factory/pool/service-server.test.ts`
  EXPECT: exit 0
  EVIDENCE: `logs/listener-suites-2.log`

- [x] G2: Every suite that starts a factory listener still passes (none relied on the defect).
  CHECK: the 12 suites listed in `/tmp/factory-platform-evidence/w01k/logs/listener-suites.txt`
  EXPECT: exit 0
  EVIDENCE: 138 pass, 0 fail with the pool test (`logs/listener-suites-2.log`)

- [ ] G3: Hold: PostgreSQL and Podman suites that start listeners, boundary suites (C05, closure, node-service-link), coverage vs 03538e909 (100 percent on changed lines), typecheck, lint, boundaries, gate integrity.
  EVIDENCE: pending

- [ ] G4: W01 owner review (w01g-fix).
  EVIDENCE: pending

## Finding (recorded, per the ruling)

- A client with no certificate does not get a 401: Bun fails the handshake
  itself (`success: false`) and closes the connection with no response. That
  refuses earlier than a 401; the test asserts it.
- Bun reports the expired, not-yet-valid, serverAuth-only, and self-signed
  cases as an `authorizationError`, so each is refused 401 (tested).

## Audit: TLS servers and client identity in src/, scripts/, packages/

Seven sites handle TLS or a client identity. Only `private-https.ts` was exploitable.

| Location | Server | Client identity |
| --- | --- | --- |
| `src/factory/private-https.ts` `startFactoryPrivateHttps` | `Bun.listen` TLS | The fixed handshake check. Covers every caller: the execution gateway, the private service, the guest-broker route, the host launch and stop services, the pool process's `startBunPoolAdmissionHttps`, and the graph-proof gateway listener |
| `src/factory/pool/service-server.ts` `startPoolAdmissionHttps` | `node:https` | Not exploitable: Node (and Bun) refuse untrusted certificates in this handshake (`requestCert`, `rejectUnauthorized`; `/tmp/factory-platform-evidence/w01k/probe-node-https.mjs` under node 24.14.1 and bun 1.3.14). It never checked `socket.authorized`; the read now does (G1b). Under Bun `getPeerCertificate` is missing, so it would name nobody |
| `scripts/factory-temporal-authorizer.mjs` | `Bun.serve`, plain HTTP behind Envoy | Separate check: the identity is Envoy's `x-forwarded-client-cert`; Envoy's listener requires and validates the client certificate (`config/factory-temporal-gateway.yaml`; W16 route proof) |
| `scripts/factory-graph-proof/processes/tls-terminator.mjs` | `node:tls`, run with node | Refuses untrusted certificates (Node enforces `rejectUnauthorized`); no client identity used |
| `scripts/lib/shipping-effect-server.ts` | `Bun.serve` | No client identity used |
| `packages/@ezcorp/factory-transport/src/index.ts` | client | Verifies the SERVER (`rejectUnauthorized: true`); not a server |
| `src/extensions/mcp-proxy.ts`, `src/auth/oauth-callback-worker.ts`, `packages/@ezcorp/extension-runner/src/service.ts`, `packages/@ezcorp/sdk/src/v4/native-proxy.ts`, `scripts/lib/stage2-network-proof.mjs` | no TLS | No client identity used |
