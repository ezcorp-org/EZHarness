# Incus live completion plan — 24 September 2026

Contract: use only the isolated EZHarness app and the named `sandbox-server` Incus project. Preserve the old app database and credentials. A sandbox counts as working only when EZHarness owns its create, process, reconnect, and cleanup. Do not infer live IDs from tests or direct Incus guests. Server writes use exact reviewed plans and guarded rollback.

1. Verify the live CREATE claim from a consistent copy of the isolated app database. Keep the original app recoverable and healthy. Gate: `gates/incus-live-db-readback.md`.
2. Move the isolated app into the dedicated UID services with sealed settings, runner, database, and rollback checks. The recovery fence requires this separation. Gate: `gates/incus-app-cutover.md`.
3. Establish a live client hold, activate the independent observer with exact policy, and repair only the proved no-effect operation. Gate: `gates/incus-host-observer.md`.
4. Apply the exact current Incus setup plan, then create, use, reconnect, and clean up an EZHarness-owned guest. Run negative isolation and resource checks. Gate: `gates/incus-feature-e2e.md`.
5. Validate final source, hosted CI, and release claims. Gate: `gates/incus-pr-validation.md`.

The live steps are ordered: readback → dedicated cutover → required recovery → setup → guest test. Observer build and source/CI review can run alongside the cutover preparation. Each worker owns its named gate and evidence file; the driver rechecks decisive commands and integrates the result. The root gate is `gates/incus-final-live-2026-09-24.md`.

Status log:
- 2026-09-24: PR #6 merged into still-open NixOS PR #4; observer not active. Authenticated fixture status returned 409 for two guessed scopes. Live database readback is the first gate.
- 2026-09-24: Consistent detached copy confirms CREATE `62633686-a1bc-4b93-b87a-54fdbc96c2fd` is OUTCOME_UNKNOWN and belongs to fixture `live-fixture-20260924`; restored app status now returns 200 for exact scope. Verified instance `ezh-6b3b9dde8ce9a4cc358f04db0d5cbde1`.
