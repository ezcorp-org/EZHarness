# Gates: pluggable infrastructure wave 1 integration

- [x] G1: Contract leaf is complete and independently reviewed.
- [x] G2: Conformance leaf is complete and does not fabricate SP05 evidence.
- [x] G3: Incus setup artifacts are deterministic and reviewable before remote apply.
- [x] G4: Workspace routing fails closed for sandbox-required work.
- [x] G5: Integrated schema, typecheck, lint and focused suites pass on pinned Bun 1.3.14.
- [x] G6: Existing user work remains intact and remaining release blockers are documented.

## Verification — 2026-09-22

- Focused feature suite: 106 pass, 0 fail, 572 assertions across 10 files.
- Repository suite: 25,847 pass, 0 fail across 1,653 files.
- `bun run typecheck`: pass.
- `bun run lint`: pass.
- `bun run build`: pass.
- `git diff --check`: pass.
- Live Incus apply and guest qualification remain blocked by the missing pinned provider client certificate.
