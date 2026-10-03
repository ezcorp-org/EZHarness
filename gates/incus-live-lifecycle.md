# Gates: Host Incus lifecycle

Scope: A host-owned, bounded transport can create, inspect, list, power, destroy, and inspect operations within the approved Incus project.

- [x] L1: Mutations use fixed resource identity, reviewed profile, limits, and scoped idempotency; wrong project or stale scope is denied before network I/O.
  EVIDENCE: `lifecycle.ts` derives the Incus name from connection and sandbox IDs; `approvedPreset` supplies the image fingerprint, profile, digests, and memory/CPU/PID/disk limits. Create verifies the root disk in the pinned project profile and applies the approved disk size. `lifecycle.test.ts` denies wrong project, stale revision, and missing policy before HTTP, and checks the outgoing create body.
- [x] L2: Lost responses preserve unknown outcomes and readback uses stable operation or resource identity.
  EVIDENCE: mutation failures and deadline carry a deterministic, sandbox-scoped operation ID. Create/power readback requires the matching durable instance intent marker and observed state. Captured Incus async IDs are inspected only after matching the operation's instance resource. A lost destroy response with an absent instance stays `outcome_unknown`; absence alone cannot prove which delete removed it.
- [x] L3: Focused real-socket and fake-server tests pass, including negative scope and timeout cases.
  EVIDENCE: Bun 1.3.14 `bun test ./src/infrastructure/incus-transport/lifecycle.test.ts ./src/infrastructure/incus-transport/transport.test.ts ./src/infrastructure/incus-transport/transport.mtls.test.ts` passed 26 tests before the final disk/timeout additions; `bun test ./src/infrastructure/incus-transport/lifecycle.test.ts` then passed 7 tests. Targeted Biome check passed. TypeScript full pass has unrelated repository errors; `rg 'src/infrastructure/incus-transport/' /tmp/incus-tsc.log` returned no leaf errors.
