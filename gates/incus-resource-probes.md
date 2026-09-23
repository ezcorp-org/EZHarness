# Incus resource probe gate

Scope: Exact-fixture, host-owned observations for SP04. This module does not claim full SP04 qualification.

- [x] Read actual guest `memory.max`, `cpu.max`, `pids.max`, and UID mapping through a fixture-bound process call. Reject `max`, malformed data, a host-root mapping, and values above the reviewed preset. Evidence: `src/infrastructure/incus-live-resource-probes.ts` and five focused tests.
- [x] Require a pinned Incus root quota readback for the same sandbox ID. Deny a missing quota or another instance's quota. Evidence: the exact-ID check and negative test.
- [x] Probe two distinct IP-literal network targets from the guest only after a host control connection proves each target is reachable. Reject guest access to either target. Evidence: the control-target and guest-access negative tests.
- [x] Run focused tests, typecheck, and lint. Evidence: `bun test ./src/infrastructure/incus-live-resource-probes.test.ts` (5 pass), `bun run typecheck` (pass), `bunx biome check` for both new files (pass).
- [ ] Wire this module to the live witness with exact fixture ownership, pinned readback, and host-owned reachable management and other-project canaries. Host reachability alone does not prove that a target belongs to another Incus project; the caller must verify target ownership. No live probe has run.
- [ ] Implement safe controlled memory, CPU, PID, and disk load probes with a neighbor guest and host health checks. The current module only observes configured and cgroup limits, so it cannot satisfy `exerciseLimits` or mark SP04 complete.
- [ ] Confirm the reviewed Incus profile gives a finite guest `cpu.max`. Current lifecycle sets `limits.cpu`, which may bind CPU placement without a hard quota. A `max` result correctly blocks qualification. No server setting is changed here.

Review: The probe returns only measured and exact-scoped facts. It throws when controls cannot be verified. The witness readiness switch remains false.
