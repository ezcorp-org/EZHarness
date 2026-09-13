# Cancellation authority leaf

- [x] Every journal predicate fences `cancellation_epoch`.
  CHECK: rg -n "execution_epoch=.*cancellation_epoch" src/factory/executions.ts
  EXPECT: all authority-scoped execution predicates include both fields
  EVIDENCE: reconcileLate, cancel, confirmStopped, status, and lockLive SQL include the field.
- [x] Runtime attempt identity carries cancellation epoch.
  CHECK: bun test --timeout 30000 ./src/runtime/factory-execution.integration.test.ts
  EXPECT: pass
  EVIDENCE: factory-execution integration passed 6 tests.
- [x] Gateway and journal stale epoch tests pass.
  CHECK: bun test --timeout 30000 ./src/factory/executions.integration.test.ts ./src/factory/execution-gateway.integration.test.ts
  EXPECT: pass
  EVIDENCE: pinned Bun focused command passed 10 tests / 101 assertions.

# Factory runner authority binding gates

- [x] G1 Signed C02 attempt claims carry a canonical request identity digest and cancellation epoch.
  CHECK: rg -n "requestDigest" src/factory/execution-gateway.ts src/factory/executions.ts src/factory/runner/native.ts
  EXPECT: requestDigest is required in gateway claims, journal authority, and native mapping.
  EVIDENCE: `rg` found required claim parsing, journal authority, and native mapping; the gateway integration signs and checks both fields.

- [x] G2 Durable admission persists exactly the canonical request identity digest and every effect/recovery read verifies it with the full scoped authority.
  CHECK: /tmp/factory-tools/bun-1.3.14/bun-linux-x64/bun test --timeout 30000 ./src/factory/executions.integration.test.ts ./src/factory/execution-gateway.integration.test.ts
  EXPECT: exit 0
  EVIDENCE: focused PGlite journal and mTLS gateway tests passed: 2 tests, 0 failures.

- [x] G3 Changed model configuration, policy, and input identities fail before `actualAgentExecutor` or broker effects.
  CHECK: /tmp/factory-tools/bun-1.3.14/bun-linux-x64/bun test --timeout 30000 ./src/factory/runner/native.integration.test.ts ./src/runtime/factory-execution.integration.test.ts
  EXPECT: exit 0
  EVIDENCE: native real-PGlite executor and runtime tests passed: 8 tests, 0 failures; each changed fixture asserted zero executor calls.

- [x] G4 Required callers typecheck and the four-leg project typecheck passes.
  CHECK: flock /tmp/ezcorp-validation-heavy.lock /tmp/factory-tools/bun-1.3.14/bun-linux-x64/bun run typecheck
  EXPECT: exit 0
  EVIDENCE: pinned Bun command exited 0 after backend, web, backend-tests, and web-e2e legs.

- [x] G5 The changed executable source is covered by focused tests and the final patch has at least 100 changed/new executable lines measured.
  CHECK: git diff --numstat HEAD~1..HEAD -- src/factory src/runtime packages/@ezcorp/factory-sdk
  EXPECT: records the final measured source/test delta.
  EVIDENCE: pinned focused runner producer: journal/gateway/native/runtime/supervisor/Podman 13 pass; exact LCOV 100% for execution-gateway 69/69, executions 190/190, native 74/74, supervisor 76/76, and SDK compiler 592/592. `BASE_REF=HEAD~2 bun scripts/check-patch-coverage.ts` passed six changed source files. The source diff measured 208 added + 80 deleted = 288 lines.

# Factory Drizzle schema gates

- [x] S1 Every product Factory migration table has one exported Drizzle table model, with reusable fresh scope column builders.
  CHECK: bun test ./src/db/factory-schema.test.ts
  EXPECT: pass
  EVIDENCE: pinned Bun unit test passed 2 tests; it verifies all 17 table exports, fresh column instances, cancellation epoch default, and 20 foreign keys.

- [x] S2 The schema matches a real PostgreSQL database after the Factory migrations, including types, defaults, keys, foreign keys, and indexes.
  CHECK: FACTORY_TEST_POSTGRES_URL=... bun test ./tests/postgres/factory-schema.test.ts
  EXPECT: pass
  EVIDENCE: pinned Bun with isolated PostgreSQL passed 2 tests and 553 assertions; it introspected every Factory column/type/default/nullability plus primary, unique, foreign, and partial-index facts.

- [x] S3 The schema has no runtime import cycle and all changed executable source has 100% measured coverage.
  CHECK: FACTORY_TEST_POSTGRES_URL=... bun test --coverage ./src/db/factory-schema.test.ts ./tests/postgres/factory-schema.test.ts
  EXPECT: pass with `src/db/factory-schema.ts` at 100%
  EVIDENCE: clean Bun import passed; combined LCOV measured factory-schema 291/291, add-factory-inbox 7/7, add-factory-budgets 7/7, and add-factory-definitions 10/10.

- [x] S4 Root typecheck and lint pass with the Factory schema import.
  CHECK: bun run typecheck && bun run lint
  EXPECT: exit 0
  EVIDENCE: pinned four-leg typecheck passed; lint exited 0 with eight existing informational diagnostics outside this leaf.

# Factory journal lock-order gates

- [x] L1 Every journal path obtains the scoped project share lock before installation and run fences.
  CHECK: rg -n "lockProjectScope|lockInstallationFence|lockRunFence" src/factory/executions.ts
  EXPECT: project -> installation -> run order
  EVIDENCE: lockRunFence calls lockProjectScope, lockInstallationFence, then locks the run; the source comment records the shared Factory order through lifecycle, budget, and journal rows.

- [x] L2 A PostgreSQL project revoke lock serializes concurrent cancellation and effect work without a deadlock.
  CHECK: FACTORY_TEST_POSTGRES_URL=... bun test ./tests/postgres/factory-executions.test.ts
  EXPECT: pass
  EVIDENCE: pinned Bun real PostgreSQL journal test passed. Its project UPDATE barrier held both cancellation and dispatch until release; both requests then settled without deadlock. Combined journal LCOV was 202/202.
# Factory artifact storage gates

- [x] A1 Host-issued database references bind every artifact to tenant, project, and logical run; callers cannot authorize a read with a guessed digest.
  CHECK: bun test --timeout 30000 ./src/factory/artifacts.integration.test.ts
  EXPECT: pass
  EVIDENCE: 2026-09-13 focused PGlite test: pass

- [x] A2 Canonical compiled definitions stage as <=32 KiB pages and load through the real Node orchestrator readers.
  CHECK: bun test --timeout 30000 ./src/factory/artifacts.integration.test.ts
  EXPECT: pass
  EVIDENCE: 2026-09-13 focused PGlite test: pass, including a 512-page linked manifest

- [x] A3 Transition finalization verifies identity, canonical bytes, page indexes, totals, and event digest before an audit record can commit.
  CHECK: bun test --timeout 30000 ./src/factory/artifacts.integration.test.ts
  EXPECT: pass
  EVIDENCE: 2026-09-13 focused PGlite test: pass

- [x] A4 PostgreSQL and local ordinary S3 retain the scoped bytes across response loss and reject foreign, changed-byte, and changed-version reads.
  CHECK: FACTORY_TEST_POSTGRES_URL=... bun test --timeout 120000 ./tests/postgres/factory-artifacts.test.ts
  EXPECT: pass
  EVIDENCE: 2026-09-13 real PostgreSQL and local ordinary S3: pass

- [x] A5 Changed artifact source is 100% measured and project typecheck and lint pass.
  CHECK: bun run typecheck && bun run lint
  EXPECT: exit 0
  EVIDENCE: 2026-09-13 focused LCOV: 100% lines for artifacts, definitions, transitions, activities, and migration; scoped TypeScript diagnostics and Biome pass.

- [ ] E1 Installation data-key hierarchy accepts only exact operator/KMS keys, persists versioned wraps, and fails closed for missing, unsafe, or unknown keys.
  CHECK: bun test --timeout 30000 ./src/factory/encryption.test.ts
  EXPECT: pass
  EVIDENCE: pending

- [ ] E2 Encrypted BlobStore preserves v4/S3 storage, binds ciphertext to tenant, object, payload, and data-key version, and cannot read tampered or cross-tenant bytes.
  CHECK: bun test --timeout 30000 ./src/factory/encryption.test.ts
  EXPECT: pass
  EVIDENCE: pending

- [ ] E3 Rewrapping retains old versions and never replaces encrypted object bytes; reusable history, archive, snapshot, backup, and Node Temporal codec adapters round-trip with authenticated binding.
  CHECK: bun test --timeout 30000 ./src/factory/encryption.test.ts && PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH bun run --cwd packages/@ezcorp/factory-orchestrator test
  EXPECT: pass
  EVIDENCE: pending

- [ ] E4 Real local ordinary S3 proves encrypted artifact round-trip, tamper/cross-tenant denial, rotation without object rewrite, and lost-key denial. Owned source reaches 100% coverage and static checks pass.
  CHECK: FACTORY_TEST_POSTGRES_URL=... bun test --coverage ./tests/postgres/factory-encryption-s3.test.ts && bun run typecheck && bun run lint
  EXPECT: pass
  EVIDENCE: pending

## Audit note (W00 audit 2026-09-13)

The checked items above use a rerun-on-demand CHECK/EXPECT convention and cite no persisted receipts. One CHECK was re-run live and still holds; the others were not re-run in this audit. Persist command output for each before treating them as final evidence. The factory-assurance worktree carries an uncommitted change marking E4 as done while its own evidence line records "2 fail"; that change is preserved as /tmp/factory-platform-evidence/w00/assurance-dirty-GATES.patch and must not be merged as written.
