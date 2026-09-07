# Stale CI probe repair

This receipt records the removal of stale references to `web/e2e/real-auth/_sandbox-spawn-probe.bun.ts`. The original local regression test failed with exit 1; the repaired lane test passed 12 tests and 110 assertions. Lint, shell syntax, all four typecheck sections, and the normal commit hook passed.

The hosted real-auth log remains private. Its safe metadata records only the missing-module finding observed after runner kernel checks passed. No raw hosted log, credentials, or browser archive is published here.

The kernel probe was a separate local control: exit 0 with no owned roots. It does not replace hosted real-auth execution.
