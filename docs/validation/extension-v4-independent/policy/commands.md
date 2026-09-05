# Policy audit command evidence

Date: 2026-09-05 (America/New_York)

Final source freeze: `ac53921ce07db8569eb8895456eda8271d6aab3f`

Final source tree: `ead56e1b614b215f7790eab41195f7c6a6d901d1`

Audit ledger commit: `c760e1e2ab4e4a4aef87b8612d47df1399f50838`. Portable policy evidence commit: `4f9bc0af`. The final freeze includes both plus the runtime and web repairs.

Base and merge base: `537f074e7303ecdf3cbef1a7af4fd60a3244b0a3`

Base tree: `4e172ef704f4c348aeb92ae4ef2ce4d413543707`

Tools: Git 2.53.0; audit Bun 1.3.14 at `/tmp/ez-extension-bun-1.3.14/bun-linux-x64/bun`. An initial dependency-free confirmation used system Bun 1.3.9 and returned the same counts.

| Check | Command | Exit | Result |
| --- | --- | ---: | --- |
| Revision | `git rev-parse HEAD HEAD^{tree} <base> <base>^{tree}` | 0 | Exact hashes above. |
| Gate integrity | `env -u GATE_CHANGE_APPROVED BASE_REF=<base> <bun-1.3.14> scripts/gate-integrity.ts` | 1 | Expected policy failure: exactly 84 findings. No approval override was set. |
| Ledger numbering | Parse numbered table rows in `src/__tests__/extension-v4-migration-coverage.md` | 0 | Every integer 1 through 84 occurs once. |
| Final pools | Source `scripts/lib/test-file-sets.sh`; count `passfail_files`, `coverage_host_files`, `web_bunleg_files`, `residual_passfail_files`, and `critical_backend_files` | 0 | P: 1,561; C: 1,547; W: 221; residual: 14; critical: 38. |
| Moved discovery | Compare all 25 rename destinations with both current pools | 0 | No moved destination is absent from either pool. |
| Moved skip scan | Scan 25 destinations for `.skip`, `.todo`, `.only`, `testIf`, and `describeIf` | 0 | No match. |
| Moved assertions | Scan 25 destinations for `expect(` or `assert(` | 0 | 708 direct assertion call sites. This count is a review aid, not proof of assertion quality. |
| Moved title comparison | Extract `test` and `it` titles from base objects and candidate files | 0 | 24 pairs retain all titles. Row 37 renames two tests and adds one; its blanket title-retention claim is false. |
| Condensed runner assignment | Resolve all 31 surviving files through current runner definitions | 0 | 21 are in both Bun pass/fail and coverage pools; 9 `*.server.test.ts` files are in the Vitest include glob and V8 coverage leg; `web/src/__tests__/extensions-api.test.ts` is in the 221-file web Bun pass/fail pool. |

The complete Gate integrity output is deterministic from the pinned hashes and the command above. It reported 1 removed threshold, 27 deleted tests, 25 renamed tests, and 31 condensed tests. It ended with the required maintainer-label notice. No label was applied.

The original `2c73e6ba` checkpoint against base `65edc5bc` produced the same 84-finding split. Its candidate tree was `4a5c5c7a`; its P/C counts were 1,559/1,545. The latest-main fast-forward adds one discovered test to each pool and does not change any extension migration finding.

Final source freeze `ac53921c` against base `537f074e` also returns exit 1 with exactly 84 findings and `GATE_CHANGE_APPROVED` unset. The full raw gate output is in the policy artifact bundle.

The final focused visual-evidence runner check passed 7 tests with 23 assertions. It covered tier partitioning, the `__ALL__` fallback, failure aggregation, spawn failure, invalid selections, distinct report retention, stale-output removal, config selection, and the real-auth environment.

At the second freeze, the effective event-grant bypass fault fails the denied-delivery assertion, and the todo root-denial fault fails the required tool-error assertion. Both faults were restored. The combined todo unit/E2E and event integration cohort then passed 30 tests with 116 assertions. Exact mutations and raw stdout/stderr are in the policy artifact bundle.

## Targeted security sensitivity

All install and test commands used the shared validation lock. Final test commands used `flock --close` so descendants could not retain the lock.

| Check | Exit | Result |
| --- | ---: | --- |
| Root `bun install --frozen-lockfile` with Bun 1.3.14 | 0 | 728 packages installed; SDK TypeScript build and Git-hook setup passed. |
| Baseline `bun test ./src/extensions/v4/lifecycle.test.ts --timeout 30000` | 0 | 28 pass, 0 fail, 126 assertions. |
| Human-approval fault: remove `actor.kind !== "human"` guard and run test name `builder cannot self-approve` | 1 | Expected rejection resolved. The test failed at `lifecycle.test.ts:215`; 0 pass, 1 fail, 2 assertions. |
| Restore human-approval guard and rerun named test | 0 | 1 pass, 0 fail, 7 assertions. |
| Blob-integrity fault: remove `FileBlobStore.get` SHA-256 recheck and run test name `concurrent identical writes are content addressed and tampering fails` | 1 | Corrupt bytes resolved instead of rejecting. The test failed at `lifecycle.test.ts:438`; 0 pass, 1 fail, 4 assertions. |
| Restore blob digest check and rerun named test | 0 | 1 pass, 0 fail, 4 assertions. |
| Restored full lifecycle file | 0 | 28 pass, 0 fail, 126 assertions. |
| `git diff --exit-code HEAD -- src/extensions/v4/lifecycle.ts src/extensions/v4/blobs.ts` | 0 | Both deliberate faults are fully restored. |

The fault commands changed one protection at a time. They did not change tests, fixtures, runner configuration, gates, or approvals. No deliberate fault is committed.
