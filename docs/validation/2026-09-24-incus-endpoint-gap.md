# Incus preview endpoint gate — 2026-09-24

Status: **closed**. The Incus provider does not yet serve a guest preview.
`HostIncusProbeTransport` reports `endpointProxy: false`; the host broker denies
`endpoints.open` and `endpoints.close`. The provider manifest declares the
optional endpoint methods, but that declaration is not evidence of a live
transport. Do not qualify `persistent-web-compose.v1` or change the reported
control to `true` on this basis.

The product already has an authenticated preview origin, one-time handoff,
per-request registry check, expiry, response sanitation, and a
`SandboxPreviewBackend` interface. A sandbox preview registry row contains a
host-selected sandbox binding. The current dispatch does not resolve that
binding to a live Incus preview backend, so a valid preview token gets HTTP
502. It does not reach the AMD loopback proxy. The existing AMD proxy is
pinned to `127.0.0.1`; reusing it for a guest port would select the wrong
machine.

## Required implementation

1. Select a guest data path. A safe choice must bind every request to the
   Incus connection, restricted project, managed instance identity, and
   approved guest port. The host must obtain the guest address through a
   pinned Incus readback on each relevant generation. A plain `fetch` to an
   address supplied by the guest or a provider result is not sufficient.
   Today the host Incus transport has only bounded management requests and a
   fixed helper exec channel; it has no HTTP or WebSocket relay.
2. Add host-owned endpoint records for the sandbox ID, generation, port,
   protocol, owner, expiry, and revocation. `open` must be idempotent under the
   host operation journal. `close`, sandbox destroy, grant revocation, and
   expiry must stop future access. A lost open/close reply needs reconciliation
   against the same record and Incus identity.
3. Implement `SandboxPreviewBackend` for the live Incus workspace and resolve
   the stored sandbox reference in preview dispatch. Recheck the current
   binding, release, connection revision, running state, port, owner, and
   expiry on each HTTP request and WebSocket reconnect. The preview registry
   must never take a host path, backend URL, or guest address from the browser
   or the model.
4. Keep the existing separate-origin token gate, header and response
   sanitation, request and byte limits. Pin the destination and disable
   redirect following, ambient proxies, and DNS re-resolution. Bound body
   size, time, connection count, and WebSocket traffic. Do not forward app
   cookies, authorization headers, or Incus credentials to the guest.
5. Verify with a real guest service: authorized HTTP and WebSocket traffic
   works; another user, sandbox, generation, port, and expired endpoint are
   denied; guest redirects and DNS changes cannot move the upstream;
   sandbox stop/destroy cuts the route; AMD loopback and management targets
   remain unreachable. Only then may preflight report `endpointProxy: true`.

## Current evidence

- `web/src/__tests__/preview-dispatch.server.test.ts` proves a valid sandbox
  preview token produces 502 without a backend and makes zero AMD loopback
  fetches.
- `src/infrastructure/provider-rpc-broker.test.ts` proves endpoint open and
  close are denied before backend I/O.
- These are refusal tests. They do not prove a live preview or satisfy the
  `persistent-web-compose.v1` profile.
