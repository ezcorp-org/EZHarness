# Composable factory execution

Base commit: 2588c9f19edcae24273f4a2049eb3ac37bd6f920. Branch: feat/composable-factory-platform.

The complete platform plan and C01–C13 launch contracts are the scope. No kernel-only completion claim is permitted. All implementation stays in separate worktrees. Sol and Terra agents own bounded leaves, each on its own branch. The root integrates commits and re-runs proofs. No external messages, publication, or production configuration changes are authorized.

## Shared contracts

- `packages/@ezcorp/factory-sdk` owns the only execution schema, JSON schema export, compiler, pure kernel and simulator. Sol compiler owns schema/types/compiler/authoring. Terra kernel owns kernel/simulator and their tests, using Sol's exported types. The compiler agent must publish the types early.
- Production orchestration alone may import Temporal. No untrusted execution before stage 2a proof. All C13 shared functionality extends the existing modules. No second executor, queue, approval or blob-store interface.
- API identifiers use `factories` and `factory-*`; every route is registered and covered. Feature flag is exact `EZCORP_FACTORY_ENABLED=1` and fails closed.
- Each new source file and executable change must pass measured 100% coverage, plus negative and integration cases. No lowered gates, exclusions or skipped passing tests.
- Agent worktrees share no modified files. Parent owns integration, root tracking files, dependency lock merge and final evidence. Agents commit their changes and report exact commands, exits and unresolved gaps.

## Delivery tree

1. Stage 1: schema/compiler; graph kernel/simulator; reference signatures; coverage/build/CI contracts and reuse checks.
2. Stage 2a: base hardening, token audience, feature flag, runtime pins and verification producers.
3. Stage 2b: Temporal, outbox, durable records, projections, S3 and key hierarchy, legacy recovery changes.
4. Stage 2c: gateway, supervisor, isolated native/Python runners and operation recovery.
5. Stage 2d: tenant grants, pool admission, budgets/fences and provisioning design.
6. Stage 3: protected assurance, atomic release authority, recovery archive and notifications.
7. Stage 4: complete package lifecycle and CPU/GPU isolation.
8. Stage 5: first-party console, real domain packs, legacy composition and browser proof.
9. Stage 6: hosted/self-hosted deploy, control plane, restore/load/fault/alert proof.

## Status log

- Created isolated integration worktree from the exact main baseline specified by the plan; copied only its untracked specification inputs.
- Initial baseline proof on `55cf79ec5`: root/web frozen installs, all four typecheck sections, lint, service account query suite (45), migration idempotence suite (6), and v4 delivery suite pass. Private receipts: `/tmp/factory-platform-evidence/initial-manifest.json`. GitHub runner inventory is empty; local GPU devices absent. Infrastructure clarification remains pending.
- On `4896c3e7c`, real PostgreSQL checks pass: migration suite 24/0, pool-one 1/0, and v4 transactional lifecycle verifier. Owned test container: `factory-platform-proof-postgres`; receipt `/tmp/factory-platform-evidence/postgres-baseline-manifest.json`. Temporal environment probe passes with Node 24.14.1, SDK 1.23.0, and test-server 1.38.0. Full factory recovery proof is still pending.
- User testing update: use local Docker Compose S3 services and this machine's AMD GPU; start the integration/load campaign with 10 tenant installations. The original 100-tenant launch capacity proof remains distinct from this initial campaign. No external test credential values are requested.
- GPU discovery corrected: NVIDIA-only checks were insufficient. AMD KFD exposes gfx1100 with 24 GiB VRAM at renderD128 and a separate integrated GPU at renderD129. Runner compute/isolation proof is pending.
- Backend regression on stable `1b61f6a89`: canonical `bun run test` exits 0, 25,685 pass / 0 fail across 1,634 files. Later merged source needs affected revalidation and final full regression.
