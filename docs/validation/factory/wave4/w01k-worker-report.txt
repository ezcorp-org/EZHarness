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

- [x] G3: Hold: PostgreSQL suites that start listeners, the Podman supervisor suite, the pool coverage producer (Node V8 for `service-server.ts`), focused suites with lcov, boundary suites (C05, closure, node-service-link), coverage vs 03538e909 (100 percent on changed lines), typecheck, lint, boundaries, gate integrity.
  CHECK: `flock --close /tmp/ezcorp-validation-heavy.lock timeout 5400 bash /tmp/factory-platform-evidence/w16/repro/leaf-hold.sh /tmp/factory-platform-evidence/w01k/hold-config.sh <label>`
  EXPECT: every leg exit 0
  EVIDENCE: hold k3 at 8c413221f, `/tmp/factory-platform-evidence/w01k/receipts/k3/` (15 receipts, all exit 0, clean at start): PostgreSQL 36/0 (pool-http, compute-admissions, artifact-materials, pool-mtls), Podman supervisor 3/0, pool producer 86/0, focused 138/0, boundary suites 48/0; patch coverage 2 files, no new source file. Hold k2 (same head) failed only patch coverage on `service-server.ts` line 46, which runs only in the Node server and is measured by the pool producer that k2 did not run; k3 adds it

- [x] G4: W01 owner review (w01g-fix).
  EVIDENCE: approved at 8c413221f: the callback names a peer only on success, a null authorizationError, and a non-empty CN; the five untrusted cases each fail on the old code; poolPeerIdentity only tightens the Node pool server; peerIdentity keeps its contract ("a certificate the listener's own authority verified"), now true; no import changed (C05 and the closure unchanged); the audit's two identity readers (private-https.ts, pool/service-server.ts) confirmed. Correction recorded: the defect was only in the inline handshake callback of private-https.ts; there is no handshake-args.ts in the tree (that name is my probe script under the evidence directory).

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
