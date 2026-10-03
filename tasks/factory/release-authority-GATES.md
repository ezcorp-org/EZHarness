# Gates: Factory C04 durable release authority

Scope: Persist exact runner terminal facts, project trust, release enablement, immutable candidate history, and per-run/node current candidate pointers.

- [x] G1: Candidate outputs use a dedicated node-instance and generation slot without changing interpreter identity semantics.
  CHECK: PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH bun test ./src/factory/release-authority.integration.test.ts
  EXPECT: /11 pass[\s\S]*0 fail/
  EVIDENCE: 2026-09-13 PGlite authority suite: 11 pass, 0 fail, 45 assertions, including two nodes at generation zero and the same node at its next generation.

- [x] G2: Authenticated terminal completion verifies the admitted request, exact settled journal evidence/cursor, measured usage, and immutable stored output bytes before writing a fact.
  CHECK: PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH bun test ./src/factory/release-authority.integration.test.ts
  EXPECT: /11 pass[\s\S]*0 fail/
  EVIDENCE: 2026-09-13 PGlite authority suite: 11 pass, 0 fail, 45 assertions, including admitted-request, operation-evidence, cursor, measured-usage, output-digest, and foreign-node denials.

- [x] G3: Human package/validator trust, default-disabled release control, epochs, revocation, live grant checks, lifecycle fences, and candidate CAS fail closed.
  CHECK: PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH bun test ./src/factory/release-authority.integration.test.ts
  EXPECT: /11 pass[\s\S]*0 fail/
  EVIDENCE: 45 expect() calls | Ran 11 tests across 1 file. [1471.00ms]

- [x] G4: The same migration, terminal, audit rollback, tamper, node scope, lifecycle and concurrency cases pass in an isolated real PostgreSQL database.
  CHECK: test -n "$FACTORY_TEST_POSTGRES_URL" && PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH bun test ./tests/postgres/factory-release-authority.test.ts
  EXPECT: /11 pass[\s\S]*0 fail/
  EVIDENCE: 45 expect() calls | Ran 11 tests across 1 file. [4.37s]

- [x] G5: New authority source and migration have complete measured line coverage; changed artifact/execution lines are exercised.
  CHECK: coverage_dir=/tmp/factory-release-authority-gate-coverage-$$; PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH bun test --coverage --coverage-reporter=lcov --coverage-dir="$coverage_dir" ./src/factory/artifacts.integration.test.ts ./src/factory/executions.integration.test.ts ./src/factory/release-authority.integration.test.ts && for source in src/factory/release-authority.ts src/db/migrations/add-factory-release-authority.ts src/factory/artifacts.ts src/factory/executions.ts; do awk -v p="$source" 'BEGIN{x=0;lf=-1;lh=-2} $0=="SF:"p{x=1} x&&/^LF:/{lf=substr($0,4)+0} x&&/^LH:/{lh=substr($0,4)+0} x&&/^end_of_record/{exit} END{exit !(lf>0&&lf==lh)}' "$coverage_dir/lcov.info" || exit 1; done; echo coverage-complete
  EXPECT: /coverage-complete/
  EVIDENCE: /tmp/factory-platform-evidence/release-authority-coverage-1789291863/lcov.info measures release-authority 169/169, migration 24/24, artifacts 95/95, executions 224/224, and schema 1249/1249 lines; producer passed 20 tests, 0 failed, 122 assertions.

- [x] G6: SDK builds, all four repository typecheck legs, lint, factory boundaries, and gate integrity pass on frozen source.
  CHECK: PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH bun run --cwd packages/@ezcorp/sdk build && PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH bun run --cwd packages/@ezcorp/factory-sdk build && PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH bun run typecheck && PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH bun run lint && PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH bun scripts/check-factory-boundaries.ts && echo static-complete
  EXPECT: /static-complete/
  EVIDENCE: /tmp/factory-platform-evidence/release-authority-typecheck.log records all four typecheck legs passed; /tmp/factory-platform-evidence/release-authority-lint.log records 4,806 files checked with no errors; factory boundaries passed; BASE_REF=HEAD gate-integrity passed after the final diff.
