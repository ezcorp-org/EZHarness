# Workflow consent release authority

- [x] Reproduce stale release consent disclosure through the HTTP preview route.
  EVIDENCE: `/tmp/lifecycle-consent-red.log` returns HTTP 200 for an extension cache entry without a sealed release binding and calls the metadata builder.
- [x] Check exact live release and owner/scope authority before consent metadata is built; await the adapter in both routes.
  EVIDENCE: preview tests reject disabled, removed, unacknowledged, replaced, differently owned/scoped, inactive-owner and membership-revoked releases before metadata. Both route fixture cohorts now return asynchronous authorization results. Consent assembly omits an unavailable nested graph and rejects revocation during its awaited version query.
- [x] Reproduce the private workflow cycle diagnostic oracle through the HTTP create route.
  EVIDENCE: `/tmp/lifecycle-validator-oracle-red.log` discloses `sealed:confidential-customer-export`, which the caller did not submit, through the cycle diagnostic.
- [x] Preserve definition validation without reading private graphs through an unscoped resolver.
  EVIDENCE: the default resolver reads only provenance-marked public non-extension entries. HTTP create/update/dry-run use the shared caller-visible resolver. The HTTP regression hides a foreign graph but still rejects a cycle through the caller's own private graph. Public and explicit-resolver cycle/depth tests remain intact.
- [x] Prove route regressions, existing consent tests, type checks and lint.
  EVIDENCE: `/tmp/lifecycle-consent-final.log` passes 177 tests across five files; `/tmp/lifecycle-validator-final.log` passes 94 tests and 199 assertions. Full web TypeScript and scoped Biome pass in `/tmp/lifecycle-consent-types2.log` and `/tmp/lifecycle-consent-lint.log`. The broader workflow web run passes 16 files; the separate legacy fork fixture failures are assigned to the SDK leaf, not represented as final green here.

This leaf does not claim complete final CI or PR validation.
