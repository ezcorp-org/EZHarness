# Gates: shipping Linux security and external checks

Scope: implement Stage2 missing assertions and verify available kernel/provider proof without secret disclosure.

- [ ] S1: Raw-socket and IPv6 Stage2 cases contain executed allow/deny assertions through the production sandbox.
  EVIDENCE: pending
- [ ] S2: Connection-tracking load check executes real requests, requires their success, checks resource/cleanup results, and cannot pass on dead fixtures.
  EVIDENCE: pending
- [x] S3: Candidate BPF audit emission, production-reader ingestion, and exact child attribution are verified in an owned KVM guest.
  CHECK: `flock --close .cache/validation-heavy.lock bash scripts/shipping-audit-vm.sh docs/validation/extension-v4-shipping/security/vm-seccomp-audit.log` then `EZCORP_DB_PATH=<owned-temp>/db bun scripts/shipping-audit-ingest.ts docs/validation/extension-v4-shipping/security/vm-seccomp-audit.log`.
  EXPECT: VM receipt ends `VM_AUDIT_ASSERTION=PASS pid=<pid>`; ingest reports nonzero exact-PID rows and `wrongPidRows=0`.
  EVIDENCE: `docs/validation/extension-v4-shipping/security/vm-seccomp-audit.log`, `docs/validation/extension-v4-shipping/security/vm-seccomp-ingest.log`. The direct BPF loader does not prove bwrap FD passing; no-filter ENOSYS causation remains open.
- [ ] S4: Provider inventory identifies every previously missing input and safe runnable check; available authorized paths run with semantic output assertions.
  EVIDENCE: pending
