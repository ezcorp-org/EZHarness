# Wire `trusted-local` — the explicit, per-release-approved unsandboxed extension mode

Branch: `feat/trusted-local-runner` (worktree `worktrees/trusted-local`, from `main` @ 2588c9f19).
Decision record: `docs/decisions/2026-09-12-extension-runner-install-burden.md` (Finding 3 + Proposal).

Contract: `TrustedLocalRunner` (built, tested, never wired) enforces per-(phase, digest) admin
approval with approver + expiry + acknowledged omitted controls, then audits. This work only
supplies the ignition: a fail-closed two-key operator gate, the approval store, the two human
acknowledgement points (Build, Approve exact release), and the loud signals (boot log, banner,
health). No bypass of `authorize()`. `runnerProfile` flips to `trusted-local-v4` so every existing
approval goes stale and must be re-approved under the new terms (free, via `checkApproval`).

## Backend — all implemented; see Review for verification

- [x] `packages/@ezcorp/extension-runner/src/trusted-local.ts`: export `trustedLocalImage(bunDigest)`
      (single definition of the `localhost/trusted-local@sha256:` format) and use it in the ctor.
- [ ] `src/extensions/runner-mode.ts` (new): `getExtensionRunnerMode()` — `isolated` | `trusted-local`;
      fail-closed on `EZCORP_EXTENSION_RUNNER` unknown value, on `trusted-local` without
      `EZCORP_EXTENSIONS_UNSANDBOXED_ACK` === exact sentence, and on `trusted-local` + isolated
      socket vars both set. `TRUSTED_LOCAL_PROFILE = "trusted-local-v4"`, `trustedLocalBunDigest()`
      memoized sha256 of `process.execPath`.
- [ ] `src/db/migrations/add-extension-trusted-local-approvals.ts` (new) + `src/db/migrate.ts` call +
      `src/db/schema.ts` table: `extension_trusted_local_approvals (installation_id FK cascade,
      phase, digest, approved_by, expires_at, omitted_controls JSON text, created_at)`
      PK `(installation_id, phase, digest)`, index `(phase, digest)`.
- [ ] `src/db/queries/extension-trusted-local-approvals.ts` (new): `recordTrustedLocalApproval`,
      `findTrustedLocalApproval(phase, digest)` (live rows only), `revokeTrustedLocalApprovals`
      (by installation, optionally by digest). TTL 180 days.
- [ ] `src/extensions/trusted-local-runner.ts` (new): `createTrustedLocalRunner(): Runner` — lazy
      async init (bunDigest, `provisionToolchain` with explicit sdkEntrypoint, `initialize()`),
      `approvalFor` → query module, `audit` → `insertAuditEntry`. Root
      `<projectRoot>/.ezcorp/extension-trusted-local`.
- [ ] `src/extensions/runner-connection.ts`: select by mode; return type `Runner`.
- [ ] `src/extensions/v4/types.ts`: optional `LifecycleDependencies.trustedLocal`
      `{ recordApproval(phase, digest, installationId, actor); revoke(installationId, digest?) }`.
- [ ] `src/extensions/v4/lifecycle.ts`: `build()` takes `acknowledgeUnsandboxed?`; when
      `trustedLocal` set → require it (`unsandboxed_acknowledgement_required`) and record
      `(build, sourceDigest)`. `approve()` takes options `{ acknowledgeUnsandboxed? }`; on
      approve when `trustedLocal` set → require it and record `(execute, artifactDigest)`.
      `revokeApproval()` and `stop()` → revoke rows.
- [ ] `src/extensions/extension-lifecycle-service.ts`: profile/image/dependency by mode.
- [ ] `src/extensions/extension-control.ts`: `extensions_build` schema + handler pass
      `acknowledgeUnsandboxed` (additionalProperties:false makes this mandatory).
- [ ] `web/src/routes/api/extensions/releases/[installationId]/approve/+server.ts`: accept
      optional boolean `acknowledgeUnsandboxed`.
- [x] `src/env-validation.ts`: call `getExtensionRunnerMode()` (boot fails closed on misconfig) and
      log error-level when trusted-local. (`context.ts` untouched — it already calls `validateEnv()`
      and has no logger of its own.)
- [ ] `src/health.ts`: detail gains `extensions: { runner: mode }`.
- [ ] `web/src/routes/api/auth/me/+server.ts`: add `extensionRunner: mode` (session-authenticated,
      no anonymous leak — the app shell already fetches this).

## Web

- [ ] `web/src/routes/(app)/extensions/author/+page.server.ts`: expose `extensionRunnerMode`.
- [ ] `web/src/routes/(app)/extensions/author/+page.svelte`: Build — unsandboxed note listing the
      seven omitted controls + required checkbox → `acknowledgeUnsandboxed: true`. Approval card —
      when `approval.runnerProfile === "trusted-local-v4"`, note + second required checkbox →
      approve body `acknowledgeUnsandboxed: true`. Header copy reflects the mode.
- [ ] `web/src/lib/components/UnsandboxedExtensionsBanner.svelte` (+ `.helpers.ts`, bun-tested):
      persistent, non-dismissable, mounted in `(app)/+layout.svelte` from the `/api/auth/me` fetch.

## Tests / gates

- [ ] `src/extensions/runner-mode.test.ts` — every fail-closed branch + both valid modes.
- [ ] `src/extensions/runner-connection.test.ts` — trusted-local selection returns a Runner that is
      not a `RunnerClient`; isolated path unchanged.
- [ ] `src/__tests__/extension-trusted-local-approvals.test.ts` — record/find/expiry/revoke (PGlite).
- [ ] `src/__tests__/lifecycle-trusted-local-ack.test.ts` — build/approve require ack when the
      dependency is set; record + revoke hooks called with exact digests; no-op when unset.
- [ ] Integration: `src/__tests__/trusted-local-runner-in-process.integration.test.ts` — the REAL
      `TrustedLocalRunner` through `createTrustedLocalRunner()` against PGlite approvals: build
      refused without row, allowed with row, execute likewise, audit rows written.
- [ ] `web/src/lib/components/UnsandboxedExtensionsBanner.helpers.test.ts`.
- [ ] e2e (real tier, own lane): `web/e2e/extension-author-trusted-local.spec.ts` `@evidence` —
      preview started by new `scripts/start-trusted-local-preview.sh`; workspace → build (ack) →
      approve (ack) → activate → banner visible → `captureEvidence`. Config
      `web/playwright.trusted-local.config.ts`. CI lane wiring is a CODEOWNERS change — note in PR.
- [ ] `scripts/coverage-thresholds.json` keys for every new source file (100).
- [ ] `docs/extensions/security.md` + `deploy/extension-runner/README.md`: document the mode.
- [ ] `bun run typecheck && bun run lint`; targeted suites; full pool vs. baseline (box is flaky).

## Review

**What the production-build lane found that source-mode tests could not** (all fixed, all now
covered by that lane — `web/playwright.trusted-local.config.ts`):

1. `seccomp.json` resolved via `import.meta.url` into `web/build/server/` — passed explicitly.
2. The trusted toolchain resolved from the bundle's location: `web/node_modules` (TypeScript 6, no
   `@types/bun`) instead of the pinned root closure — `provisionToolchain` gained `toolchainRoot`;
   also a correctness fix for "only from the installed trusted release".
3. Candidate verification (`verifyExtensionCandidate` → `runner.start`) is an `execute` of an artifact
   that has no release approval yet — refused by the runner. Fixed by deriving a fifteen-minute
   execute window from the build acknowledgement (`recordTrustedLocalVerificationApproval`), recorded
   in `runBuild` before verification. The build note on the author page names the verification run.

**Layering correction on the way:** `runner-connection.ts` must stay free of `db/` imports (a static
path into `db/connection` joins the repo's known import cycle and the server bundle then defers
module evaluation). The DB-backed hooks are built by `trusted-local-hooks.ts` and injected by the
lifecycle service (`configureTrustedLocalRunner`), which already loads `db/` lazily.

**Diagnostics closed:** the lifecycle's generic `operation_failed` branch now logs the unclassified
error with stack (it used to point at host diagnostics that did not exist); `trusted_approval_required`
is mapped to a legible operation diagnostic; the host's `approvalFor` warns with phase + digest when no
live acknowledgement exists.

**Behaviour to know:** in trusted-local mode the bundled first-party extensions are NOT auto-built at
boot — each build needs a human acknowledgement (twelve `Bundled source staging requires attention`
lines per boot; consistent with "bundled status does not imply trust"). The CLI's offline verify
cannot build in this mode (no acknowledgement to record) and says so.

**Box note:** one lane attempt (rerun 8) never started — Bun 1.3.9 segfaulted during the SvelteKit
build (`panic(main thread): Segmentation fault … a bug in Bun`), the same panic class the backend pool
showed on unmodified `main` earlier the same evening. Re-run after the pool finished.

**Merge with `main` (PR #269 conflicts):** eleven commits landed on `main` after the branch point;
nine files conflicted, all "both sides added". Resolved as the union in every case — #262's
`isExtensionRunnerConfigured()` beside the async-capable lazy wrapper (it now answers true in
trusted-local mode, without socket settings), #260/#265's named heading and installation rows beside
the unsandboxed acknowledgement UI, both JSON manifests merged, and the e2e fixture's shared
`BuildDeadline` kept positional with `extra` moved last (two of `main`'s callers pass the deadline
third). Re-verified: typecheck, lint, svelte-check, runner-connection 7/7 (incl. #262's probe),
bundled-v4-bootstrap 59/59, e2e-lanes 21/21, visual-evidence 7/7, vitest author-page/server-load/
routes 58/58, and the trusted-local production-build lane.

**CI round on PR #269 (two Opus agents in isolated worktrees):**
- Web shards 2/3: two pre-existing vitest files asserted the approve route's old four-argument
  `lifecycle.approve` call; now assert the exact fifth argument `{ acknowledgeUnsandboxed: undefined }`
  (`51e524124`).
- Coverage shard 0: a genuine regression of this PR. Keying the provisioning memo on
  `toolchainRoot` rebuilt the identical SDK bundle once per root, and a second `Bun.build()` in one
  `bun test` process trips a Bun file-descriptor reuse defect (`EISDIR` on regular files under the
  isolated `node_modules/.bun` store; reproduced standalone; `main`'s shard 0 is green). Fixed by
  caching the SDK bundle per entrypoint and the toolchain per root, sequentially; the new test counts
  real builds with a call-through spy (`78629cbf3`). CI-equivalent shard 0 run: 1902 pass / 0 fail.
- Also merged `main`'s #268 (repairs the #267 quality gates the first run used) — `3d94146e6`.
- Note for future agent runs: the harness cut both agent worktrees from `main`, not from the PR
  branch; both agents had to re-base onto the PR head themselves (`git switch -c`, since
  `git reset --hard` is blocked for them). Cherry-picked their commits onto the PR branch.

**CI round 2 — Per-file coverage gate** (`extension-lifecycle-service.ts` 99.02%, `runner-mode.ts`
90.63%, `trusted-local-runner.ts` 42.42%): the proof for all three lived in `*integration*` suites,
which the residual job runs WITHOUT coverage. Duplicated the proof outside it:
- `src/__tests__/trusted-local-runner-wiring.test.ts` — the host wiring with the runner PACKAGE
  stubbed: every option handed to the runner, the two hooks, unconfigured refusal, forget-on-failure,
  memoisation, and the SDK-entry override.
- `src/__tests__/extension-lifecycle-service-trusted-local.test.ts` — the SERVICE in trusted-local
  mode on real PGlite with the runner MODULE stubbed: hooks installed once and real (audit row +
  store), build refused without / recorded with the acknowledgement, `runBuild` records the
  fifteen-minute verification grant (shorter than the build row, same omitted controls), disable
  revokes.
- `trustedLocalBunDigest()` lost its catch-reset: the binary does not change while the process runs,
  so the memo now holds the failure too (three fewer lines to prove, and a clearer contract).
- **Bun coverage trap, measured:** bun keeps ONE lcov record per source path and the module copy
  loaded LAST owns it. A `?fresh=<uuid>` copy per test therefore reports any line only an earlier
  copy executed as a miss (8 missed lines with copies, 0 without, same assertions). The wiring test
  walks the module lifecycle in file order on the canonical instance instead.

**CI round 3 — Coverage shard 7:** `mock-cleanup-coverage.test.ts` (meta-test) flagged the service
test's `mock.module("../extensions/trusted-local-runner")` as unsnapshotted. Added the path to
`MODULE_PATHS` in `src/__tests__/helpers/mock-cleanup.ts` (cheap import graph, no db/daemon) so
`restoreModuleMocks()` can undo the stub. Every other check in that run was green; production
proofs were still pending.

**Verification results (final):**
- `bun run typecheck` ✓ (0 errors) · `bun run lint` ✓ (8 pre-existing infos, none in touched files).
- Unit/integration (one process per file): runner-mode 11/11 · runner-connection 6/6 ·
  trusted-local approvals 13/13 · lifecycle acknowledgement 12/12 · env-validation 14/14 ·
  health 9/9 · e2e-lanes 21/21 · hydration gate 6/6 · migrate idempotency 6/6 ·
  visual-evidence covers 7/7 (after adding the manifest entry) · runner package trusted-local 1/1 ·
  **real in-process runner integration 3/3**.
- Vitest: banner (component + unit) 7/7 · author page 7/7 · control/approve routes 9/9.
- Playwright: `extension-author-trusted-local.spec.ts` under the **trusted-local production build:
  1/1** (rerun 10; reruns 8–9 were killed by the box, not by code) and under the ordinary
  **isolated** real-auth server: 1/1.
- Full pool `PARALLEL=3`: 25590 pass / 12 fail in 9 files — eight green when run alone (box load;
  baseline `main` failed 14 in 8 files the same evening, disjoint sets), one real: the
  evidence-covers manifest, fixed above.

## PR #277 dependency validation

- [x] Review every changed dependency manifest and both Bun lockfiles against current `main`.
- [x] Keep `@types/bun` aligned with the repository's Bun 1.3.14 runtime pin.
- [x] Hold AI-kit Zod at 4.5.4 so its manifest, override, isolated npm lock, and root Bun lock agree.
- [x] Verify both frozen Bun locks and rerun the sole failed full-suite test.
- [x] Record the final dependency review and validation results.

### Review

- The original full suite reported 25,827 passes and one failed file. The only failure was the
  bundled-source lock mismatch caused by AI-kit declaring Zod 4.6.4 while its approved source lock
  still represented 4.5.4.
- Zod 4.6.4 resolved through the production extension-runner, but it produced MCP schema type errors
  in AI-kit's production source. AI-kit remains on 4.5.4. The web app keeps its independent 4.6.4
  upgrade.
- Root and web frozen installs pass with Bun 1.3.14. The production extension resolver fetched the
  AI-kit closure and confirmed Zod 4.5.4. The manifest freshness check passes, and the formerly
  failing bundled-source test now passes 2/2.

## PR #279 — agent instructions and complete Podman runbook

- [x] Confirm the PR branch, base, review state, existing instruction-file references, and current Podman docs.
- [x] Rename the root `CLAUDE.md` to the standard root `AGENTS.md` without changing its existing rules.
- [x] Add concise, complete development and production Podman run instructions to `AGENTS.md` and link to detailed deployment guidance instead of duplicating it.
- [x] Audit every Podman statement and command against the repository configuration, rendered Compose output, executable tests, and current primary Podman/Compose documentation.
- [x] Close documentation and test gaps found in the full PR diff while keeping the change focused.
- [x] Run focused tests, formatting/lint checks, and repository-level checks that cover all changed files.
- [x] Merge the current PR base if needed, commit, push to the PR branch, and watch all reported checks.

Plan review: preserve the original Podman fix, use `AGENTS.md` because that is the supported agent-instruction filename, keep one canonical detailed runbook, and prove commands before describing them as supported.

### Review

- Renamed the root instruction file to `AGENTS.md` and updated all live root-file references. Nested, scope-specific `CLAUDE.md` files remain unchanged.
- Added tested rootless Podman commands for the Linux development stack and the Linux/macOS production stack. Renamed the production override to `compose.podman-prod.yml`.
- Proved the uid/gid and bind-mount contract with executable tests, rendered Compose output, the production image user, and real rootless Podman write tests.
- Merged the current `main` and the concurrent PR-head merge without conflicts. The merged source tree is identical to the fully validated tree.
- Verification passed: lint, typecheck, production build, focused tests, 2,185 browser tests, 26,602 coverage tests, and all 1,631 enforced coverage files.

## Repair PR #284 against current main — 2026-09-21

- [x] Confirm the exact PR head and current `origin/main` in an isolated worktree.
- [x] Run the focused wrapper test on the PR head as a baseline.
- [x] Merge `origin/main` and resolve the wrapper and test conflicts as a semantic union.
- [x] Add or adjust regression coverage for the combined behavior.
- [x] Run focused tests, shell syntax, typecheck, lint, and Svelte checks.
- [x] Review and commit the repair without pushing.

Plan review: preserve PR #284 release diagnostics, provenance reporting, and cache reuse while
retaining `main`/#286's default wrapper behavior. Compare the base and both parents for each
conflict, and do not change behavior outside the conflict repair unless a regression test exposes a
required correction.

Review: merged PR head `47aa41a25` with `origin/main` `b43558b34`. The wrapper now exports PR
#284's checkout revision before it executes #286's selected Compose client with the selected stack's
environment-file arguments. The merged test keeps the PR's isolated Git fixture and adds positive
proof that the revision reaches both the standalone Compose client and the production stack.

Verification: under pinned Bun 1.3.14, the PR-head baseline passed 28 tests and 64 assertions. The
merged focused set passed 45 tests and 135 assertions, including image provenance, bounded
release-blob diagnostics, both wrapper stacks, and the macOS trusted-local documentation contract.
A real Podman-socket-backed Compose render listed all development and production services after
explicit test-only runner inputs; missing inputs failed at the intended preflight guards. `bash -n`,
full typecheck, lint over
4,609 files, and Svelte check passed with zero errors. No blocker remains.

## Repair PR #284 provenance audit findings — 2026-09-21

- [x] Merge `origin/main` at `0f949c307` and preserve the semantic union.
- [x] Add red regression coverage for non-build wrapper commands outside a Git checkout.
- [x] Add red regression coverage for a dirty image build followed by a clean checkout.
- [x] Make Git-derived build identity optional while preserving explicit `EZCORP_BUILD_COMMIT`.
- [x] Record and diagnose a reproducible build-time dirty/content marker.
- [x] Run focused tests, Compose renders, shell syntax, lint, type checks, and Svelte checks.
- [x] Review and commit the repair without pushing.

Plan review: keep provenance useful but recoverable. Commands that do not build must work without
Git metadata. Image provenance must retain whether image-backed tracked files were dirty at build
time, even if the working tree is clean when diagnostics later run.

Review: merged `origin/main` `0f949c307` without conflicts. Git lookup failures now produce the
recoverable `unknown` revision and source state, so development and production `logs`, `down`,
`ps`, and `config` still reach Compose. The wrapper records tracked build input state as the
bounded `clean`/`dirty`/`unknown` enum; Dockerfile.dev stores it in an OCI label and runtime env,
and the startup diagnostic warns when a dirty image meets a later-clean checkout.

Verification: the new tests failed before the implementation and now pass. Focused provenance
tests passed 41/41; the wider static Compose set passed 107/107. Real Podman-backed Compose
renders passed for both stacks, and the rendered dev build carried the explicit revision and
`dirty` marker. `bash -n`, `sh -n`, `git diff --check`, lint over 4,610 files, full typecheck, and
Svelte check all passed with zero errors.

## Repair PR #284 final provenance audit findings — 2026-09-21

- [x] Detect every untracked, non-gitignored Docker build-context input without generated noise.
- [x] Preserve explicit provenance from shell, `.env`, `--env-file`, and `--env-file=value`.
- [x] Preserve recoverable `unknown` provenance outside Git without overriding explicit dotenv values.
- [x] Inspect the actual built dev image OCI labels and runtime environment.
- [x] Keep #286 wrapper and #291 container-engine behavior intact.
- [x] Run pinned focused tests, real Compose/image checks, lint, typecheck, Svelte check, shell syntax, and diff checks.
- [x] Review and commit the repair without pushing.

Plan review: keep Compose as the only dotenv parser. Derive provenance into separate fallback
variables consumed by nested Compose defaults, so shell, the repository `.env`, and caller env files
keep their native Compose semantics. Source-state detection must compare tracked content and
enumerate only untracked files that Git does not ignore and Docker can send. The final test must
inspect container-engine image metadata, not source strings.

Review: Git-derived provenance now lives in separate fallback variables, so Compose remains the
only parser for explicit shell, `.env`, and caller env-file values. Dirty detection combines the
tracked diff with untracked files filtered by Git's standard ignores and the active dev
`.dockerignore`. The regression covers a build-relevant untracked file, ignored/generated noise,
root-only Docker ignore semantics, cleanup back to a clean checkout, quoted duplicate dotenv
values, both env-file spellings, and a no-Git archive. A new CI job builds `Dockerfile.dev` through the existing Buildx GHA cache and the
shared engine verifier inspects the loaded image's OCI labels and runtime environment. A real
two-build Podman check exposed stale label and environment metadata when only late build arguments
changed. The Dockerfile now materializes those arguments in a small layer before metadata is set,
so provenance refreshes while the dependency and workspace layers remain cached.

Verification: merged current `origin/main` `bd6fd9714` (#277 dependency updates) without conflict,
then refreshed both lockfile installs under pinned Bun 1.3.14. The real Podman dev build completed
and inspected the requested revision plus source-state `dirty` in both OCI labels and runtime env.
An immediate cached rebuild with a different revision and `clean` state also inspected the new
values in both channels, with the heavy build layers cached.
Eight focused files passed in isolated processes: 103 tests and
309 assertions. Full typecheck, lint over 4,610 files, Svelte check (0 errors, 0 warnings), gate
integrity, `bash -n`, `sh -n`, and `git diff --check` passed.

## Repair PR #284 final provenance review — 2026-09-21

- [x] Add a red wrapper regression for a Git-ignored file that Docker includes.
- [x] Detect every untracked Docker-context input without treating Git ignore as Docker ignore.
- [x] Add a red rendered-command regression for Docker rebuild source-state provenance.
- [x] Print a truthful Docker rebuild command that records commit and source state.
- [x] Preserve Compose precedence, no-Git recovery, and cached metadata refresh behavior.
- [x] Run focused tests and the full static verification gates.
- [x] Review and commit the repair without pushing.

Plan review: test the public seams already confirmed by the final review: the real Podman wrapper's
environment handed to Compose, and the recovery command rendered by the startup warning. Use
Docker's ignore contract as the source of truth for build-context inputs; Git ignore must not erase
files that Docker sends.

Review: extracted one source-state resolver shared by the Podman wrapper and the direct-Docker
recovery command. It enumerates all untracked worktree files, including Git-ignored files, then
applies the active Docker exclusions with root-only, recursive, and negation behavior covered by
the wrapper suite. The recovery command now supplies both the checkout revision and the resolver's
truthful source state; a real Compose render proves that clean and dirty values reach build args.

Verification: both regressions failed before the repair and passed after it. Six focused files pass
89 tests under Bun 1.3.14. Full typecheck and lint over 4,610 files pass. Svelte check reports zero
errors and warnings. Gate integrity, Bash/sh syntax, and `git diff --check` pass.

## Repair PR #284 final independent audit — 2026-09-21

- [x] Reproduce the runtime false negative for a Git-ignored Docker input.
- [x] Reproduce the false dirty stamp for a tracked Docker-excluded file.
- [x] Apply one Docker-context resolver to tracked and untracked changes.
- [x] Make the startup warning use that shared resolver.
- [x] Add regressions for both reproduced failures.
- [x] Run focused tests and the full relevant static gates.
- [x] Review and commit the repair locally without pushing.

Plan review: keep one source of truth for Docker build-context state. Filter tracked and untracked
changes through the same ordered `.dockerignore` matcher, then use the resolver for both image
build stamps and startup comparison. Preserve Compose precedence, safe recovery commands, and the
recoverable `unknown` result when Git metadata cannot be read.

Review: the resolver now enumerates tracked changes, deletions, both sides of renames, and every
untracked Docker input, including files hidden by Git ignore rules. It filters all candidates with
one ordered matcher derived from the active Dockerfile-specific or root ignore file. The startup
warning calls that resolver instead of `git status`, prints one rebuild command for current context
drift, and stamps a truthful `unknown` revision when Git metadata is unavailable. The resolver also
removes inherited repository/index overrides before it reads the checkout or creates its private
matcher.

Verification: both new regressions failed before the repair and now pass. The focused provenance,
wrapper, engine, and release-blob set passes 85 tests across five files. Full typecheck, lint over
4,610 files, Svelte check, the production build, gate integrity, Bash/sh syntax, and
`git diff --check` pass. A focused regression also proves inherited Git overrides cannot change the
checkout's `core.bare=false` setting. The production build needed the Nix store's `libstdc++.so.6` on
`LD_LIBRARY_PATH`; after that environment correction it completed successfully.
