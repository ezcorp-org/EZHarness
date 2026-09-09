# First-party host integration tests

These tests run in the harness test pool, not in extension build containers.
They exercise host modules, host policy, database state, or the subprocess boundary.
`scripts/lib/test-file-sets.sh` includes every `src/**/*.test.ts` file in the required pass/fail pool.

The directory name identifies the original extension. File names and assertions are retained.
`auto-note/legacy-subprocess.integration.test.ts` contains the subprocess tests split from
`docs/extensions/examples/auto-note/index.test.ts`. The portable unit tests stay there.
`ez-factory/triggers-host-contract.test.ts` contains the two host vocabulary checks split
from `extensions/ez-factory/lib/triggers.test.ts`. Its pure behavior tests stay there.

The other suites moved from the same relative path under `extensions/<name>` or
`docs/extensions/examples/<name>`. Imports and fixture locations now point to those source directories.
No test is skipped by this split. Legacy subprocess suites still require migration to the
v4 runner; moving them does not establish release compatibility or make their failures acceptable.

Each extension keeps its portable feature tests and an `extension.test.ts` test that loads
the real entrypoint, checks the registered manifest, and validates the resulting v4 definition.
The isolated candidate build must run these tests without access to harness source files.
