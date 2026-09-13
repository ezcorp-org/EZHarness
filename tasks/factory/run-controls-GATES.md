# Authorized run controls gates

Status: ready for integration

## Behavior

- PGlite lifecycle: 44 passed, 644 assertions.
- PostgreSQL/S3 lifecycle before the final test-only authority extension: 43 passed, 635 assertions.
- SDK repair/replan and protected-input comparison: 4 passed, 17 assertions.
- Web route and browser client: 30 passed.
- Generic gate regressions: 204 passed, 487 assertions.
- Canonical real Temporal repair replay: 1 passed.

## Static and build

- Factory SDK build passed.
- Backend, web, backend-test, and web-e2e type checks passed.
- Repository lint passed with eight existing information findings and no errors.
- Production web build passed. Its existing external-module warnings remain informational.

## Coverage

- `src/factory/run-controls.ts`: 70/70 lines.
- `src/factory/transition-authority.ts`: 40/40 lines.
- `src/factory/run-inputs.ts`: 32/32 lines.
- `src/factory/run-lifecycle.ts`: 235/235 lines.
- `web/src/lib/factory/client.ts`: 86/86 lines.
- `web/src/routes/api/factories/_shared.ts`: 231/231 lines.
- The structural declaration-only TypeScript regression distinguishes interfaces/types from enums and runtime declarations.

## Receipts

- `/tmp/factory-platform-evidence/sol-run-controls-postgres-s3.log`
- `/tmp/factory-platform-evidence/sol-control-authority-checkpoint/temporal-replay-corrected.log`
- `/tmp/factory-platform-evidence/sol-run-controls-final-cov.path` points to the final bounded LCOV directory.
- Parent baseline failure retained at `/tmp/factory-platform-evidence/root-protected-effects-parent-coverage-patch.log`.

The ad hoc Bun-covered full Temporal suite used a 30-second test timeout and timed out one long case. Later workers then collided during teardown. This is not the canonical Node replay producer. The canonical focused Node replay above passed and the source did not change afterward.
