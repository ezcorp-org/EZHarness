# SP04 controlled load gate

- [x] Implement bounded guest load commands and record raw attempted values, cgroup hits, exact root quota, independent neighbor heartbeat, and Xeon health samples.
- [x] Refuse the published 4 GiB memory, 1,024 PID, and 20 GiB disk preset before any load. The present safety caps are 512 MiB memory, 64 PIDs, 256 MiB disk, and 2 CPU equivalents.
- [ ] Wire a host-owned protected health sampler and exact root quota reader. The caller must create a second running fixture before SP04; the current runner creates its unrelated fixture after SP04.
- [ ] Qualify a reviewed small test preset on the real Xeon, then add a separate operator-reviewed high-load budget for the exact published preset. A small test preset alone does not prove the published preset limits. Minimum overrides change effective settings and cannot satisfy the published preset's SP04 acceptance rule.
- [ ] Record real CPU throttle, guest OOM, PID-denial, disk-full, cleanup, neighbor, and host metrics. Do not use mock results as release evidence.

The module returns `unsupported` when a load would exceed its safety cap or any result lacks measured containment. It does not run against the live server in this task.

The high-load path needs an exact preset/connection/release digest, a dedicated test window, and a preflight that reads Xeon available RAM and pool free bytes. Reserve the fixture plus neighbor before starting. Require enough headroom for the full 4 GiB memory and 20 GiB disk attempts plus a host margin. Keep a 10-second guest process deadline, monitor the host and neighbor during each load, and prove file/process cleanup after each test. Its operator review must name the higher absolute caps. No automatic switch to high-load mode is permitted.

Focused tests: 5 passed; Bun LCOV reports 85/85 instrumented source lines covered. Biome passed. Full typecheck was run but blocked by a concurrently edited `incus-live-control-probes.test.ts` fixture; no load-module type error remained.
