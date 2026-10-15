# Atomic run lifecycle component gates

- [x] Pin immutable version, current grant and installation epoch before a durable start.
- [x] Commit run, lifecycle, root budget, start command, mutation receipt and audit together.
- [x] Persist cancelling state and cancellation epoch before new effects can be admitted.
- [x] Keep unknown charges until trusted reconciliation; prove rollback and current authority on retries.
- [x] Use project, installation, run, then component lock order without lock upgrades.
- [x] Prove the shared PGlite and actual PostgreSQL conformance suites, types, lint and measured lines.

Evidence: /tmp/factory-platform-evidence/lifecycle-final.log (51 tests,380 assertions); postgres-lifecycle-final-results.json (44 tests,334 assertions across5 suites); lifecycle-final-coverage/lcov.info (all owned source lines100%); lifecycle-types-final.log; lifecycle-lint-final.log. Canonical factory tests137 pass; temporal-partitions-parent-coverage/lcov.info proves11 orchestrator sources100% after the paged partition and repeated continuation integrations.

Required follow-up: typed lifecycle database model, real immutable staging and parameter service, application registry/boot/routes, trusted transition status projection, all runner/package/pool fences, real browser and full platform gates. No full platform claim is made by this leaf.

## Integration review

- [x] Model the lifecycle table and bounded definition metadata in Drizzle.
- [x] Compare live PostgreSQL columns, types, defaults and foreign-key counts directly with the application models.
- [x] Share project/installation locking with the execution journal.
- [x] Expose a trusted immutable live-run fence for acceptance and release composition.
- [x] Read native journal operations and their committed cursor in one transaction; reject corrupt or foreign snapshots.

Evidence: integration-stores.log has39 tests/330 assertions; actual PostgreSQL integration suites have62 tests/1054 assertions. Measured lines: factory-schema321/321, lifecycle108/108, executions203/203, native73/73, locks7/7. All four canonical typecheck sections pass in integration-types.log; integration-lint-final.log passes. Native output hashing now uses canonical serialized application output, including optional field removal and object-key order stability. API/bootstrap, empty-operation terminal handling, encryption and real service wiring remain required.
