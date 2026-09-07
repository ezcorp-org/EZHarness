# Extension v4: independent validation handoff

## Assignment

Audit PR [#246](https://github.com/ezcorp-org/EZHarness/pull/246). Determine what is tested, what is not tested, and which removed features need a product decision. Reproduce and fix test or implementation defects within the approved extension rewrite. Do not restore removed features without a product decision.

The user requires a secure, flexible extension system with simple harness authoring and reliable harness-built extensions. Passing tests alone does not prove that this requirement is met. Check the assertions and observable behavior, not only counts or coverage percentages.

Use a fresh agent context. If delegating, use Sol agents in separate worktrees with distinct ownership. One coordinator must schedule heavy tests; concurrent builds, coverage, and browser runs caused false timeout failures in prior work.

## Starting evidence, not a completion claim

At handoff preparation, the PR reports:

- Candidate: `2c73e6bac85cd8f288056250ff032f613bfc15cd`.
- Candidate tree: `4a5c5c7a27e8315c25262ecfb3c27db030493388`.
- Base: `65edc5bc0e36c6147219631e9cf73f89529bdef3`.
- Hosted run `33986413598` and companion runs: 32 technical checks pass. Gate integrity alone fails with 84 migration findings. Human approval remains absent.
- Later repairs added a direct SDK TypeScript dependency for the first clean install and changed invocation teardown to drain admitted notifications after handler failure. Audit these changes explicitly.
- Full 50-extension and production-image receipts in the existing gate documents identify earlier revisions. Do not attribute those runs to this candidate without new evidence.

These values can change. The local implementation worktree was still at `61ffa8fc` when this document was written. Do not audit that older checkout as the current PR.

## 1. Pin the work and read the rules

- [ ] Fetch the PR and base. Record exact head, base, merge base, and tree hashes in your audit report.
- [ ] Create an isolated worktree from the fetched PR head. Preserve the dirty original checkout at `/home/dev/work/EZCorp/EZHarness` and other agents' worktrees.
- [ ] Read `CLAUDE.md`, `src/extensions/CLAUDE.md`, `web/CLAUDE.md`, and any applicable `AGENTS.md` files in that worktree.
- [ ] Read `docs/development-lifecycle.md`, `PLAN.md`, `GATES.md`, `docs/extension-v4-validation.md`, `gates/final-validation.md`, and the current PR body.
- [ ] Create an audit checklist in `tasks/todo.md`. This directory is ignored and does not transfer between worktrees. Keep final findings in a tracked report.

Read-only starting commands, from an existing repository checkout:

```sh
git fetch origin --prune
git fetch origin refs/pull/246/head:refs/remotes/origin/pr-246-audit
git rev-parse origin/pr-246-audit origin/main
gh pr view 246 --json headRefOid,baseRefOid,isDraft,reviews,statusCheckRollup,body
```

Compare the fetched ref with the live PR head. If they differ, fetch again before creating the worktree. Read the current package scripts and CI workflow rather than copying old lane lists.

## 2. Prove the exact final build

- [ ] In a genuinely clean worktree, run the first root and web frozen installs. Record the first attempt and exit status. The web directory needs its own install. Verify that SDK preparation works without a compiler supplied by an old install.
- [ ] For reused dependency directories, force frozen installs and verify resolved package paths. Prior Bun installs retained stale AJV/fast-uri and MCP/Zod links while reporting success. A repair of reused dependencies is not proof of a first clean install.
- [ ] Run all local checks required by the current lifecycle document: backend wrapper, both web runners, typecheck, lint, Svelte, full coverage, new-file coverage, patch coverage, mock browser, real-auth browser, and visual evidence.
- [ ] Run the SDK default suite and the real rootless MCP opt-in suite separately. Run contract/schema, runner, harness-client, and AI-kit suites. Do not add opt-in subset counts to default totals as if they were distinct tests.
- [ ] Build the production image from the pinned candidate. Record its image ID, source tree, and build result. Run every production-container verification check.
- [ ] Run the strong first-party lifecycle verifier for every discovered extension. Reconcile the inventory with the report; the historical count is 50, not a hard-coded acceptance shortcut.
- [ ] Run actual disposable PostgreSQL lifecycle/revocation checks and runtime lock tests. Verify all seven existing cross-client authority fences, not just database connectivity.
- [ ] Obtain a clean full browser run, not a total assembled from a failed run and selected reruns. Inspect desktop/mobile screenshots and failed-update, disable, uninstall, and retained-history behavior.

Key commands; confirm prerequisites and current options in the repository first:

```sh
bun run test
bun run test:coverage
bash scripts/test-web.sh
(cd web && bunx --bun vitest run)
BASE_REF=origin/main bun scripts/check-new-file-coverage.ts
BASE_REF=origin/main bun scripts/check-patch-coverage.ts
EZCORP_RUN_PODMAN_TESTS=1 bun test ./packages/@ezcorp/sdk/src/v4/mcp.test.ts --timeout 30000
podman build --format docker --layers -t localhost/ezcorp-extension-v4:audit .
bash scripts/verify-extension-container.sh localhost/ezcorp-extension-v4:audit
EXTENSION_VERIFY_ALL=1 bun scripts/verify-first-party-lifecycle-v4.ts
bun test ./src/extensions/runtime-locks-postgres.test.ts --timeout 30000
```

Use `scripts/verify-extension-postgres.ts` with `EXTENSION_TEST_POSTGRES_URL` pointing only to an owned disposable database. Use the image pins and setup in the repository. Never put a production `DATABASE_URL` in test `.env` files. Direct test containers must select a supported log driver; pinned CI conmon previously failed with the implicit journald driver.

Use the real-auth config and the exact mock gate selection from the current lifecycle document and CI. Do not replace the strong lifecycle verifier with the weaker candidate-only verifier or enable fixture shortcuts.

## 3. Account for every untested integration

- [ ] Parse every lifecycle report. List each `unexercised` capability, absent smoke declaration, skipped check, and external dependency by extension and behavior.
- [ ] For each item, identify existing unit, integration, and live-service coverage. Separate a mocked response from a real external call.
- [ ] Add meaningful missing tests where safe. Check success, denied authority, invalid output, timeout, cancellation, and remote failure where those behaviors apply.
- [ ] Use approved test accounts, temporary resources, and least-privilege credentials for live checks. Ask for missing credentials or approval before billable or destructive actions. Never print secrets into evidence.
- [ ] Record unavailable integrations as `blocked`, with the missing input, owner, and exact next check. A mock is not a substitute for live-service proof.

Completion criterion: every discovered extension and declared capability has an explicit status. Zero failed lifecycle checks is not equivalent to full feature coverage.

## 4. Review the 84 migration findings and six feature decisions

Read `src/__tests__/extension-v4-migration-coverage.md` and `docs/extensions/v4-imports.md` at the pinned head. Independently verify the numbered mapping rather than accepting the previous agent's conclusion.

- [ ] Recompute Gate integrity without an approval override. Reconcile every finding with the ledger. The reported split was one retired threshold, 27 deleted test files, 25 renamed files, and 31 condensed files.
- [ ] Compare old assertions with replacement behavior. Confirm that replacement tests are discovered by required test runners and measured by the correct coverage runner.
- [ ] Flag lost assertions, rejection-only substitutes for working features, vacuous mocks, and tests that would still pass if the claimed protection were removed.
- [ ] Use controlled local fault injection for key security assertions where useful. Show that the tests fail when the protection is absent; restore the change and show that they pass. Never commit deliberate faults.

For each deliberate feature removal, record `accepted by maintainer`, `restoration required`, or `decision pending`:

| Decision | Behavior that lacks equivalent replacement proof |
| --- | --- |
| Development workflow | Automatic watcher, debounce, reload, and development-session shutdown |
| Permission UI | Inline visual composition and mutable capability toggles |
| Grant expiry | Per-capability TTL and Never renewal issuance |
| Data removal | Destructive discard/purge instead of immutable history and retained data |
| Imports and updates | Generic Git import and automatic updates |
| Host execution | Host lifecycle scripts and the removed extension-manifest/example `subAgents` field; active team and agent-config `subAgents` remain supported |

These are product changes, not automatically test defects. Refusal of a retired endpoint does not prove that its former feature still works. Do not restore unsafe host execution to obtain nominal parity.

## 5. Audit skipped tests and security coverage

- [ ] Inventory actual skips from the final run and source/config. The prior mock lane had 12 baseline skips; enumerate their names, reasons, affected behavior, and replacement evidence. Being old does not make a skip harmless.
- [ ] Confirm that the SDK opt-in container skip is closed by a real opted-in run. Identify any additional conditional tests hidden by platform or environment settings.
- [ ] Build a security matrix with a concrete assertion and runner for each boundary below. Mark absent tests as gaps, not passes.

| Boundary | Required checks to inspect or add |
| --- | --- |
| Harness self-build | Build does not approve; host does not execute extension config; pinned dependencies and integrity checks; source/artifact tampering and failed-build retention |
| Exact approval | Owner/project/release binding; stale approvals; cross-user denial; no agent/API-key approval bypass |
| Effect authority | Revocation during awaits; service scope/tool closure; ancestor workflow authority; no human impersonation or ambient settings |
| Storage and files | Same-transaction authorization and rollback; cross-scope denial; traversal/symlink/race resistance; no child-selected host paths |
| Worker isolation | Network and secret boundaries; subprocess/native escape attempts; resource exhaustion, worker crash, and cleanup |
| Invocation teardown | Handler error and first-notification error; all admitted effects drained; late effects rejected; original error retained |
| Recovery | Interrupted publication, process restart, retry/idempotency, lost acknowledgements, retained last working release |
| Browser/API | Real approval flow, foreign-origin denial, opaque iframe restrictions, unauthorized metadata access, desktop/mobile evidence |

Test both allowed and denied paths. Preserve the documented limits: rootless containers share a host kernel; trusted-local mode has reduced isolation; raw-secret access plus approved egress permits disclosure; rollback cannot undo an admitted external effect. State whether dedicated penetration, sustained-load, or fault-injection evidence exists. Do not imply that line coverage supplies that evidence.

## 6. Close the evidence, not just the checks

- [ ] For any defect, reproduce it near the real user path, add a regression, make the smallest root-cause fix, and rerun affected checks. Read both TESTS and COVERAGE verdicts.
- [ ] Preserve actual coverage. Prior failures involved Bun declaration-line records and two-stage CI LCOV merging. Reproduce with raw producer artifacts and the hosted merge sequence; do not delete misses, lower thresholds, or mock away real behavior to pass.
- [ ] Record each result with head/base/tree, command, tool versions, exit status, counts, artifact location, and any limits. Keep durable, sanitized evidence; `/tmp` paths alone are not a portable handoff.
- [ ] Recheck the base and head before publishing. Source or dependency changes invalidate affected receipts. List precisely which earlier results remain applicable and why.
- [ ] Before an authorized push, run normal hooks and required local checks. Then inspect every hosted job on the actual pushed head. Keep human policy approval separate from technical results.

## Required output and stopping rule

Write `docs/extension-v4-independent-validation-report.md` with:

1. Exact tested revision and base, plus the command/artifact index.
2. One row per gap from sections 2–5: `verified`, `fixed and verified`, `blocked`, or `product decision pending`.
3. The complete extension/capability and skipped-test inventories.
4. The 84-finding reconciliation and the six explicit product decisions.
5. Security findings, regression evidence, and residual limits.
6. A merge recommendation that separates technical readiness from required human approval.

Finish only when every listed check has evidence or a precise external blocker. Do not claim “everything tested” while any capability, skip, or product decision remains unresolved. Preserve failing evidence and report the action required to close each blocker.

Do not self-apply `gate-change-approved` or `evidence-exempt`, bypass hooks, mark the PR ready, or merge it. Those actions are not authorized by this handoff. End the user-facing report with **Your Actions:** and the remaining decisions or inputs.
