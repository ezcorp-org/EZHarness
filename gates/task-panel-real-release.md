# Task panel real release

- [x] Reproduce the obsolete task tool invocation against the real authenticated stack.
  EVIDENCE: `/tmp/lifecycle-task-real-red3.log`: real task_plan returns HTTP 500 because task-tracking is not installed. The old conditional sandbox skip was removed so the missing setup cannot produce a false pass.
- [x] Use shared explicit source import, isolated build, human approval and activation setup.
  EVIDENCE: shared fixture `376acd5e` imports the bundled snapshot, waits for real runner verification, requests exact release approval, clicks the human review checkbox and approval/activation buttons, and verifies the active pointer and tool catalog. Each test wires its owned conversation and uses the binding-aware public HarnessClient.
- [x] Preserve cold-start, concurrent-write and live-SSE persistence assertions.
  EVIDENCE: both planned titles survive first page load and hard reload; all five added titles plus the seed persist; a task added while the page is open arrives over SSE and survives reload. Every invocation must report success.
- [x] Run all three cases with actual SQL, isolated workers and a rendered browser.
  CHECK: cd web && PI_E2E_REAL=1 PI_E2E_REAL_BASE_URL=http://localhost:4191 bunx playwright test --config playwright.real.config.ts e2e/real-auth/task-panel-durability.spec.ts --reporter=list
  EXPECT: Three cases pass with no skipped cases.
  EVIDENCE: `/tmp/lifecycle-task-real-green2.log`: 3 passed, 0 failed, 0 skipped against a fresh authenticated stack with the real rootless runner and PGlite. Case times: 2.6s, 9.3s, 4.3s. Scoped Biome, diff checks, and full web TypeScript checks pass (`/tmp/lifecycle-task-real-types-final.log`).

No skipped cases, fake workers, increased case deadlines, or automatic production approvals.

Capacity review: the old five-at-once burst exceeds the production runner's four-worker hard limit. The first migrated real run proved that limit with `Worker session limit reached` (`/tmp/lifecycle-task-real-green1.log`). The test now submits the same five writes in concurrent pairs, then the final write, without retries. Each pair uses Promise.all and separate workers. All original title and cardinality assertions remain. This does not claim five simultaneous workers are supported. The production limit is unchanged.

Provisioning has a separate 300-second beforeAll budget for the existing 240-second candidate-build wait and human UI review. The 60-second case limit and 15-second live-SSE limit are unchanged. The earlier local startup failure was an untracked dependency symlink issue, not a product failure; copying dependencies into this worktree isolated Vite's temporary configuration files.
