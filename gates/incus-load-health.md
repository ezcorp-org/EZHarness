# Protected Xeon health sampling for SP04

- [x] Sample fixed read-only host metrics through the existing pinned SSH bootstrap: available RAM, memory and CPU pressure, global OOM kills, task/PID headroom, and exact Incus storage-pool free bytes.
- [x] Require a host-owned protected callback to attest the exact running neighbor fixture and boot heartbeat. Refuse host-key drift, host identity drift, missing metrics, malformed output, unavailable pool capacity, and changed neighbor identity.
- [ ] Wire the sampler to the approved connection, durable neighbor fixture, and protected guest heartbeat. The module has no production caller yet.
- [ ] Run it before, during, and after real SP04 loads on the Xeon. Keep the output and independent backend inventory in the live qualification receipt.

PID headroom uses the smaller of host `threads-max` and `pid_max`, minus the task count in `/proc/loadavg`. This is a measured conservative admission signal; it is not an atomic reservation. The load controller must still enforce and observe the actual guest PID limit.

This module and its tests do not prove live SP04 containment.

Focused tests: 7 passed, Biome and full typecheck passed, and Bun LCOV reported 88/88 instrumented source lines. The pool capacity read uses Incus' documented read-only `/1.0/storage-pools/{name}/resources` endpoint. A live Xeon probe is still required to confirm the response shape and command latency for the selected Incus 6.0.6 host.
