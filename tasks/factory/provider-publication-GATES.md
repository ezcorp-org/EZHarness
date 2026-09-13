# Provider publication acceptance gates

- [x] P1: Reconciliation cannot turn a matching but unverified receipt into success.
  EVIDENCE: /tmp/factory-platform-evidence/root-provider-receipt-red.log and root-provider-receipt-final-combined-integration-results.json
- [x] P2: S3 verification reads the exact version and validates its target and content digest; failures preserve uncertainty.
  EVIDENCE: /tmp/factory-platform-evidence/root-provider-receipt-s3-live.json and root-provider-receipt-version-final.log
- [ ] P3: GitHub uses the existing host credential and authorization boundary, publishes one immutable branch and draft PR, and never retries an uncertain POST.
  EVIDENCE: pending
- [ ] P4: Actual private GitHub publication and local S3 proofs pass with scoped receipts.
  EVIDENCE: pending
- [ ] P5: Focused tests, PostgreSQL, changed-source coverage, types, lint, and merged parent checks pass.
  EVIDENCE: pending
