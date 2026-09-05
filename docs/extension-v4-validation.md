# Extension v4 validation

## Result

The consolidated source and base freeze is `181b7512` (tree `faa5d8ac42d605ccdbd9e079942c80269278e01d`, base `65edc5bc`). Final leaf evidence is integrated through `94f0020e`. A fresh fetch immediately before coverage confirmed that `origin/main` remained at the integrated base. The original checkout was not modified.

All required local executable checks pass. Gate integrity remains deliberately red with 84 migration-policy findings that require a maintainer. No agent applied an approval label, reduced a threshold, added an exclusion, or waived visual evidence. Draft PR 246 can be updated for review, but it must not merge until the policy disposition, hosted CI, and non-author review pass.

## Final checks

| Check | Result | Evidence |
| --- | --- | --- |
| Backend isolated wrapper | 24,544 pass; 0 fail; 1,559 files | `/tmp/ez-finalbase-backend-sol.log` |
| Plain web | 4,120 pass; 0 fail; 221 files | `/tmp/ez-final2-test-web.log` |
| Web Vitest | 7,046 pass; 0 fail; 543 files | `/tmp/ez-final2-vitest.log` |
| Typecheck | All four lanes pass | `/tmp/ez-final2-typecheck-relinked.log` |
| Svelte check | 0 errors; 13 warnings; 5 files | `/tmp/ez-final2-svelte-check.log` |
| Lint | 0 errors; 105 warnings; 11 informational findings | `/tmp/ez-final2-lint.log` |
| Full coverage | Bun 25,803/0; Node 4,551/0; 1,246 enforced files pass | `/tmp/ez-final2-coverage-sol.log` |
| New-file coverage | 131 new source files gated | `/tmp/ez-final2-new-file-coverage-sol.log` |
| Patch coverage | All changed executable lines covered in 370 files | `/tmp/ez-final2-patch-coverage-sol.log` |
| Full real-auth browser lane | 54 of 54 pass | `/tmp/ez-real-auth54-181b7512.log` |
| Mock browser lane | 210 pass; 12 baseline skips; 0 fail | `/tmp/ez-final2-mock-gate.log` |
| Visual evidence | 11 surfaces; 23 Playwright specs | `/tmp/ez-final2-visual-evidence-sol.log` |
| Production image | 8 of 8 pass | `/tmp/ez-service-final-181b7512-container-verify.log` |
| First-party candidates | 50 of 50 pass | `/tmp/ez-all50-181b7512.jsonl` |
| External PostgreSQL | 7 fences; lock cohort 2 tests/4 assertions | `gates/workflow-service-effects.md` |
| Gate integrity | 84 maintainer-only migration findings | `/tmp/ez-final2-gate-integrity-sol.log` |

Forced frozen installs were required in both the root and web workspaces. They resolve MCP SDK 1.30.0 to Zod 4.5.2 and retain `fast-uri` 3.1.6; lockfile contents alone did not repair stale nested symlinks. The SDK, AI kit, harness client, contract, schema, runner and PostgreSQL package gates all pass on the resolved dependency tree; their exact receipts are recorded in `gates/workflow-service-effects.md`.

The final coverage repair does not hide production code. Three Bun route tests now install one shared, typed, fail-closed workflow-access mock before importing the route, and restore that mock after the test. Exact producer proofs emit no foreign `workflow-access.ts` coverage record. The final full wrapper and both coverage gates pass.

The Node coverage leg reports parse warnings for generated `.svelte-kit/.svelte-check` files. These are generated copies, not product syntax failures. Vitest passes 277 files and the source Svelte check reports zero errors.

## Security evidence

- Host-only service proofs cannot invoke release effects, tools, storage, virtual filesystems, reverse RPC, ambient settings, or another agent's private tool configuration. Sealed proofs retain explicit consent and tool-closure checks.
- Service authorization is validated at the effect boundary. Storage validates in the exact SQL transaction. Filesystem checks run after awaited path and native-handle boundaries. Revocation tests cover transaction rollback and paused workers after RBAC or tool-closure changes.
- The combined authority cohort passes 127 tests and 614 assertions (`/tmp/ez-service-authority-security-final.log`). ReleaseProcess changed lines pass 27 tests and 142 assertions with all new lines covered (`/tmp/ez-release-dedup-coverage.log`).
- The real browser service cases pass in the full 54-test lane. Case 53 completes in 37.1 seconds and case 54 in 37.5 seconds without removing authorization checks.

## Limits

- Rootless containers share the host kernel. A hostile host administrator is outside this boundary.
- Host registry resolution occurs before the offline integrity-pinned build.
- A user who grants both raw-secret access and approved egress can disclose that secret.
- Explicit trusted-local mode has reduced isolation.
- Cancellation and database rollback do not undo an already admitted external effect.

These are stated trust boundaries, not waived test failures. Required hosted CI and human review remain pending.
