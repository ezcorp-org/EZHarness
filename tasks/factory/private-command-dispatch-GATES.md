# Private command dispatch gates

- [x] Stored command routing invokes the real existing product stores.
  EVIDENCE: PGlite 40 tests / 506 assertions; real PostgreSQL and ordinary S3 40 tests / 2,380 assertions. Published task admission, approvals, lazy input, child resolution, and the Node-to-Bun mTLS request boundary passed.
- [x] Required effect handlers, immutable inputs, and tenant/service identity fail closed.
  EVIDENCE: Unit and HTTPS tests reject missing handlers and foreign scope, retain captured references and handlers, and ignore forged request input/grants/resources/runner fields.
- [x] PGlite and PostgreSQL/S3 prove product behavior and changed-source coverage.
  EVIDENCE: Both final producers measure private-commands.ts 46/46 lines; unit/PGlite measures 13/13 functions. Logs and LCOV: /tmp/factory-platform-evidence/root-private-commands-final-*.
- [x] SDK build, all four typechecks, lint, boundaries, and coverage registration pass.
  EVIDENCE: root-private-commands-final-integration-results.json records build/product checks. The first type failure was an incomplete unit fixture; root-private-commands-types-remainder-integration-results.json records the corrected unit, four type legs, lint, gate integrity, and boundaries passing.
- [x] Committed patch/new-file coverage and parent integration pass.
  EVIDENCE: bdc630fd9 passed both committed coverage gates against bf7068ca1. Merged source ac656591e passed 124 product tests / 1,171 assertions, 142 PostgreSQL/S3 tests / 3,410 assertions, SDK and orchestrator builds, all four type checks, lint, boundaries, gate integrity, and all 77 real Node tests. Merged patch/new-file coverage passed against fe7be0bbe. Exact receipts: /tmp/factory-platform-evidence/root-private-validator-dispatch-merge-combined-integration-results.json and root-private-validator-dispatch-merge-coverage-results.json.

Review: This leaf composes the private command boundary and existing durable handlers. Full application startup, concrete remaining effect modules, runner execution, and launch gates remain open.
