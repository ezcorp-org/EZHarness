# Policy audit command evidence

Date: 2026-09-05 (America/New_York)

Candidate: `3093a3a5e327b5ca6fb585b9f1271817553804e8`

Candidate tree: `e7d774a0d81983060dc60c2b92b9393ba464b05c`

Audit documentation commit: `c760e1e2ab4e4a4aef87b8612d47df1399f50838` (tree `dc34ac5a74e9c1968e26d89a894e61195204b1b8`). This commit changes only the canonical migration ledger. Product and test receipts apply to its parent candidate because the commit changes no executable source or test assertion.

Base and merge base: `537f074e7303ecdf3cbef1a7af4fd60a3244b0a3`

Base tree: `4e172ef704f4c348aeb92ae4ef2ce4d413543707`

Tools: Git 2.53.0; audit Bun 1.3.14 at `/tmp/ez-extension-bun-1.3.14/bun-linux-x64/bun`. An initial dependency-free confirmation used system Bun 1.3.9 and returned the same counts.

| Check | Command | Exit | Result |
| --- | --- | ---: | --- |
| Revision | `git rev-parse HEAD HEAD^{tree} <base> <base>^{tree}` | 0 | Exact hashes above. |
| Gate integrity | `env -u GATE_CHANGE_APPROVED BASE_REF=<base> <bun-1.3.14> scripts/gate-integrity.ts` | 1 | Expected policy failure: exactly 84 findings. No approval override was set. |
| Ledger numbering | Parse numbered table rows in `src/__tests__/extension-v4-migration-coverage.md` | 0 | Every integer 1 through 84 occurs once. |
| Current pools | Source `scripts/lib/test-file-sets.sh`; count `passfail_files`, `coverage_host_files`, and `web_bunleg_files` | 0 | Pass/fail pool: 1,560 files. Host coverage pool: 1,546 files. Web Bun pool: 221 files. |
| Moved discovery | Compare all 25 rename destinations with both current pools | 0 | No moved destination is absent from either pool. |
| Moved skip scan | Scan 25 destinations for `.skip`, `.todo`, `.only`, `testIf`, and `describeIf` | 0 | No match. |
| Moved assertions | Scan 25 destinations for `expect(` or `assert(` | 0 | 708 direct assertion call sites. This count is a review aid, not proof of assertion quality. |
| Moved title comparison | Extract `test` and `it` titles from base objects and candidate files | 0 | 24 pairs retain all titles. Row 37 renames two tests and adds one; its blanket title-retention claim is false. |
| Condensed runner assignment | Resolve all 31 surviving files through current runner definitions | 0 | 21 are in both Bun pass/fail and coverage pools; 9 `*.server.test.ts` files are in the Vitest include glob and V8 coverage leg; `web/src/__tests__/extensions-api.test.ts` is in the 221-file web Bun pass/fail pool. |

The complete Gate integrity output is deterministic from the pinned hashes and the command above. It reported 1 removed threshold, 27 deleted tests, 25 renamed tests, and 31 condensed tests. It ended with the required maintainer-label notice. No label was applied.

The original `2c73e6ba` checkpoint against base `65edc5bc` produced the same 84-finding split. Its candidate tree was `4a5c5c7a`; its P/C counts were 1,559/1,545. The latest-main fast-forward adds one discovered test to each pool and does not change any extension migration finding.

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
