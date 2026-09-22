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

## Repair PR #284 publication-gate findings — 2026-09-21

- [x] Reproduce hidden-index false-clean results for included Docker-context paths.
- [x] Compare included assume-unchanged and skip-worktree paths with `HEAD` independently of index hints.
- [x] Keep unchanged and Docker-excluded hidden-index paths clean.
- [x] Classify exactly half missing release blobs as partially missing.
- [x] Run focused tests and full static gates.
- [x] Review and commit the repair locally without pushing.

Plan review: keep the existing ordered Docker-ignore matcher as the single inclusion authority.
Audit only tracked paths whose index flags can suppress the normal `git diff HEAD` result, and
compare included regular-file bytes, presence, and executable mode directly with the `HEAD` tree.
Treat unsupported hidden entry types conservatively as dirty. Keep release diagnostics precise by
reserving `mostly_missing` for a strict majority.

Review: the shared resolver now enumerates the index entries whose assume-unchanged or
skip-worktree hints can suppress `git diff HEAD`. It applies the existing ordered Docker-context
matcher first, then compares each included regular file's raw object hash, presence, and executable
mode directly with the `HEAD` tree. Unchanged and Docker-excluded entries stay clean; unsupported
hidden entry types fail safely as dirty. The blob audit now uses a strict majority for
`mostly_missing`, so an exact half receives the partial-loss recovery guidance.

Verification: all three new regressions failed before the repair and pass after it. Real sparse
checkout and assume-unchanged fixtures now report `dirty`. Five focused files pass 90 tests and 254
assertions. The complete backend pool passes 25,891 tests across 1,655 files with zero failures.
Typecheck, lint over 4,610 files, Svelte check, production build, gate integrity, Bash/sh syntax,
ShellCheck, and `git diff --check` pass.

Post-merge verification: merged `origin/main` `d81f98387` (#290) and preserved both task histories;
there were no product-code conflicts. The combined #284/#290 focused set passes 107 tests with one
intentional container-only skip and 338 assertions. Typecheck, lint over 4,613 files, Svelte check,
production build, gate integrity, shell syntax, and the staged diff check pass.

## Repair PR #284 publication-gate context truth — 2026-09-21

- [x] Reproduce Docker's parent-exclusion and negated-child behavior against a real image build.
- [x] Replace Git-ignore translation with a pinned Docker-compatible matcher.
- [x] Compare every included tracked path directly with the `HEAD` blob, type, and executable mode.
- [x] Detect context changes hidden by Git stat shortcuts, `core.symlinks`, index hints, and Git ignores.
- [x] Preserve excluded tracked, untracked, empty-directory, and nested-test controls.
- [x] Run focused tests, full static gates, the production build, and a real dev-image metadata proof.
- [x] Review and commit the repair locally without pushing.

Plan review: use Docker's matcher for Docker rules and the `HEAD` tree for committed truth. Do not
infer build inputs from Git ignore or index state. Walk excluded directories only when a scoped
negation can restore a descendant; return `unknown` when safe pruning cannot be proved.

Review: the resolver now delegates ordered ignore and negation semantics to
`@balena/dockerignore`. It walks the real context for untracked files and empty directories, then
hashes included regular files and symlink targets directly against `HEAD` with executable-mode
checks. Sanitized Git is used only to identify the repository, revision, object format, and tree;
index flags, stat caches, replacement objects, inherited Git variables, and host configuration
cannot produce a false `clean`. The shell entry point still degrades to `unknown` without Bun or
Git. The image-provenance CI timeout is 40 minutes because a lockfile change invalidates both
frozen installs and the existing image-wide ownership layer; cached runs remain fast.

Verification: adversarial fixtures reproduced both publication-gate failures before the repair.
The parent-excluded negated child was present in an actual Docker image while the old resolver said
`clean`; same-size content with a restored mtime and a symlink replaced under `core.symlinks=false`
also returned false `clean`. The focused provenance suite now passes 60 tests and 192 assertions;
release-blob diagnostics pass 6 tests and 29 assertions. Full typecheck, lint over 4,614 files,
Svelte check, production build, gate integrity, shell syntax, and `git diff --check` pass. A cold
real Docker build installed the new dependency and verified the requested revision and `dirty`
state in both OCI labels and runtime environment.
## PR #288 repair — Podman setup safety and timeout accuracy

- [x] Reproduce each audit finding with focused setup-script tests.
- [x] Make trusted-local configuration an atomic, concurrency-safe rewrite that preserves every existing byte and secret.
- [x] Require the exact trusted-local Compose path and acknowledgement when detecting configured state.
- [x] Reject unsafe existing environment-file permissions without changing the file.
- [x] Probe the Linux Compose command with the same semantics as the wrapper.
- [x] Bound readiness work by an elapsed deadline, including curl and sleep time.
- [x] Add the strongest available portability check without claiming unavailable Bash 3.2 runtime coverage.
- [x] Run syntax, focused tests, lint/type checks as relevant, and inspect the final diff.
- [x] Commit the repair without pushing.

Plan review: keep the setup script dependency-free and Bash 3.2-compatible. Use private sibling files plus atomic rename for an accepted trusted-local update, while refusing concurrent drift. Preserve existing files byte-for-byte except for the approved runner block. Test observable subprocess behavior with stubs and controlled time sources; do not use real wall-clock thresholds.

### Review

- The accepted trusted-local choice now uses a private sibling file, a serialized re-check, and an atomic rename. Existing bytes and secrets remain intact; a failed rename and eight concurrent runs are covered.
- Trusted-local is configured only when both the exact Compose path and exact acknowledgement are the effective values. Linux isolated-runner detection remains unchanged.
- Existing environment files with any group/other permissions fail before file or data-directory changes. The operator gets the exact `chmod 600` repair.
- Linux executes `docker compose version` and falls back only when `docker-compose version` succeeds, matching the production wrapper.
- Readiness uses one epoch deadline. Curl and sleep each receive the remaining-time cap; deterministic clock stubs prove both bounds without wall-clock assertions.
- CI now runs the full 30-test behavior suite on macOS with `/bin/bash` and first verifies that it is real Bash 3.2. The job feeds the existing required Backend tests aggregate.
- Verification: focused suite 30/30; `bash -n`; ShellCheck 0.11.0; Biome full lint; full typecheck; workflow YAML parse; gate integrity; `git diff --check`.

## PR #288 final audit repair

- [x] Keep generated secrets out of child arguments and logs, with a regression probe.
- [x] Make runner detection reject conflicting trusted-local state on Linux.
- [x] Detect external environment-file drift before atomic publication.
- [x] Replace the stale mkdir lock with a PID-owned, crash-recoverable protocol.
- [x] Derive readiness from `EZCORP_PORT_HOST` and use a clock-independent strict budget.
- [x] Correct the Linux installation claim in the README.
- [x] Run focused tests, Bash syntax, ShellCheck, lint, typecheck, workflow parsing, gate integrity, and diff checks.
- [x] Merge a newer `origin/main` if present, then commit without pushing.

Plan review: keep the implementation dependency-free and compatible with Apple Bash 3.2. Store generated secrets only in private files, use fixed child arguments, and use portable `cmp` for the final drift check. A PID-named lock owner lets concurrent stale-lock cleanup remove only the dead owner's marker. Since portable shell has no compare-and-swap rename, perform the drift check immediately before the atomic rename and document the remaining instruction-level race. Account the maximum curl and sleep allocations against one integer budget so wall-clock changes cannot extend readiness.

### Review

- Generated secrets now flow from OpenSSL into a mode-600 data file and through fixed AWK arguments. The regression stubs every prior/current text processor and proves the known generated value appears in the env file but not child argv or output.
- Runner detection stops on any non-empty, non-exact Compose override. A Linux regression combines a wrong trusted-local acknowledgement with stale isolated values and proves it is refused.
- Trusted-local publication snapshots the source, compares it immediately before rename, and leaves an injected external edit intact. Portable shell cannot close the final `cmp`-to-`mv` instruction interval; the source documents that limit.
- Lock ownership is a PID-named marker. Dead owners are recovered without deleting a later owner's marker; both a single recovery and eight concurrent recoveries pass.
- Readiness derives the documented host port, honors an explicit URL override, and charges maximum curl and sleep allocations to one clock-independent budget.
- Verification passed: focused suite 37/37; Bash syntax; ShellCheck; full Biome lint; full backend, web, and backend-test typecheck; workflow YAML parse; gate integrity; and `git diff --check`. `origin/main` remained at `0f949c307` after a fresh fetch, so no merge was needed.

## PR #288 final race-free repair

- [x] Add failing tests for immutable existing env files, unsafe concurrent creation, full readiness duration, public admin URL, and fresh/stopped macOS engine paths.
- [x] Refactor setup so a fresh private candidate receives the complete runner choice before one atomic no-clobber publication.
- [x] Never rewrite an existing env file; print exact manual trusted-local settings and stop when its runner state is incomplete.
- [x] Remove the runner-update lock and all stale/PID ownership machinery.
- [x] Replace double-counted readiness accounting with a Bash 3.2/BSD-portable watchdog that enforces the complete timeout.
- [x] Use `EZCORP_PUBLIC_URL` for the printed admin URL while keeping the readiness probe on the explicit URL or host port.
- [x] Correct the README claims.
- [x] Run focused tests, Bash syntax, ShellCheck, workflow syntax, lint, typecheck, gate integrity, and diff checks.
- [x] Challenge the final state machine for unnecessary states or duplicated parsing, then commit without pushing.

Plan review: existing operator files are immutable. Only a private fresh candidate can be changed, and it is published once with `ln` after all choices and validation. A losing concurrent creator must discard its candidate and restart the full existing-file validation path. Readiness uses one relative `read -t` watchdog rather than wall-clock arithmetic.

### Review

- Merged `bd6fd971` before implementation. The dependency-only change had no setup-code overlap.
- Reduced environment handling to two states: validate an immutable existing file, or finish and validate one private fresh candidate before a single no-clobber hard-link publication. Concurrent losers restart existing-file permission and runner validation. No update lock or PID state remains.
- Existing incomplete files now stop with exact manual runner settings and remain byte-for-byte unchanged. Fresh rejected choices publish nothing.
- Readiness uses a private FIFO plus Bash 3.2 `read -t` as one relative watchdog. Fast failures no longer spend synthetic time, active curl/sleep children are stopped at timeout, the probe honors the explicit URL or host port, and the completion message uses `EZCORP_PUBLIC_URL`.
- Added fresh macOS install, stopped-machine, new-machine, unsafe publication race, immutable file, full-duration retry, watchdog, and public-URL regressions.
- Verification passed with Bun 1.3.14: focused suite 37/37 and 134 assertions; Bash syntax; ShellCheck; full lint; all backend, web, backend-test, and web-E2E typecheck legs; workflow YAML parse; gate integrity; and `git diff --check`.

## PR #288 independent final-audit repair

- [x] Add failing regressions for placeholder production secrets, Compose environment precedence, macOS Compose probing, and false isolated-runner provisioning.
- [x] Preserve existing environment files while rejecting unsafe or incomplete effective production configuration with exact manual fixes.
- [x] Use Compose precedence for readiness and admin URLs.
- [x] Share functional Compose probing across macOS and Linux, and require Homebrew only when installation is necessary.
- [x] Require a numeric isolated-runner GID, a live Unix socket, and a non-empty token file.
- [x] Make `--check --accept-unsandboxed-extensions` report the accepted path accurately.
- [x] Run focused tests, syntax/static checks, repository gates, and inspect the final diff.
- [x] Commit the repair locally without pushing.

Plan review: keep existing operator files immutable. Validate the values Compose will actually use, with shell overrides taking precedence over the environment file. Reuse one Compose capability probe on both operating systems. Keep every check compatible with Apple Bash 3.2 and avoid printing or passing secret values to child-process arguments.

### Review

- Existing files remain immutable, but setup now stops before data-directory or stack changes when required production values are missing, too short, or still use the public example placeholders. The error names only variable names and exact generation commands; it never prints a secret.
- Readiness and the printed admin URL now use exported shell values before parsed env-file values, matching Compose. Quoted scalar and inline-comment cases are covered.
- macOS accepts either working Compose spelling, installs standalone Compose only when needed, verifies the installed command, and no longer requires Homebrew on a fully provisioned host.
- Linux isolated mode now requires a numeric container GID, a real Unix socket, and a non-empty credential file. The positive test uses a live Unix socket instead of placeholder paths.
- Verification passed: 80 focused setup/wrapper tests with 250 assertions; full lint over 4,608 files; full typecheck including backend tests and web E2E; Bash syntax; ShellCheck 0.11; workflow YAML parse; gate integrity; real Linux `--check` with no filesystem changes; `git diff --check`; and Bash 3.2 syntax plus indirect-expansion behavior in the official `bash:3.2` image.

## PR #288 final credential and dry-run repair

- [x] Add failing end-to-end script regressions for invalid runner credentials, blocked check mode, and malformed public URLs.
- [x] Match the production runner credential contract without exposing credential contents.
- [x] Stop `--check` at unresolved runner decisions without claiming downstream work.
- [x] Require a parseable HTTP(S) public URL under Compose precedence.
- [x] Run focused tests, Bash 3.2/static checks, repository gates, and inspect the final diff.
- [x] Commit the repair locally without pushing.

Plan review: keep one Bash 3.2-compatible validation path for effective environment values. Validate credential metadata and content without putting values in argv or logs. Represent an unresolved check-mode runner decision as a blocked result so later steps cannot be reported. Preserve immutable existing environment files and atomic fresh publication.

### Review

- Isolated-runner setup now mirrors the production credential reader: absolute regular non-symlink files, bounded size, safe write permissions, and trimmed 32-character-or-longer values without whitespace, controls, or NUL bytes. Tests cover directory, short, writable, symlink, oversized, whitespace, NUL, and relative-path failures with a real Unix socket.
- Check mode now returns exit 2 at unresolved existing or fresh runner decisions and does not claim that bind-directory or stack work would follow.
- Effective public URLs must be parseable HTTP(S) values with a host and valid optional port before setup proceeds. Existing files stay byte-for-byte unchanged on rejection.
- Verification passed: 88 setup/wrapper tests with 305 assertions; 18 production runner contract tests with 92 assertions; full lint; full backend, web, backend-test, and web-E2E typecheck; ShellCheck; Bash syntax; gate integrity; `git diff --check`; and direct credential/URL behavior under the official Bash 3.2 image.

## PR #288 publication-gate repair

- [x] Replace local env-file parsing with the selected Compose client's resolved environment.
- [x] Require `EZCORP_PUBLIC_URL` to be one canonical HTTP(S) origin, including strict IPv4 and IPv6 validation.
- [x] Run all non-mutating template, effective-env, port, and timeout validation before `--check` can succeed.
- [x] Restrict installer-approved runner credentials to portable printable ASCII and cover Unicode whitespace.
- [x] Use `PODMAN_SOCKET` consistently from engine validation through wrapper launch.
- [x] Run focused tests, Bash syntax, ShellCheck, lint, typecheck, workflow parsing, gate integrity, and diff checks.
- [x] Review the complete change for secret exposure, temporary artifacts, duplication, and Bash 3.2 compatibility.
- [x] Commit the repair locally without pushing.

Plan review: use Compose as the single source of truth for quoting, interpolation,
comments, and exported-shell precedence. Keep its resolved output private and
read only a fixed whitelist. Keep URL and credential validation conservative,
portable, and independent of JavaScript tooling.

### Review

- The installer now reads its fixed effective-environment whitelist from the selected Compose client's `config --environment` output. Private sibling temporary files contain resolver output and errors, and traps remove them.
- Public URLs must be exact canonical HTTP(S) origins. Curl supplies maintained URL parsing without a network request; installer checks reject userinfo, paths, query strings, fragments, malformed IP literals, and invalid ports.
- `--check` validates template shape, actual Compose resolution, effective values, runner credentials, ports, and readiness limits without generating or writing real secrets.
- Installer-approved runner tokens use a documented portable printable-ASCII subset. Regression tests cover NBSP and BOM input.
- `PODMAN_SOCKET` is used consistently for engine checks and wrapper launch.
- Merged current `origin/main` at `d81f98387f7636603edb4f30aede740922fff700` after the repair. Verification passed: 88 focused tests with 358 assertions; 25,946 backend tests across 1,655 files; lint across 4,611 files; all backend, web, backend-test, and web-E2E typecheck legs; ShellCheck; workflow YAML parsing; gate integrity; Bash syntax; and `git diff --check`.

## PR #288 final publication gate

- [x] Reject effective Compose values that cannot be represented by the line-oriented resolver output.
- [x] Publish a fresh environment file to the exact target without following a directory or symlink race.
- [x] Reject stale runner sockets, URL forms that the application runtime cannot parse, and bind-source conflicts during `--check`.
- [x] Add end-to-end regressions for every publication-gate finding.
- [x] Run focused tests, Bash 3.2/static checks, lint, typecheck, workflow parsing, gate integrity, and diff checks.
- [x] Review the final diff, document verification, and commit locally without pushing.

Plan review: keep Compose as the source of truth for dotenv semantics, but reject
control or multiline values before line-oriented extraction can truncate them.
Use the POSIX `link` utility for an exact no-clobber hard link, then require the
published path to be the same regular non-symlink inode as the private candidate.
Keep every new validation read-only in `--check` and compatible with Apple Bash
3.2.

### Review

- Effective exported values now reject control characters before Compose runs.
  Dotenv double-quoted control escapes and physical multiline quotes fail before
  resolution; ambiguous multiline or duplicate resolved output fails afterward.
  Exact shell, quoted-newline, and interpolated-newline regressions do not print
  their values.
- Fresh publication now uses the POSIX `link` utility, which targets one exact
  pathname instead of treating a directory as a destination. Existing
  directories and symlinks fail closed, directory races cannot receive a nested
  secret, and success requires the exact target to be the same regular inode as
  the private candidate.
- Linux isolated-runner validation now requires an answering HTTP Unix socket,
  not only a socket inode. URL validation rejects IPv6 zone identifiers that
  curl accepts but Bun's WHATWG parser rejects. `--check` rejects bind sources
  that exist as non-directories.
- Verification passed on the exact tree: setup and wrapper tests 118/118 with
  412 assertions; full backend pool 25,955/25,955 across 1,655 files; lint over
  4,611 files; full typecheck; Bash syntax; ShellCheck; official Bash 3.2
  syntax/indirect-control/`-ef`/`link` behavior; workflow YAML parsing; gate
  integrity; real Compose adversarial probes; and `git diff --check`.

## PR #290 CI failure diagnosis

- [x] Capture the completed run and raw failed-job logs for run 35631461630.
- [x] Build and run the smallest end-user-aligned real-auth web-search E2E reproduction.
- [x] Compare the failure with main/PR #291 and classify it as product defect, test defect, or infrastructure flake.
- [x] Inspect every production-proof failure and separate root failures from downstream failures.
- [x] If a defect exists, add regression evidence, implement the smallest root-cause fix, and verify it. Otherwise, make no source edit.
- [x] Record the final evidence, commit any fix, and confirm clean worktree status.
- [x] Merge current `origin/main` (including merged PR #291), rerun focused checks, and leave a push-ready commit without pushing.

Plan review: preserve the PR's multi-architecture runner-image change. Diagnose the first causal failure before downstream coverage consumers. Do not add retries or waits without a reproduced product defect.

### Review

- Run 35631461630 had two independent producer failures. Real-auth passed 104 tests before one tools-endpoint GET ended with `socket hang up`; recovery passed R1, then the archived-image seed rejected missing or stale build evidence. Browser coverage, per-file coverage, production lifecycle, and aggregate E2E failures were downstream.
- Both signatures were transient. PR #291 passed the same three web-search tests and used the same archived source successfully. Among the latest 30 CI runs, PR #290 was the only completed real-auth failure and the only recovery failure; recovery was 15 passes to one failure.
- The exact real-auth web-search Playwright spec passed 3/3 on the original PR head and 3/3 after merging main. No source or test workaround was added.
- Merged `origin/main` at `0f949c307`; focused checks passed: runner image pin 3/3, container engine 26/26, lifecycle launch 4/4, lint, and typecheck.

## PR #290 runner-profile upgrade repair

- [x] Reproduce and classify the repeated historical-upgrade failure from both CI attempts.
- [x] Run the archived app with the archived runner image profile, then switch to the candidate profile.
- [x] Prove that an old release is refused after the profile change and must be rebuilt and reapproved.
- [x] Add focused regression tests for the profile transition without weakening strict digest checks.
- [x] Run focused tests and the closest practical production-upgrade proof with Bun 1.3.14.
- [x] Run relevant full gates, review the diff, and commit the repair without pushing.

Plan review: keep exact runner-image equality. The proof must model the real service upgrade instead of making OCI index and child digests interchangeable. Preserve installation identity, conversation wiring, stored extension data, and human approval semantics through the required rebuild.

### Review

- Both attempts of CI run 35638868572 failed only after the archived app was paired with the candidate runner profile. PR #291 passed the same archived source with the old profile.
- The proof now derives both runner images from their immutable source revisions. It seeds with the archived profile, restarts with the candidate profile, proves the old release cannot execute, then rebuilds and reapproves it under the new profile.
- The production lifecycle's exact image comparison remains unchanged. Installation identity, owner, scope, grants, workspace, old release and approval records, conversation wiring, and extension storage are verified across both the live upgrade and backup restore.
- Real rootless-Podman semantic upgrade passed end to end: archived seed, candidate rebuild, independent restore rebuild, and clean cleanup. Focused tests passed 44/44. Bun 1.3.14 lint and typecheck passed.

## PR #290 final proof hardening

- [x] Add negative regressions that reject unrelated old-release failures.
- [x] Require the precise runtime-profile mismatch refusal.
- [x] Compare the complete pre-rebuild installation snapshot with the seeded receipt.
- [x] Run focused tests and the real semantic upgrade when the local engines permit it.
- [x] Run pinned Bun lint and typecheck, review the diff, and commit locally without pushing.

Plan review: change only the historical-upgrade proof. Keep the production runner's strict image equality and the existing post-rebuild identity checks unchanged.

### Review

- The old-profile assertion now accepts only the stable API message produced by `runtime_profile_changed`. Explicit negative tests prove that a successful invocation, an unrelated runner failure, and a missing error cannot satisfy the gate.
- The candidate phase compares the complete installation record with the archived receipt before it attempts the old release or starts a rebuild. The existing post-rebuild identity, approval, wiring, and storage checks remain in place.
- The exact current candidate passed the real rootless-Podman semantic upgrade and independent restore. Both phases rebuilt and reapproved the archived release under the multi-architecture index profile; cleanup passed.
- Focused tests passed 10/10. Full Bun 1.3.14 lint checked 4,610 files, and full typecheck passed all backend, web, backend-test, and web-e2e surfaces.

## PR #290 final audit repair

- [x] Move the runner-profile transition regression suite into the default backend test gate.
- [x] Assert the rebuilt release keeps the archived installation, workspace, revision, and source contract.
- [x] Add negative regressions for each rebuilt-release provenance field.
- [x] Run default discovery, focused tests, pinned lint, typecheck, and the real semantic upgrade when available.
- [x] Review the exact diff and commit locally without pushing.

Plan review: keep the runtime's exact image equality unchanged. Reuse one assertion helper so the unit proof and real historical-upgrade proof cannot drift.

### Review

- The transition suite now runs under the configured `src/__tests__` root. Default discovery passed 4 tests with 15 assertions; the combined focused set passed 11 tests with 59 assertions.
- One shared assertion now binds rebuilt releases to the archived installation ID, workspace ID, workspace revision, and source digest. Negative cases reject drift in each field.
- The real rootless-Podman proof passed the live candidate rebuild and the independent restore rebuild. Both retained the old stored value and produced clean command and cleanup exits.
- Bun 1.3.14 full lint checked 4,610 files, full typecheck passed all surfaces, and the backend pool passed 25,866 tests across 1,654 files with no failures.

## Repair PR #284 CI bootstrap and file-mode provenance — 2026-09-21

- [x] Reproduce the fresh-runner bootstrap failure and local file-mode false-clean result.
- [x] Install pinned Bun and frozen root dependencies before the CI source-state probe.
- [x] Compare complete regular-file permission bits with the canonical `HEAD` tree mode.
- [x] Add workflow-order and non-executable mode regressions.
- [x] Run focused tests, workflow validation, static gates, and review the exact diff.
- [x] Commit the publication-gate repair locally without pushing.

Plan review: reuse the repository's composite setup action so Bun pinning, dependency caching, and
the frozen root install keep one source of truth. Keep the source-state comparison direct: Git tree
mode `100644` maps to local `0644`, and `100755` maps to local `0755`; any other permission bits
change the local Docker context because Docker preserves local `COPY` permissions.

Review: the dev-image job now completes the shared setup action before it invokes the source-state
resolver. That action installs the exact `.bun-version`, restores the shared package cache, and runs
the frozen root install that supplies `@balena/dockerignore`. A workflow regression pins both the job
ordering and the composite action's pinned-runtime/frozen-install contract. The resolver now compares
all regular-file permission bits with Git's canonical `0644` or `0755` mode, so local modes such as
`0600`, `0700`, or `0775` cannot be mislabeled clean.

Verification: the focused CI/provenance set passes 93 tests and 235 assertions. Actionlint, Bash/sh
syntax, `git diff --check`, gate integrity, full lint over 4,614 files, full typecheck, Svelte check
(0 errors and 0 warnings), and the production build pass. The canonical backend pool passes 25,903
tests across 1,657 files with zero failures. The production build required the known Nix host
`libstdc++.so.6` library-path correction and then completed successfully.

## Refresh PR #284 after PR #288 — 2026-09-21

- [x] Verify the exact clean PR head and exact incoming `origin/main` revision.
- [x] Merge `origin/main` with a normal merge commit and preserve both feature sets.
- [x] Resolve the CI aggregation, wrapper-test, and task-history conflicts as a semantic union.
- [x] Run the combined focused tests, shell checks, lint, typecheck, and diff checks.
- [x] Review the integration against both parents and push the exact merge commit.

Review: the merge keeps PR #284's complete Docker-context provenance behavior unchanged and adds
PR #288's setup script, portable runner-group resolution, Apple Bash job, and required-check
aggregation. The two test conflicts retain both contracts and their fixtures; both task histories
remain intact. The combined focused set passed 230 tests with 0 failures. Bash syntax, ShellCheck,
workflow parsing, lint over 4,615 files, full typecheck, and `git diff --check` passed.
