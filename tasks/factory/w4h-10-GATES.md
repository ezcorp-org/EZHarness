# W4H-10: main sync (W-SYNC-2), origin/main beaff68c8 into the wave head

Brief: `/tmp/factory-platform-evidence/w00/briefs/w4h-10-sync.md`. Owner w4h-3, branch `wp/w4h-10-sync` from integ/w00 `1ef82e971`.
Evidence root: `/tmp/factory-platform-evidence/w4h-10/` (E below). Rulings: coordinator 2026-10-05 (Pi items 1-4; C10 OAuth-only with the
call-time addition; the list-bound hook ruling `w00/ruling-hook-skip-w4h-10-merge.txt`).

Commits (archy noreply, author and committer):
- `7247f7e9a` Merge origin/main (beaff68c8) into the wave head. Parents exactly `1ef82e971` and `beaff68c8`. Hook: list-bound skip per the
  ruling; the printed list at commit time byte-equals `hook-list-merge.txt` (sha256 45ba088481f9e09f, 57 lines). E/merge-commit.txt,
  E/commit-merge-final.log, E/hook-list-at-commit.txt.
- `62cf3c661` fix(factory): Pi 0.87.1, catalog gpt-6-luna, the C10 pin runs on OAuth only. Hook ran normally: 5 suites, all green.
- the docs commit with this file (hook 0).

## The nine conflicts (one line each)
- bun.lock, web/bun.lock: regenerated from main's lockfiles with Bun 1.4.2 (`--ignore-scripts`); hono 4.13.12, devalue 5.9.4, undici 8.11.2
  restored from the wave (they came out lower); no version below either parent; frozen installs pass. E/lock-compare-final.txt, E/frozen.txt.
- manifest.lock.json: regenerated with `bun scripts/regenerate-manifest-lock.ts`, `--check` passes, both sides' entries present.
- src/api-registry.ts: both sides (the wave's factory routes and main's 15 /api/github routes).
- src/db/schema.ts: both sides (the wave's factory tables and main's github_* tables).
- web/src/app.d.ts: both sides (factoryServicePrincipal and sessionId).
- web/src/__tests__/route-contract.test.ts: the union of both session-only lists, 3 duplicates removed, sorted; 29 pass.
- src/__tests__/gate-scripts.test.ts: the wave's fixture in all 4 hunks plus main's standalone git-isolation test; main's
  git-fixture-env.ts now delegates to `withoutGitContext` (the one GIT_* strip, W18 GC5) and keeps its API.
- tasks/todo.md: union; main's 17-line top block after the wave's.

Semantic conflicts found by the 57 suites and fixed in the merge: the browser route inventory is 66 (64 at the base 31052930d, plus one per
side); main's dependency-security pins name the merged devalue 5.9.4 and undici 8.11.2.

## Red and green
- [x] G1 red at the raw merge: all 7 conflict legs red (E/red-raw.log; route-contract and web tsc redone validly in E/red-raw-redo.log).
- [x] G2 green at the resolved merge: conflict legs green (E/green-resolved.log; route-contract 29 pass with the bun runner).
- [x] G3 the 57 hook-mapped suites, heavy lock, gated, one process each: 55 green, 2 red (the two semantic conflicts), then 15/0 and 7/0.
  E/hook57-run.log, E/hook57/ (per-suite logs, sha256 in E/hook57-logs.sha256), E/two-fixes-green.log.
- [x] G4 Pi red at the merge: tests typecheck 8 errors (factory-execution.integration.test.ts, the old context shape) and 3 suite reds
  (registry and broker). E/pi-typecheck-red.log, E/pi-red.log.

## Pi 0.87.1 (ruling items 1-4)
- [x] Catalog: openai-codex has gpt-6-luna (openai-codex-responses, chatgpt.com/backend-api, text and image, 272000 context, 128000 output,
  reasoning, cost 0.1 / 0.5 / 0.01 / 0.125, a tier above 272k). The override entry is removed; the registry test asserts the catalog shape.
  E/pi-catalog.txt.
- [x] Cost, read-only finding: settlement does not price OAuth calls at 0. `factoryMeasuredUsageOf` (src/factory/runner/provider-one-hop.ts:84-93)
  settles `message.usage.cost.total`, which pi-ai computes from the model's cost table; under OAuth the model is the openai-codex catalog entry,
  so factory calls now settle 0.1 / 0.5 per million. Analytics prices by model (`modelPrices`, src/providers/registry.ts:685-687), not by
  credential. Before the removal the override's cost 0 made the model unpriced. LEFTOVER: price OAuth-plan calls by credential kind.
- [x] Tier: before (override, cost 0) tier `balanced`, costTier `medium` (name hints); after (catalog 0.6 blended) costTier `low`, tier `fast`.
  No factory code selects by tier (0 call sites of getModelsForTier, findModelForProviderInTier, tierForModel in src/factory, the factory
  packages and the broker); the C10 pin is by id.
- [x] gpt-5.5 override: left as is (out of scope, on the leftover list).
- [x] Readiness probe, offline (in-memory store): `["provider_not_configured"]`, requiredCredentialKind oauth, no model_not_available.
  E/readiness-final.json.

## C10 stays OAuth-only (ruling B and its addition)
- [x] `referenceModelPin` in packages/@ezcorp/factory-sdk/src/references.ts names `credentialKind: "oauth"`; the probe's pin is that object.
  Definition digests are unchanged: the definitions name only the model id, so no digest test moved.
- [x] One helper, `resolveCredentialForPin` (src/providers/factory-broker.ts), for readiness and for stream(); stream() sends only the
  credential it returned. The refusal is named `credential_kind_required`; readiness and its record carry `requiredCredentialKind`.
- [x] Installation config: `modelProvider.credentialKind` (oauth or apikey) is kept; an unknown kind or a kind with no pin is refused.
- [x] Other paths: the broker is the only factory code that calls authCallOptions or resolveModelForCredential with a pin (grep).
- [x] Red first: E/c10-red.log (3 fail). Green: E/c10-green.log (212 pass across 10 files).
- [x] Mutants (E/mutants.log): readiness check removed, 2 red; call-time check removed, the race test red; failure renamed, 3 red;
  credentialKind dropped from references.ts, 6 red.

## Legs at the head
- [x] `bun run typecheck` all programs pass; lint 0; boundaries 0. E/typecheck-pi.log, E/lint-pi.log, E/boundaries-pi.log.
- [x] Frozen installs (root, web, gate-integrity deps) pass. Web build passes. E/frozen.txt, E/web-build.log.
- [x] Guard set: 41 files, 760 pass, 2 skip, 0 fail. E/guard-head.log.
- [x] Coverage of this package's lines: patch vs 7247f7e9a PASSED (5 files), new-file PASSED. Vs origin/main both gates fail across the
  whole wave (two LCOVs cannot measure it); none of this package's files is listed. E/coverage.log, E/cov/.
- [x] Gate integrity: vs origin/main the same eight standing findings, no new line; vs 1ef82e971 PASSED. E/gi-head-main.log, E/gi-head-wave.log.
- [x] PostgreSQL migrations on a dedicated database (created, then dropped): db-migration-postgres 24 pass, factory-schema and
  migrate-lock 3 pass. E/pg-run.log.
- [x] Installer (installer-core) and private GitHub suites: green among the 57. Prune scan: clean (3 candidates, main's in-memory prune()).
