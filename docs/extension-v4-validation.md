# Extension v4 validation

## Result

Production source is frozen at `af531cdd` (tree `beaa01d3b2a58bab7ed4ea9e95e049b3cc17e723`). Test-only coverage isolation and evidence documents are validated at `b5c4d0e6`. The original checkout was not modified.

All required local executable checks pass. Gate integrity remains deliberately red with 84 migration-policy findings that require a maintainer. No agent applied an approval label, reduced a threshold, added an exclusion, or waived visual evidence. Draft PR 246 can be updated for review, but it must not merge until the policy disposition, hosted CI, and non-author review pass.

## Final checks

| Check | Result | Evidence |
| --- | --- | --- |
| Backend isolated wrapper | 24,544 pass; 0 fail; 1,559 files | `/tmp/ez-final-backend-sol2.log` |
| Plain web | 4,120 pass; 0 fail; 221 files | `/tmp/ez-test-revision-test-web.log` |
| Web Vitest | 7,046 pass; 0 fail; 543 files | `/tmp/ez-test-revision-vitest.log` |
| Typecheck | All four lanes pass | `/tmp/ez-freeze-typecheck.log` |
| Svelte check | 0 errors; 13 warnings; 5 files | `/tmp/ez-freeze-svelte-check.log` |
| Lint | 0 errors; 105 warnings; 11 informational findings | `/tmp/ez-freeze-lint.log` |
| Full coverage | Bun 25,803/0; Node 4,551/0; 1,246 enforced files pass | `/tmp/ez-final-coverage-sol4.log` |
| New-file coverage | 131 new source files gated | `/tmp/ez-final-new-file-coverage-sol-final.log` |
| Patch coverage | All changed executable lines covered in 370 files | `/tmp/ez-final-patch-coverage-sol-final.log` |
| Full real-auth browser lane | 54 of 54 pass | `/tmp/ez-real-auth54-service-final-clean.log` |
| Mock browser lane | 210 pass; 12 baseline skips; 0 fail | `/tmp/ez-freeze-mock-gate.log` |
| Visual evidence | 11 surfaces; 23 Playwright specs | `/tmp/ez-final-visual-evidence-sol-final.log` |
| Production image | 8 of 8 pass | `/tmp/ez-service-final-container-verify.log` |
| First-party candidates | 50 of 50 pass | `/tmp/ez-all50-frozen.jsonl` |
| External PostgreSQL | 7 fences; lock cohort 2 tests/4 assertions | `/tmp/ez-sol-runtime-postgres-final.log`, `/tmp/ez-sol-runtime-locks-postgres-final.log` |
| Gate integrity | 84 maintainer-only migration findings | `/tmp/ez-final-gate-integrity-sol-final.log` |

The first backend attempt found a stale nested `fast-uri@3.1.5` link although the lock requires 3.1.6. `bun install --force --frozen-lockfile` repaired the local dependency tree. The exact parser contract then passed 13 tests and 178 assertions before the full backend rerun (`/tmp/ez-final-contract-uri-after-force.log`).

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
