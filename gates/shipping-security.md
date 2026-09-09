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
- [x] S3: The retained MCP launcher/filter emits audit records; the production parser persists the exact sandbox child's records in an owned database.
  CHECK: EZCORP_AUDIT_IMAGE=localhost/ezcorp-extension-v4:shipping-e1178674 EZCORP_AUDIT_PROOF=1 flock --close .cache/validation-heavy.lock bun test ./src/__tests__/mcp-seccomp-enforce-integration.test.ts && echo S3_AUDIT_VERIFIED
  EXPECT: S3_AUDIT_VERIFIED
  EVIDENCE: Parent driver at 1cc1cf2f passes the canonical test and separate raw VM/ingest replay against image17548a4b (source e1178674): bwrap metadata and probe both identify PID49, seven records persist exactly, and the wrong PID persists none. The VM has no network interface. The actual launcher passes BPF on FD3; removing only the filter changes io_uring_setup from ENOSYS to EFAULT and fails the same probe (exit24). Exact image/launcher/filter/driver hashes are in vm-seccomp-audit.log. Scope is the retained MCP component, not a live v4 audit pipeline; see vm-seccomp-audit.md.
- [x] S4: Provider inventory identifies every previously missing input and safe runnable check; available authorized paths run with semantic output assertions.
  EVIDENCE: Parent actual keyless replay passes GitHub Stats, Weather, City Conditions and Price Chart. The installed Memory Extractor/Ollama replay passes one test/ten assertions with actual owned persistence and dedup. Remaining paid/private/configuration inputs and exact scope are in docs/validation/extension-v4-shipping/security/provider-inputs.md and provider-environment-presence.json.
