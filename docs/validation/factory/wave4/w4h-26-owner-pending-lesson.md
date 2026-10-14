# W4H-26 pending lessons (owner)

- Read the dispatch path before designing a fix that "moves a registration". The brief assumed a host-side runner
  registry; the product has none, and C05 forbids one (package code runs outside the host plane, first-party or
  not). The product-true form was a v4 runner package per export. One read of attempt-composition.ts and
  native-runner-policy.ts would have found it; the R1 report corrected it before any code.
- A proof harness that does a product step with the product's own classes can hide every defect in the product's
  composition of that step. The graph proof prepared its guest with its own catalog, runner and blob store, so four
  product defects stayed invisible until the composed application prepared a package itself: the catalog read the
  release source from the factory's S3 store (the v4 lifecycle writes elsewhere), the supervisor's runner had no
  toolchain, a retry reused a build identity the runner refuses for life, and the guest answered the snapshot
  instead of the port. Prove a product path only through the product's own composition, and name every
  "harness-supplied" step as an open product gap.
- import.meta.dir in a module the web server bundles points inside web/build; a built server then resolves
  repository paths under web/src (ENOENT). Resolve repository files through getProjectRoot(), and test the built
  server, not only `bun src/...`.
- A boot step that throws aborts every later boot step in the same function (here: the conversation-wiring
  reconcile). A new boot step reports and returns; it never throws into its caller.
- A role whose item keeps failing is retried at the worker's idle delay (250 ms): 1,500 reports in ten minutes and a
  rebuild each time. A role whose step costs a build needs a per-item backoff from the start.
- `Bun.file(path).exists()` is false for a Unix socket; wait for a socket with `stat().isSocket()`.
- A sourced env file that sets the same variable name as the caller (E) silently retargets the caller's paths; my
  queue command wrote to the wrong directory and ran nothing (exit 127). Use distinct names, or set paths after
  sourcing.
- A mutant that drops a digest comparison can survive a large suite: verifyArtifacts' comparison had no test at
  all. Run the comparison mutants the ruling names; do not assume a check is covered because the code is old.
- The resource gate inside a lock is `RESOURCE_GATE_MAX_WAIT_S=0` (heavy-lib.sh), not a `GATE_TRIES` variable;
  read the gate script before writing a hold, and replace a queued script with `mv`, never in place.
