# Atomic run lifecycle component gates

- [x] Pin immutable version, current grant and installation epoch before a durable start.
- [x] Commit run, lifecycle, root budget, start command, mutation receipt and audit together.
- [x] Persist cancelling state and cancellation epoch before new effects can be admitted.
- [x] Keep unknown charges until trusted reconciliation; prove rollback and current authority on retries.
- [x] Use project, installation, run, then component lock order without lock upgrades.
- [x] Prove the shared PGlite and actual PostgreSQL conformance suites, types, lint and measured lines.

Evidence: /tmp/factory-platform-evidence/lifecycle-final.log (51 tests,380 assertions); postgres-lifecycle-final-results.json (44 tests,334 assertions across5 suites); lifecycle-final-coverage/lcov.info (all owned source lines100%); lifecycle-types-final.log; lifecycle-lint-final.log. Canonical factory tests137 pass; temporal-partitions-parent-coverage/lcov.info proves11 orchestrator sources100% after the paged partition and repeated continuation integrations.

Required follow-up: typed lifecycle database model, real immutable staging and parameter service, application registry/boot/routes, trusted transition status projection, all runner/package/pool fences, real browser and full platform gates. No full platform claim is made by this leaf.
