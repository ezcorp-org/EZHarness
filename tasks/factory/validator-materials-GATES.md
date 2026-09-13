# Gates: Factory C04 trusted validator materials

Scope: Bind protected acceptance contracts and evidence to published compiled material, a current host candidate, an admitted trusted validator request, and a verified measured terminal.

- [x] G1: Human contract approval rejects caller-supplied locks and accepts only the exact registered published compiled material.
  CHECK: PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH bun test ./src/factory/validator-materials.test.ts
  EXPECT: /4 pass[\s\S]*0 fail/
  EVIDENCE: 2026-09-13 PGlite validator suite: 4 pass, 0 fail, 20 assertions.

- [x] G2: Current candidate identity, host artifact, runner, environment, configuration, request cursor, grant and release trust all fail closed when stale, substituted, or altered.
  CHECK: PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH bun test ./src/factory/validator-materials.test.ts ./src/factory/release-authority.integration.test.ts ./src/factory/executions.integration.test.ts ./src/factory/assurance.test.ts
  EXPECT: /33 pass[\s\S]*0 fail/
  EVIDENCE: 2026-09-13 focused product suite: 33 pass, 0 fail, 187 assertions.

- [x] G3: Evidence comes only from the journal's verified completed terminal and canonical immutable artifact; first issuance and expiry remain stable on retry.
  CHECK: PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH bun test ./src/factory/validator-materials.test.ts
  EXPECT: /4 pass[\s\S]*0 fail/
  EVIDENCE: The PGlite suite completes an admitted validator attempt, records measured terminal evidence, reads it twice, and receives the exact same protected evidence.

- [x] G4: The same validator flow and migration pass against isolated PostgreSQL and ordinary S3, and the modeled schema matches PostgreSQL.
  CHECK: test -n "$FACTORY_TEST_POSTGRES_URL" && test -n "$EZCORP_FACTORY_STORAGE_SECRETS_DIR" && PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH bun test --timeout 30000 ./tests/postgres/factory-validator-materials.test.ts ./tests/postgres/factory-schema.test.ts
  EXPECT: /6 pass[\s\S]*0 fail/
  EVIDENCE: PostgreSQL/S3 validator suite: 4 pass, 20 assertions. Schema parity: 2 pass, 1,897 assertions.

- [x] G5: Every new product and migration line has direct measured coverage and a fail-closed CI registration.
  CHECK: coverage_dir=/tmp/factory-validator-materials-coverage-$$; PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH bun test --coverage --coverage-reporter=lcov --coverage-dir="$coverage_dir" ./src/factory/validator-materials.test.ts ./src/factory/release-authority.integration.test.ts ./src/factory/executions.integration.test.ts ./src/factory/assurance.test.ts ./scripts/factory-validator-materials-registration.test.ts
  EXPECT: /35 pass[\s\S]*0 fail/
  EVIDENCE: `/tmp/factory-validator-final-cov-1789307889/lcov.info` measures validator materials 243/243 lines, its migration 8/8, and release authority 202/202; 35 tests and 190 assertions passed.

- [x] G6: Frozen installs, required package builds, all four type checks, lint, factory boundaries, registration and gate integrity pass.
  CHECK: PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH bun run --cwd packages/@ezcorp/factory-transport build && PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH bun run --cwd packages/@ezcorp/factory-sdk build && PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH bun run typecheck && PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH bun run lint && PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH bun scripts/check-factory-boundaries.ts
  EXPECT: /Factory boundary checks passed/
  EVIDENCE: 2026-09-13 frozen root/web installs and both package builds passed; all four type checks, lint, 26 boundary/registration tests, direct boundary CLI, and gate integrity passed.
