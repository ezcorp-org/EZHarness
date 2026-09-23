# SP04 controlled load gate

- [x] Implement bounded guest load commands and record raw attempted values, cgroup hits, exact root quota, independent neighbor heartbeat, and Xeon health samples.
- [x] Refuse the published 4 GiB memory, 1,024 PID, and 20 GiB disk preset before any load. The present safety caps are 512 MiB memory, 64 PIDs, 256 MiB disk, and 2 CPU equivalents.
- [ ] Wire a host-owned protected health sampler and exact root quota reader. The caller must create a second running fixture before SP04; the current runner creates its unrelated fixture after SP04.
- [x] Add an explicit high-load code path that requires a host-resolved approval bound to the exact fixture, release, connection, preset digest, limits, attempted loads, and a deadline of at most 120 seconds. It also requires measured Xeon RAM, storage-pool, and PID headroom, a healthy neighbor, and independent cleanup readback.
- [ ] Persist and review the high-load approval through the operator flow. Wire a host-owned resolver, protected Xeon/pool sampler, exact-root-quota reader, and cleanup verifier; the present module does not make an approval from agent input.
- [ ] Qualify a reviewed small test preset on the real Xeon, then test the exact published preset using a separately approved high-load budget. A small test preset alone does not prove the published preset limits. Minimum overrides change effective settings and cannot satisfy the published preset's SP04 acceptance rule.
- [ ] Record real CPU throttle, guest OOM, PID-denial, disk-full, cleanup, neighbor, and host metrics. Do not use mock results as release evidence.

The module returns `unsupported` when a load would exceed its safety cap or any result lacks measured containment. The high-load path has a hard maximum of 5 GiB memory, 1,200 PIDs, 24 GiB disk, and 8 CPU equivalents. It does not run against the live server in this task.

The high-load path needs an exact preset/connection/release digest and a dedicated test window. Reserve the fixture plus neighbor before starting. Require more than the attempted 4 GiB memory and 20 GiB disk loads plus fixed 8 GiB RAM and 16 GiB pool margins. The guest process deadline is at most 120 seconds, and the guest script kills its process group on timeout. Monitor the host and neighbor during each load, and prove file/process cleanup after each test. Its operator review must name the higher absolute caps. No automatic switch to high-load mode is permitted. If disk filling needs more than 120 seconds on this storage, report unsupported and design a new reviewed bounded driver.

Focused tests: 9 passed; Bun LCOV reports 154/154 instrumented source lines covered. Bun emitted no function counters for this file. Biome passed. These use a fake guest and do not count as SP04 live evidence.
