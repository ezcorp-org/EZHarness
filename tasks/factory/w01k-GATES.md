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

Probe (`/tmp/factory-platform-evidence/w01k/probe.ts`), Bun 1.3.14:

| Client | success | authorizationError |
| --- | --- | --- |
| trusted | true | null |
| unrelated authority | true | "unable to verify the first certificate" |
| none | false | null |
| expired, trusted authority | true | "certificate has expired" |

## Fix

The handshake callback is the enforcement, and says so: a peer identity is taken
only when `success` is true and `authorizationError` is null. Otherwise the peer
stays unset and the existing 401 applies before any handler.

## Gates

- [x] G1: A client certificate from an unrelated authority (same subject), and an expired one from the trusted authority, are refused 401 `unauthorized` and never reach the handler; no certificate fails the handshake (no response); a trusted client reaches the handler with its identity.
  CHECK: `bun test --timeout 60000 ./src/factory/private-https.integration.test.ts`
  EXPECT: exit 0; red on the unfixed listener
  EVIDENCE: fixed 9/0 (`/tmp/factory-platform-evidence/w01k/logs/private-https-fixed.log`); unfixed red, the unrelated-authority certificate got 200 (`logs/private-https-red.log`)

- [x] G2: Every suite that starts a factory listener still passes (none relied on the defect).
  CHECK: the 11 suites listed in `/tmp/factory-platform-evidence/w01k/logs/listener-suites.txt`
  EXPECT: exit 0
  EVIDENCE: 131 pass, 0 fail (`logs/listener-suites.log`)

- [ ] G3: Hold: PostgreSQL and Podman suites that start listeners, boundary suites (C05, closure, node-service-link), coverage vs 03538e909 (100 percent on changed lines), typecheck, lint, boundaries, gate integrity.
  EVIDENCE: pending

- [ ] G4: W01 owner review (w01g-fix).
  EVIDENCE: pending

## Finding (recorded, per the ruling)

- A client with no certificate does not get a 401: Bun fails the handshake
  itself (`success: false`) and closes the connection with no response. That
  refuses earlier than a 401; the test asserts it.
- Bun reports an expired certificate from the trusted authority as an
  `authorizationError`, so it is refused 401 (tested).

## Audit: TLS servers and client identity in src/, scripts/, packages/

| Location | Server | Client identity |
| --- | --- | --- |
| `src/factory/private-https.ts` | `Bun.listen` TLS | Goes through the fixed handshake check. Used by the execution gateway, the private service, the guest-broker route, the host launch and stop services, and the pool under Bun (`startBunPoolAdmissionHttps`) |
| `src/factory/pool/service-server.ts` `startPoolAdmissionHttps` | `node:https` | Separate check verified: the standalone Node pool service; Node enforces `requestCert`/`rejectUnauthorized` at the handshake (unrelated, expired, and absent certificates refused; `/tmp/factory-platform-evidence/w01k/probe-node-https.mjs` under node 24.14.1). Under Bun, `node:https` also refuses them, but `req.socket.getPeerCertificate` is missing, so this wrapper is Node-only; the Bun pool path is the private-https one |
| `scripts/factory-temporal-authorizer.mjs` | `Bun.serve`, plain HTTP behind Envoy | Separate check: the identity is Envoy's `x-forwarded-client-cert`; Envoy's listener requires and validates the client certificate (`config/factory-temporal-gateway.yaml`, W16 route proof "no certificate refused at TLS") |
| `scripts/factory-graph-proof/processes/tls-terminator.mjs` | `node:tls`, run with node | No client identity used (terminates for Temporal; Node enforces its `rejectUnauthorized`) |
| `src/extensions/mcp-proxy.ts` | `Bun.listen`, no TLS | No client identity used |
| `src/auth/oauth-callback-worker.ts` | `Bun.serve`, no TLS | No client identity used |
| `scripts/lib/shipping-effect-server.ts` | `Bun.serve` | No client identity used |
| `packages/@ezcorp/extension-runner/src/service.ts` | `Bun.serve`, no TLS | No client identity used |
| `packages/@ezcorp/sdk/src/v4/native-proxy.ts` | `node:http` | No client identity used |
| `scripts/lib/stage2-network-proof.mjs` | `node:net` | No client identity used |
| `packages/@ezcorp/factory-transport/src/index.ts` | client | Verifies the SERVER (`rejectUnauthorized: true`); not a server |
