# Incus sandbox adapter

This package implements the 19 methods in `sandbox.provider.v1` as a translation layer. It does not open an Incus socket. Every backend effect goes through an injected `IncusTransport`. The bundled entrypoint adapts that interface to one host API route and sends only a pinned connection ID, public pins, bounded operation data and resource tags. Connection URLs, client certificates and private keys are not provider configuration fields. The adapter rejects the Incus `default` project and profile; a dedicated restricted project and resource-limited profile are required.

`describe` is local. `preflight` makes one non-allocating, 30-second probe. It compares the observed server certificate fingerprint, Incus project, Incus profile and helper version with the connection pins. It also requires the restricted project, unprivileged instance, project limits, private network, `/workspace` root, explicit guest user, atomic file replacement, durable process, bounded output and endpoint proxy controls. A Compose preset also requires observed nested Compose support.

The preset digest constants identify the current offline candidate declarations. They are not evidence that matching image, recipe or helper artifacts exist on a server. Candidate verification and live SP01-SP08 qualification must replace them with reviewed artifact receipts before activation.

## Open live work

- The host has a dedicated read-only Incus probe and keeps the client key outside this package. Live client identity issuance, server provisioning, guest attestation, and lifecycle/file/process transport operations remain required. The adapter uses the reserved provider RPC, not the ordinary host API.
- Candidate verification currently passes no approved `providerConfig` to the Incus entrypoint. The static suite also uses a synthetic connection ID. The real entrypoint therefore rejects candidate preflight before transport; a host-owned, isolated qualification path remains required.
- The versioned guest helper and reproducible image/recipe artifacts remain required. No helper was installed or executed by these tests.
- Incus project, storage, network and profile setup remains separate operator work.
- No live Incus call, guest lifecycle, nested Compose run or SP01-SP08 qualification is claimed here.

Tests inject a fake transport and verify canonical translation, pin checks, explicit user/workspace scope, resource tags, idempotency, pagination/output bounds, error mapping and unknown mutation outcomes without network access.

An unclassified lost mutation reply is never marked safe to retry. The protected host must state that no effect occurred, or return a stable operation ID for `OUTCOME_UNKNOWN` reconciliation. Incus resource names include the approved connection and sandbox identities so separate connections cannot select the same owned name.
