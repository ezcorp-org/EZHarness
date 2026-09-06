# Gates: shipping Linux security and external checks

Scope: implement Stage2 missing assertions and verify available kernel/provider proof without secret disclosure.

- [ ] S1: Raw-socket and IPv6 Stage2 cases contain executed allow/deny assertions through the production sandbox.
  EVIDENCE: pending
- [ ] S2: Connection-tracking load check executes real requests, requires their success, checks resource/cleanup results, and cannot pass on dead fixtures.
  EVIDENCE: pending
- [ ] S3: Production seccomp audit emission, ingestion, and exact child attribution are verified, or the missing external runner capability is freshly proved.
  EVIDENCE: pending
- [ ] S4: Provider inventory identifies every previously missing input and safe runnable check; available authorized paths run with semantic output assertions.
  EVIDENCE: pending

