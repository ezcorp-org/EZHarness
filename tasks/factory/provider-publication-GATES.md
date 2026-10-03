# Provider publication acceptance gates

- [x] P1: Reconciliation cannot turn a matching but unverified receipt into success.
  CORRECTION (W00 audit 2026-09-13): the cited root-provider-receipt-red.log records the pre-fix failing run, and head 17b79bab1 is not an ancestor of the integration branch. The behavior is proven on the integration source: releases.integration.test.ts passes in /tmp/factory-platform-evidence/w00-staging-focused.log (head bd2cedcc9). Cite integration-ancestor receipts only.
  EVIDENCE: /tmp/factory-platform-evidence/root-provider-receipt-red.log and root-provider-receipt-final-combined-integration-results.json
- [x] P2: S3 verification reads the exact version and validates its target and content digest; failures preserve uncertainty.
  EVIDENCE: /tmp/factory-platform-evidence/root-provider-receipt-s3-live.json and root-provider-receipt-version-final.log
- [x] P3: GitHub uses the existing host credential and authorization boundary, publishes one immutable branch and draft PR, and never retries an uncertain POST. — superseded by W07 (merge b90dbb60d): G10 one draft PR on one unique branch, G12 recovery by identity and no force-update, G14 no path to the provider without the host boundary (tasks/factory/w07-GATES.md) (verified 2026-10-03, leftover audit).
  EVIDENCE: pending
- [x] P4: Actual private GitHub publication and local S3 proofs pass with scoped receipts. — superseded by W07 G15 (a real draft PR on the private repository, /tmp/factory-platform-evidence/w07/release-github-real.json) and the S3 publication producers (W07 G20; W09c G2 real S3 profile, factory-s3-publication 18/0) (verified 2026-10-03, leftover audit).
  EVIDENCE: pending
- [x] P5: Focused tests, PostgreSQL, changed-source coverage, types, lint, and merged parent checks pass. — superseded by W07 G16 static gates, G17 coverage of every new file and changed line, G18 real PostgreSQL (tasks/factory/w07-GATES.md) (verified 2026-10-03, leftover audit).
  EVIDENCE: pending
