# Gates: shipping Linux security and external checks

Scope: implement Stage2 missing assertions and verify available kernel/provider proof without secret disclosure.

- [x] S1: Raw-socket and IPv6 Stage2 cases execute actual production launcher/proxy allow/deny assertions in separate network namespaces.
  CHECK: EZCORP_STAGE2_PROOF=1 bun test ./src/__tests__/mcp-netns-raw-socket-blocked.test.ts ./src/__tests__/mcp-stage2-ipv6-disabled.test.ts && echo STAGE2_ISOLATION_VERIFIED
  EXPECT: STAGE2_ISOLATION_VERIFIED
  EVIDENCE: parent full replay in docs/validation/extension-v4-shipping/security/stage2-complete.log; direct TCP reaches the owned peer only after removing nft, and seeded IPv6 survives only after removing the two production disable writes. Both controls fail the intended deny assertion. All arms check wrong-token 407, destination-denied 403, and actual authorized echoed bytes.
- [x] S2: Connection-tracking load check executes real requests, requires their success, checks resource/cleanup results, and cannot pass on dead fixtures.
  CHECK: EZCORP_STAGE2_PROOF=1 bun test ./src/__tests__/mcp-stage2-conntrack-soak.test.ts && echo STAGE2_SOAK_VERIFIED
  EXPECT: STAGE2_SOAK_VERIFIED
  EVIDENCE: parent 300-second run completed 400 load requests plus four initial positive proxy controls; each gateway peak 123 of 262144, no table-full journal messages, zero owned containers. A real SIGKILL fails the same controller with cleanup. Combined three-file replay passes four cases/27 assertions. Exact source/image hashes and metrics: docs/validation/extension-v4-shipping/security/stage2-receipt.json. Operator 24-hour wrapper shares this controller; 24-hour duration is not claimed.
- [ ] S3: Candidate BPF audit emission, production-reader ingestion, and exact child attribution are verified in an owned KVM guest.
  CHECK: `flock --close .cache/validation-heavy.lock bash scripts/shipping-audit-vm.sh docs/validation/extension-v4-shipping/security/vm-seccomp-audit.log` then `EZCORP_DB_PATH=<owned-temp>/db bun scripts/shipping-audit-ingest.ts docs/validation/extension-v4-shipping/security/vm-seccomp-audit.log`.
  EXPECT: VM receipt ends `VM_AUDIT_ASSERTION=PASS pid=<pid>`; ingest reports nonzero exact-PID rows and `wrongPidRows=0`.
  EVIDENCE: Native-BPF emission and reader receipts are at `docs/validation/extension-v4-shipping/security/vm-seccomp-audit.log` and `docs/validation/extension-v4-shipping/security/vm-seccomp-ingest.log`. S3 remains pending until the production bwrap FD path and a no-filter ENOSYS control run.
- [ ] S4: Provider inventory identifies every previously missing input and safe runnable check; available authorized paths run with semantic output assertions.
  EVIDENCE: pending
