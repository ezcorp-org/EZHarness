# Gates: Guest workspace transport

Scope: A versioned guest helper interface provides bounded, contained workspace files and supervised process handles.

- [x] W1: File reads, writes, lists, and deletes stay under `/workspace`; symlink races, stale revisions, oversized data, and binary data have tests.
  EVIDENCE: `src/infrastructure/incus-guest/helper.py` uses descriptor-relative `O_NOFOLLOW` traversal, atomic file replacement and revision checks. `helper.test.ts` covers binary ranges, stale revisions, size bounds, and a concurrent parent/symlink swap. Recursive deletion is rejected.
- [x] W2: Processes have durable IDs, bounded output pages, cancellation, explicit guest user, and timeout behavior.
  EVIDENCE: `helper.test.ts` starts real Python processes, pages binary stdout/stderr, verifies cross-boot denial, cancellation, deadline, 1 MiB output retention, and exact replay without duplicate execution. Status and output persist outside the helper invocation.
- [x] W3: Guest helper absence or version mismatch fails closed; focused tests pass.
  EVIDENCE: `protocol.ts` rejects absent, invalid and mismatched replies and caps request/response size. `helper.py` rejects request version and guest user mismatch. `hello` provides a live installation check. Pinned Bun 1.3.14: 11 focused tests passed; `bun x tsc --noEmit -p tsconfig.typecheck.json` and Biome passed.
