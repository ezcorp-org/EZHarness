# Gates: W15c pool service leaf (Node bundle regression)

Scope: the team lead's W15c assignment (2026-09-24). validator-2 found it on `integ/w00` (record `/tmp/factory-platform-evidence/main-96e7ee58c-validation/results.json`, F2; patch `.../r2/pool-leaf-fix.patch`). Branch `wp/w15c-pool-leaf` from `integ/w00` at `6c8ec29c5`. Receipts under `/tmp/factory-platform-evidence/w15c/receipts/` (producing commit, dirty state, command, exit code, times, log hash). Source head `603077bbb`; later commits change only `tasks/`. Coverage and gate base `BASE_REF=integ/w00`.

Cause: `pool/service-server -> service-routes -> service -> pool/checkpoint -> checkpoint-barrier`, and the barrier reaches `src/db/connection.ts` (through `db/queries/extension-releases` and, the checker found, also `records -> auth/factory-service-token -> auth/jwt -> db/queries/settings`), which links `drizzle-orm/bun-sql` and the `bun` builtin. The Node build of the pool service failed.

Deviation from the patch: the three pool-facing types (pool snapshot, pool source, slot source) move into the leaf with `FACTORY_CHECKPOINT_LIMITS`, so the pool imports nothing from the barrier. The barrier re-exports all four, so no caller changes. The leaf and `pool/checkpoint.ts` are byte-identical to the same fix on `wp/w15b-runtime-kms`.

- [x] G1: The pool service bundles for Node, with no `--external`, and the bundle imports no `bun` builtin.
  CHECK: `bun build src/factory/pool/service-server.ts --target node --format esm --outfile <cov>/pool-server.mjs`, then a grep for `from`, `import(`, or `require(` of `"bun"`
  EXPECT: exit 0, no match
  EVIDENCE: `receipts/pool-node-build.json` exit 0; bundle sha256 `e858bdded8d4f37c3f5471e00632a83f1cfc9f1b380e495722ed3bf3961c6c5a`. `src/__tests__/factory-process-boundaries.test.ts` also builds it (C12 block, in `unit.json`).

- [x] G2: The pool mTLS and pool checkpoint suites, and the barrier suite, pass under PostgreSQL.
  CHECK: `bun test --coverage ./tests/postgres/factory-pool-mtls.test.ts` (and `factory-pool-checkpoint`, `factory-checkpoint`), URL exported inside the batch script
  EXPECT: exit 0
  EVIDENCE: `receipts/pg-pool-mtls.json` 1/0, `pg-pool-checkpoint.json` 6/0, `pg-checkpoint.json` 12/0.

- [x] G3: A boundary rule keeps the pool service graph off `src/db/connection.ts`, and a deliberate violation is rejected.
  CHECK: `bun scripts/check-factory-boundaries.ts`; `bun test ./scripts/check-factory-boundaries.test.ts` ("Node service links")
  EXPECT: the real repository passes; an in-memory graph that reaches `db/connection` through a re-export and a dynamic import two hops away is rejected with rule `node-service-link` and the full chain; type imports and type re-exports link nothing
  EVIDENCE: `receipts/static-boundaries.json` exit 0; `unit.json` 60 pass / 0 fail. With `pool/checkpoint.ts` importing the barrier again, the checker exits 1 and names the chain (red run before commit `603077bbb`). The runtime-closure walker moved from the process-boundary test into the checker; that test now imports it (DRY).

- [x] G4: Static gates and coverage.
  CHECK: `bun run typecheck`, `bun run lint`, `gate-integrity.ts`, `check-new-file-coverage.ts`, `check-patch-coverage.ts` with `BASE_REF=integ/w00`
  EXPECT: exit 0
  EVIDENCE: `receipts/static-*.json`, `new-file-coverage.json`, `patch-coverage.json`, all exit 0.

- [ ] G5: The full backend pool passes.
  CHECK: `bun run test` in a clean environment
  EXPECT: exit 0
  EVIDENCE: `receipts/backend-pool.json` exit 1: 28237 pass / 3 fail. The three failures are the Podman guest suites `reference-data/journey`, `runner/applied-controls`, and `runner/python-guest`. Alone they fail the same way (`logs/pool-fail-alone.log`): "image not known" for `localhost/ezcorp-factory-python-data@sha256:21a71347...` and `docker.io/library/python@sha256:3121f8b0...`. A mass image removal on the host at about 2026-09-24T16:50Z deleted them (podman events). No W15c file is on their path. Open until the images are rebuilt.
