# Gates: host-owned Incus live witness

Scope: Implement concrete host observations for SP01–SP08 using the durable EZHarness controller, protected Incus transport, and real guest state. Synthetic passing values are forbidden.

- [ ] G1: Witness uses the active reviewed release, connection, preset, controller, and fixture service. Every reported instance identity and resource state comes from a backend or guest readback.
  EVIDENCE: `HostIncusLiveReadback` now reads the pinned image, server, pool, profile, project, and instance over the restricted project's mTLS connection. `IncusHostLiveWitness.observe` pins that readback to the verified setup receipt; `inspectFixture` compares instance facts with the durable binding and checks the running guest user, workspace, and boot ID. Focused tests reject wrong project, forged image, excess limits, and backend/durable state disagreement. A real isolated-app run remains pending, so G1 is open.
- [ ] G2: File/process/Compose, power/reconnect, two-fixture isolation, and cleanup flows return concrete measured results and leave no guest behind in a controlled integration fixture.
  EVIDENCE: pending
- [ ] G3: Quota, network, PID, CPU, memory, disk, and failed-cleanup facts are measured by controlled host/guest probes. Unsupported or unsafe probes fail qualification rather than returning an assumed pass.
  EVIDENCE: pending
- [ ] G4: The production runner is wired to record SP01–SP08 only after every case passes; the exact live qualification expires and denies feature admission afterward.
  EVIDENCE: pending
- [ ] G5: Focused tests, typecheck, lint, unchanged coverage gates, and a real isolated-app run pass.
  EVIDENCE: `bun test ./src/infrastructure/incus-host-live-witness.test.ts ./src/infrastructure/incus-transport/live-readback.test.ts` (7 pass), focused Biome check (clean), and `bun run typecheck` (pass). Coverage gates and a real isolated-app run remain pending, so G5 is open.
