# Gates: Infisical static-secret provider wave 3

Scope: Offline-testable Infisical static-secret extension over an injected protected HTTP transport. This gate does not qualify a live Infisical deployment.

- [x] S1: The v4 extension has a closed configuration for one exact HTTPS endpoint, project, environment, path, connection, machine-identity auth reference, and bounded credential mappings. Bootstrap secret material is rejected.
  CHECK: PATH=/home/dev/.bun/bin:$PATH bun test ./extensions/infisical-secrets/config.test.ts ./extensions/infisical-secrets/manifest.test.ts
  EXPECT: /0 fail/
  EVIDENCE: 40 expect() calls | 28 pass | 0 fail across 2 files.

- [x] S2: The provider accepts only its exact provider and connection identity, declared credential names, and approved consumer extension scopes. Model input cannot select an Infisical project, environment, path, or secret key.
  CHECK: PATH=/home/dev/.bun/bin:$PATH bun test ./extensions/infisical-secrets/provider.test.ts
  EXPECT: /0 fail/
  EVIDENCE: 73 expect() calls | 29 pass | 0 fail in the provider test file.

- [x] S3: Universal-auth login and static lookup use the pinned scope, manual redirects, bounded responses, safe retry classification, and one controlled authentication renewal. Wrong project, environment, path, or key responses fail closed.
  CHECK: PATH=/home/dev/.bun/bin:$PATH bun test ./extensions/infisical-secrets/provider.test.ts
  EXPECT: /0 fail/
  EVIDENCE: 73 expect() calls | 29 pass | 0 fail in the provider test file.

- [x] S4: Provider-auth expiry metadata, host-managed broker-handle lifetime, and unknown static-secret issuer validity remain distinct. The package does not claim dynamic leases or fabricate secret expiry.
  CHECK: PATH=/home/dev/.bun/bin:$PATH bun test ./extensions/infisical-secrets/provider.test.ts
  EXPECT: /0 fail/
  EVIDENCE: 73 expect() calls | 29 pass | 0 fail in the provider test file.

- [x] S5: Malformed JSON, redirects, oversized bodies, rate limits, transport failures, and secret-bearing error bodies return fixed classified errors without the canary in errors or captured logs.
  CHECK: PATH=/home/dev/.bun/bin:$PATH bun test ./extensions/infisical-secrets/provider.test.ts
  EXPECT: /0 fail/
  EVIDENCE: 73 expect() calls | 29 pass | 0 fail in the provider test file.

- [x] S6: The package builds and passes pinned Bun 1.3.14 tests, typecheck, lint, and whitespace checks.
  CHECK: test "$(PATH=/home/dev/.bun/bin:$PATH bun --version)" = "1.3.14" && PATH=/home/dev/.bun/bin:$PATH bun test ./extensions/infisical-secrets && PATH=/home/dev/.bun/bin:$PATH bun build ./extensions/infisical-secrets/extension.ts --target=bun --outdir=/tmp/ez-infisical-build && PATH=/home/dev/.bun/bin:$PATH bun x tsc --noEmit --strict --skipLibCheck --module Preserve --moduleResolution bundler --target ESNext --types bun ./extensions/infisical-secrets/*.ts && PATH=/home/dev/.bun/bin:$PATH bun x biome check extensions/infisical-secrets gates/pluggable-wave3-infisical.md && git diff --check -- extensions/infisical-secrets gates/pluggable-wave3-infisical.md
  EXPECT: /0 fail/
  EVIDENCE: Independent review reran pinned Bun 1.3.14: 113 expect() calls | 57 pass | 0 fail across 3 files. Build, package typecheck, Biome, and whitespace checks passed.

- [x] S7: Evidence states that host H04 protected transport wiring and a live non-production machine-identity qualification remain open, and it preserves the built-in encrypted store as the default path.
  EVIDENCE: `extensions/infisical-secrets/README.md` states all three limits. No existing built-in-store file was changed.

## Review

The package implements Infisical static lookup only. Its closed configuration pins one HTTPS origin, project UUID, environment, secret path, connection identity, host-owned machine-identity auth reference, and a bounded name-to-secret mapping with approved consumer extension IDs. The model-facing request can select only a declared credential name. It cannot supply an endpoint, project, environment, path, secret key, or bootstrap credential.

The provider uses Universal Auth `expiresIn` only for the provider access-token lifetime. It labels broker-handle validity as host-managed and static credential issuer expiry as not provided. It does not implement dynamic leases. Redirects are manual and denied. Responses are bounded before parsing. Safe static lookups retry once; rate limits remain classified with a bounded retry delay. A 401 can trigger one authentication renewal.

This wave used only injected fake transports. It did not contact an Infisical API or qualify a live deployment. Host H04 must still implement the protected transport route, resolve the machine-identity reference, enforce the approved endpoint and TLS policy, and prevent request or response logging. A real non-production machine identity must then pass the static consumer flow, wrong-scope denial, rotation, outage, and canary checks. The built-in encrypted store remains available and unchanged.

### Independent static review — 2026-09-22

Reviewed endpoint, project, environment, path and key pinning; consumer authorization; auth refresh; response size and redirect handling; classified SDK delivery; canary-safe errors; and static versus dynamic lifetime claims. Two confirmed validation gaps were fixed: host-secret references now reject empty, `.` and `..` path segments, and login tokens must use bearer-token characters before entering an authorization header. Regression cases pass in the 56-test package run. The [Infisical Universal Auth API](https://infisical.com/docs/api-reference/endpoints/universal-auth/login) documents the auth lifetime fields; [Infisical's static lookup example](https://infisical.com/blog/n8n-secrets-management) documents the v4 lookup route and `secret.secretValue` field. These sources support API shape, not live qualification.

H04 remains open: the reserved host route, machine-identity reference resolution, destination and certificate enforcement, DNS and redirect behavior, response-stream limits, and suppression of secret-bearing logs must be implemented and reviewed in the host. No live Infisical call, real machine-identity flow, rotation, outage, or consumer portability check ran in this review. The built-in encrypted store remains the default.

The follow-up connection-ID regression showed that the config accepted `infisical.production` while the broker and classified SDK parser rejected it. The config now uses their existing credential-connection ID grammar, so unsupported IDs fail at configuration time. A cross-package test checks config and SDK rejection; a broker test checks the same boundary. Both tests failed in their original positive form before this correction. After the fix, the Infisical package passed 57 tests, and the broker plus SDK suites passed 18 tests outside the process-restricted sandbox.
