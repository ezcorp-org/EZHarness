# Gates: Incus sandbox adapter wave 3

Scope: Offline-testable Incus provider translation over an injected, host-mediated transport. This gate does not qualify a live Incus deployment.

- [x] I1: The extension manifest declares exactly the frozen 19 `sandbox.provider.v1` methods with canonical schemas and a closed connection schema that contains pins but no URL or private-key field.
  CHECK: PATH=/home/dev/.bun/bin:$PATH bun test ./extensions/incus-sandbox/manifest.test.ts
  EXPECT: /0 fail/
  EVIDENCE: `manifest.test.ts` passed on Bun 1.3.14. It compares all 19 names and schemas with the authoritative contract, validates the v4 manifest, rejects URL/endpoint/private-key/client-certificate fields and dispatches `describe` through the existing SDK v4 method seam without resolving a connection or transport.

- [x] I2: Lifecycle, file, process, operation and endpoint calls translate to scoped Incus/helper commands with exact connection identity, resource tags, explicit user/cwd, deadlines and idempotency fields.
  CHECK: PATH=/home/dev/.bun/bin:$PATH bun test ./extensions/incus-sandbox/adapter.test.ts
  EXPECT: /0 fail/
  EVIDENCE: The adapter suite exercised all 17 transport-backed methods. It checked the exact action order, public pins, SHA-256-derived Incus names, exact resource tags, `/workspace`, guest user, caller cwd, RPC deadline, request ID and idempotency key. The fixed host route test proved the command contains no endpoint or key material.

- [x] I3: Input/output bounds, cursor scope, error mapping and uncertain mutation outcomes fail closed; an unknown effect returns stable `OUTCOME_UNKNOWN` and is never blindly retried.
  CHECK: PATH=/home/dev/.bun/bin:$PATH bun test ./extensions/incus-sandbox/adapter.test.ts
  EXPECT: /0 fail/
  EVIDENCE: The adapter suite rejected oversized file output and escaped identities, exercised every transport error mapping, redacted raw diagnostics, rejected an unknown effect without a stable operation ID and returned non-retryable `OUTCOME_UNKNOWN` only with a valid stable ID. Typed host error envelopes preserve the same uncertain-effect fields.

- [x] I4: `describe` reports only declared support. `preflight` reports probed backend facts and rejects mismatched pins or missing required controls without allocation.
  CHECK: PATH=/home/dev/.bun/bin:$PATH bun test ./extensions/incus-sandbox/adapter.test.ts
  EXPECT: /0 fail/
  EVIDENCE: `describe` made zero transport calls. `preflight` made one 30-second `allocate: false` probe, returned the six contracted observation fields, and rejected every changed pin, required-control false value, unsafe workspace root and incompatible API/architecture/storage/isolation/Compose fact.

- [x] I5: The package builds and the reviewed tree passes pinned Bun tests, repository typecheck, lint and whitespace checks.
  CHECK: test "$(PATH=/home/dev/.bun/bin:$PATH bun --version)" = "1.3.14" && PATH=/home/dev/.bun/bin:$PATH bun test ./extensions/incus-sandbox && build_dir=$(mktemp -d /tmp/incus-adapter-build.XXXXXX) && PATH=/home/dev/.bun/bin:$PATH bun build ./extensions/incus-sandbox/extension.ts --target bun --packages external --outfile "$build_dir/extension.js" && test -s "$build_dir/extension.js" && PATH=/home/dev/.bun/bin:$PATH bun run typecheck && PATH=/home/dev/.bun/bin:$PATH bun run lint && git diff --check -- extensions/incus-sandbox gates/pluggable-wave3-incus-adapter.md
  EXPECT: /0 fail/
  EVIDENCE: On Bun 1.3.14, 15 package tests passed with 288 assertions; `bun build` produced an 83,244-byte Bun bundle; all four repository typecheck lanes passed; repository lint exited zero; scoped Biome and `git diff --check` passed.

- [x] I6: The evidence states that H04 protected transport, the guest helper artifacts and live SP01-SP08 qualification remain open; it makes no live-support claim.
  EVIDENCE: `extensions/incus-sandbox/README.md` states that the host H04 route and scoped mTLS identity, reproducible helper/image/recipe artifacts, server setup and live SP01-SP08 qualification remain open. No test used a live connection.

## Independent Sol audit

- [x] R1: Connection configuration and dispatch stay pinned to the declared provider, connection, project and profile without arbitrary URL, key or cross-connection resource naming.
  CHECK: PATH=/home/dev/.bun/bin:$PATH bun test ./extensions/incus-sandbox/manifest.test.ts ./extensions/incus-sandbox/adapter.test.ts
  EXPECT: /0 fail/
  EVIDENCE: The closed config parser rejects URL, endpoint, key and certificate fields, invalid names and the Incus `default` project/profile. `preflight` compares the observed certificate fingerprint, project, profile and helper version with its pins. Dispatch rejects a different provider or connection before transport; resource names hash both approved connection and sandbox IDs. The fixed host route test shows no endpoint or private key in the request.
- [x] R2: Every mutation preserves request/idempotency scope and treats network or unclassified server loss as an uncertain, non-retryable outcome unless the protected host supplies a stable operation identity.
  CHECK: PATH=/home/dev/.bun/bin:$PATH bun test ./extensions/incus-sandbox/adapter.test.ts
  EXPECT: /0 fail/
  EVIDENCE: All nine mutating commands carry the caller's request ID and idempotency key. A new regression first reproduced a lost injected transport reply returning retryable `DEADLINE_EXCEEDED`; ambiguous `deadline`, `unavailable` and `internal` errors now default to unknown effect. They return non-retryable `INTERNAL` without a stable operation ID, or non-retryable `OUTCOME_UNKNOWN` with one. Only an explicit protected-host `effect: none` permits retry. Malformed, lost and oversized host replies also fail closed for mutations.
- [x] R3: Contract exchange validation closes identity, path, argv, user, cwd, page/output, endpoint and response-sanitization escapes for all 19 methods.
  CHECK: PATH=/home/dev/.bun/bin:$PATH bun test ./extensions/incus-sandbox
  EXPECT: /0 fail/
  EVIDENCE: The manifest test compares all 19 declared method schemas with the frozen contract. The adapter validates every input before dispatch and every result through `validateSandboxProviderMethodExchange`; the translation test exercises all 17 transport-backed methods. The contract checks stable IDs, sandbox paths, canonical base64 and byte counts, bounded argv/environment, explicit guest user and cwd, list/output cursor scope, page/output limits, HTTPS endpoint shape/expiry and receipt idempotency scope. The adapter suite rejects wrong identities and users, escaped cursors, oversized file output and raw transport diagnostics. The host transport now rejects replies above 1 MiB before JSON parsing.
- [x] R4: Pinned Bun 1.3.14 package tests, package build, repository typecheck, lint and scoped whitespace checks pass after the audit.
  CHECK: test "$(PATH=/home/dev/.bun/bin:$PATH bun --version)" = "1.3.14" && PATH=/home/dev/.bun/bin:$PATH bun test ./extensions/incus-sandbox && build_dir=$(mktemp -d /tmp/incus-adapter-review.XXXXXX) && PATH=/home/dev/.bun/bin:$PATH bun build ./extensions/incus-sandbox/extension.ts --target bun --packages external --outfile "$build_dir/extension.js" && test -s "$build_dir/extension.js" && PATH=/home/dev/.bun/bin:$PATH bun run typecheck && PATH=/home/dev/.bun/bin:$PATH bun run lint && git diff --check -- extensions/incus-sandbox gates/pluggable-wave3-incus-adapter.md
  EXPECT: /0 fail/
  EVIDENCE: Bun 1.3.14 passed 20 package tests with 319 assertions and zero failures. Cross-package contract, conformance and candidate suites passed 10, 8 and 15 tests respectively. `bun build` produced an 86,831-byte Bun bundle. All four repository typecheck lanes passed. Repository lint exited zero (eight informational notices outside this package). Scoped Biome and whitespace checks passed. No live calls were made.
- [x] R5: Documentation and review evidence continue to state that H04, reproducible helper/image/recipe artifacts and live SP01-SP08 qualification remain open, with no live or support claim.
  EVIDENCE: `extensions/incus-sandbox/README.md` identifies the missing H04 host route and project-scoped mTLS transport, reproducible guest helper/image/recipe artifacts, server setup and live SP01-SP08 qualification. A real-entrypoint candidate test proves current verification fails closed at preflight because the host supplies no approved `providerConfig`; the static suite's synthetic connection ID also cannot name a live approved connection. The package tests use injected fake transport only. The declared preset digests are offline candidate values, not artifact or live-support receipts.
