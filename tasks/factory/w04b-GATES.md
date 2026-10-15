# Gates: re-grant after revoke, and grantee display names (W04b)

Branch `wp/w04b-regrant`, created at `integ/w00` `d5ee52309`. At the sweep, `integ/w00` had not moved. Receipts:
`/tmp/factory-platform-evidence/w04b/` (`logs/`, `sweep-final/receipts/*.json`). Report: `/tmp/factory-platform-evidence/w04b/report.txt`.

## Defects

1. **A revoked artifact share could not be granted again.** Confirmed by w18b-validator at `873b04759`.
   `factory_artifact_read_grants` was keyed by the share itself (tenant, source project, artifact, target
   project). A revoked row therefore held the key forever, and every later grant to the same target failed
   with `factory_artifact_grant_conflict`.
2. **The grants panel showed raw user ids.** From W14's real captures: the grant API returned no display name.

## Commits

| SHA | Subject |
| --- | --- |
| `b5a5780b0` | fix(factory): a revoked artifact share can be granted again |
| `20b79baa9` | feat(factory): grant records name the grantee |

## Gates

- [x] G1: Reproduce defect 1 at base.
  CHECK: `bun test --timeout 60000 ./src/factory/artifact-access.test.ts`, with the new cases added and the source at `d5ee52309`.
  EXPECT: grant, revoke, grant again fails with `factory_artifact_grant_conflict`.
  EVIDENCE: `logs/repro-base.log`, exit 1. The re-grant threw `FactoryArtifactAccessError: factory_artifact_grant_conflict` at `artifact-access.ts:168`.
- [x] G2: A revoked grant does not block a new one. The revoked row stays. The new grant is a new active row, never a reactivation. Only an active grant is unique; an active grant still conflicts.
  CHECK: `./src/factory/artifact-access.test.ts`, cases "a revoked share can be granted again ...", "a share that is still active conflicts ..." and "two re-grants racing ..."; the same race on real PostgreSQL in `./tests/postgres/factory-artifact-access.test.ts`.
  EXPECT: rows `[1, revoked]` and `[2, active]` with different seals; the audit trail shows granted, revoked, granted; a grant while active conflicts; a revoke reaches only the active row; a repeated revoke writes nothing; racing re-grants give one active row and one typed conflict.
  EVIDENCE: `sweep-final/receipts/focused-coverage.json`, `sweep-final/receipts/postgres-s3-coverage.json`.
- [x] G3: The migration is proven on a database that holds a revoked row.
  CHECK: `./src/db/migrations/allow-factory-artifact-regrant.test.ts`; the restart suite case "repeated migration keeps a revoked artifact share beside its re-grant ..."; the real-PostgreSQL restart and schema parity suites.
  EXPECT: on the old shape, the revoked row blocks a second row. After the upgrade the old rows are grant 1, and the primary key includes `grant_revision`. The partial index is `WHERE (revoked_at IS NULL)`. A second run keeps every constraint oid. A revoked share takes a new active row, and an active share takes no second one.
  EVIDENCE: `sweep-final/receipts/focused-coverage.json`, `sweep-final/receipts/postgres-coverage.json`.
- [x] G4: The grant listing returns the grantee's display name, with no other personal field, and a stated placeholder when there is no name.
  CHECK: `./src/__tests__/factory-grants.test.ts`, case "grant records name the grantee ..."; `./packages/@ezcorp/factory-sdk/src/factory-api.test.ts`; `web/src/routes/api/factories/factories.server.test.ts` (Vitest); the grants suite on real PostgreSQL.
  EXPECT: a named user shows the trimmed name; a blank name, a missing record, and a name equal to the id show `Unnamed principal`; a long name is cut at 256; a service account shows its name; the record's keys are the old set plus `displayName`. The response schema requires `displayName` of 1 to 256 characters. The list, set and revoke responses carry it.
  EVIDENCE: `sweep-final/receipts/focused-coverage.json`, `sweep-final/receipts/web-vitest-coverage.json`, `sweep-final/receipts/postgres-coverage.json`.
- [x] G5: Static gates and coverage.
  CHECK: `W02C_REPO=<worktree> flock --close /tmp/ezcorp-validation-heavy.lock timeout 9000 bash /tmp/factory-platform-evidence/w04b/repro/sweep.sh final`
  EXPECT: every leg exits 0: backend pool, typecheck, lint, boundaries, gate integrity, and `BASE_REF=integ/w00` new-file and patch coverage over the merged focused, PostgreSQL and web LCOV.
  EVIDENCE: `sweep-final/receipts/*.json` at `20b79baa9`, clean tree, 23:42 to 00:08 local: every leg exits 0.
  | Leg | Result |
  | --- | --- |
  | Focused suites | 51 pass, 0 fail, 620 assertions |
  | Real PostgreSQL (grants, schema, restart) | 31 pass, 0 fail, 3276 assertions |
  | PostgreSQL with S3 (share access) | 2 pass, 0 fail |
  | Web Vitest pool | 7521 pass (601 files) |
  | Backend pool | 28191 pass, 0 fail (1901 files) |
  | New-file coverage | 1 new source file gated |
  | Patch coverage | all changed executable lines covered (7 files) |

## Files owned by other packages (disclosed)

- **W04 (Sol artifacts):** `src/factory/artifact-access.ts`. Grant and revoke now address one grant row each; everything else is unchanged. A first grant seals exactly as before, so existing rows still verify.
- **Coordinator:** `src/db/migrate.ts` (one appended migration), `src/db/schema.ts` (the model's primary key, partial index, check and column), `src/__tests__/helpers/factory-migration-restart-suite.ts` (one case), `tests/postgres/factory-schema.test.ts` (the new index).
- **Sol controls (W06):** `packages/@ezcorp/factory-sdk/src/types.ts` (`FactoryGrantResource.displayName`) and the regenerated `factory-api-response.schema.json`. `src/factory/grants.ts` gains the name lookup; the authorization path is unchanged.
- **W14 (routes, in flight):** `web/src/routes/api/factories/_shared.ts` (`grantResource` and the two grant mutation responses add `displayName`) and its route test. W14 restructured `_shared.ts` on its branch, so expect a small textual conflict at merge. Keep both sides, with `displayName` in all three grant resources.
- **W18 (coverage gate files):** `scripts/coverage-thresholds.json` gains one key, for the new migration file, at 100.
- **Grants test suite** (`src/__tests__/helpers/factory-grants-suite.ts`, owned with `src/factory/grants.ts`): one new case, "grant records name the grantee ..."; the existing cases are unchanged.
- **No new PostgreSQL suite files.** Two existing suites gained cases, so the registration in `db-postgres.yml` is unchanged.

## Validation delta (w15-validator, 2026-09-24, report `/tmp/factory-platform-evidence/w04b-validation/report.txt`)

- **F1 (security): fixed.** The sweep put the PostgreSQL URL, password included, in the argv of the two PostgreSQL legs, so their receipts recorded it. The lead redacted those receipts in place, and the one W05b receipt with the same leak was redacted the same way. Each sweep script (W04b, W05b, W02c) now passes the URL only through the environment of a subshell. The receipt writer records only the argv and redacts URL credentials from anything it copies. Every other script under these evidence directories passes the URL through the environment only, and a scan found the password in no remaining file. The two PostgreSQL legs were rerun, and their receipts are in `sweep-delta/receipts/`.
- **F2: added.** The share test "human-issued exact share ..." pins a first grant's seal to the pre-W04b formula. The test writes that formula out as it stood at `d5ee52309`, so a later change to the product's formula cannot also move the pin.
- **F3: disclosed** above: `scripts/coverage-thresholds.json` (W18) and the grants suite.
