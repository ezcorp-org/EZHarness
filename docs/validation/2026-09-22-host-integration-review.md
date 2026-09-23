# Incus host integration review — 2026-09-22

This review covers the new host-owned provider connection store, dedicated Incus probe RPC, and read-only HTTPS transport. It does not qualify sandbox creation or the Xeon deployment.

## Verified behavior

- The connection store binds a connection to an active approved release, persists reviewed Incus settings, and encrypts its client private key with revision- and configuration-bound authenticated data. PGlite reopen and PostgreSQL migration/reconnect tests pass.
- A release-bound host invocation can reach the dedicated `ezcorp/provider.incus.transport` RPC. Ordinary extension calls, stale releases and connection revisions, revoked connections, forged pins, and mutation actions are denied before backend I/O. The Incus manifest no longer declares the obsolete generic host API route.
- The probe reads only fixed Incus server, project, and profile routes. Its result reports unverified guest helper and Compose controls as unavailable, so profile preflight fails closed.
- The parser accepts the real Incus 6.0.6 `environment.kernel_architecture` field. The actual server response shape was checked through read-only SSH.
- Local HTTPS tests use real mTLS sockets. The transport verifies CA authorization, endpoint hostname, and the exact peer certificate before writing HTTP on the same socket. An unrelated certificate and a different leaf signed by the stored certificate receive zero GETs. Chunked responses work; oversized responses are rejected with `resource_exhausted` and no admitted effect. Invocation cancellation reaches the socket.

## Review findings closed

1. The first probe read `server_architecture`, which Incus 6.0.6 does not emit. Real response shape and a negative architecture test now cover `kernel_architecture`.
2. The first release path dropped cancellation before the HTTP probe. A release invocation regression now confirms cancellation stops a stalled request before later GETs.
3. Bun fetch and Bun's Node `https.request` compatibility path could write a GET before their certificate callback rejected a substitute peer. The default transport now verifies a `tls.connect` socket and writes the fixed HTTP request on that same verified socket. Real mTLS regressions require zero GETs for wrong peers.

## Open release gates

- No production operator setup entrypoint calls `ProviderConnectionStore.create` or `ReleaseProcess.callIncusProbe`; there is no Harness UI/API workflow to create, review, test, or rotate an Incus connection.
- Host-owned client identity issuance, a setup recipe compatible with an advertised preset, a restricted Incus project, and a live HTTPS listener are not in place. The real 14-step setup plan remains blocked.
- Lifecycle, file, process, and endpoint actions remain unsupported by the host transport. Guest helper, Docker/Compose, isolation, resource enforcement, recovery, and cleanup still require live qualification.
- Infisical's ordinary host API route is still denied; secret-provider integration is separate work.

The sandbox server was not changed. The local tests use a loopback HTTPS server and test-only certificates; they do not prove the Xeon's network, certificate, project, guest, or Compose behavior.

Final local verification on pinned Bun 1.3.14: 26,055 repository tests passed across 1,675 files with zero failures. Root typecheck, lint, build, manifest source-lock check, and `git diff --check` passed. Lint emitted eight informational notices and no errors.
