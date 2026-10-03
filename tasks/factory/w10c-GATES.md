# W10c: Codex provider pin revision

Brief: `/tmp/factory-platform-evidence/w00/briefs/w10c.md`, with the coordinator's ruling on report 1 and the pin
amendment (both 2026-10-03). Owner w10c-codex-pin, branch `wp/w10c-codex-pin` off integ/w00 `1992630f3`. Worktree:
`.worktrees/w10c-codex-pin` under the feature worktree. Evidence root: `/tmp/factory-platform-evidence/w10c/`
(report.txt, SIGN-IN.md, readiness-base.json, logs/).

## Contract revision (C10)

Decision record (the user, 2026-10-03, 15:50Z–16:10Z), as the brief states it:

The user decided: use the deployment's Codex account (a ChatGPT-plan OAuth login, not an API key) for the real
model legs, and "use the cheapest luna model". The Codex catalog on this host lists two luna models, both with
text and image input and a 272k context window: `gpt-6-luna` ("fast and affordable model for easier tasks") and
`gpt-5.6-luna` ("older fast and efficient model"; the openai-docs reference names it the "primary choice for
faster or cheaper workloads"). Pin: provider `openai`, model `gpt-5.6-luna`, served by the `openai-codex-responses`
API under the stored OAuth credential. The user was told the risk: a ChatGPT-plan login used outside Codex may
breach OpenAI's terms and may be rate limited; that risk is the user's. Plan rule C10 forbids a quiet model
substitution; this change is a reviewed contract revision, and this record is the review.

Amendment (the user, 2026-10-03 16:00Z, relayed by the coordinator): "luna 6 is out, can we try that". The pin is
now provider `openai`, model `gpt-6-luna`, on the same OAuth login and API. Both picks are recorded: first
`gpt-5.6-luna` (15:50Z), amended to `gpt-6-luna` (16:00Z).

Amendment notes (not rewrites) sit after the two pinned paragraphs of
`docs/plans/2026-09-12-composable-factory-platform-contracts.md` (reference code v1, reference image v1).

## Catalog source (offline check)

Package `@earendil-works/pi-ai` 0.85.1 (`bun.lock` line 235; the ruling's `@mariozechner/pi-ai` is the package's old
name and is not installed). Catalog file: `node_modules/@earendil-works/pi-ai/dist/providers/data/openai-codex.json`
(resolves to `node_modules/.bun/@earendil-works+pi-ai@0.85.1+aa153870851897c9/node_modules/@earendil-works/pi-ai/`).
The file is one JSON line (line 1). Under key `openai-codex-responses` it lists eight ids: gpt-5.3-codex-spark,
gpt-5.4, gpt-5.4-mini, gpt-5.5, gpt-5.6-luna, gpt-5.6-sol, gpt-5.6-terra, gpt-6-astra. `gpt-6-luna` is in no file
under `dist/providers/data/`. So `gpt-6-luna` enters through one `LOCAL_OAUTH_OVERRIDES` entry; its values follow
its Codex siblings in that file (`openai-codex-responses`, `https://chatgpt.com/backend-api`, reasoning, text and
image, `contextWindow` 272000, `maxTokens` 128000), with plan cost 0. (`gpt-5.6-luna`, the first pick, is in that
file and in `openai.json`, which is why the first round added no entry.)

## What the branch found and fixed

1. **The probe never opened the configuration store**, and with no store named it would have created one: the
   credential lookup swallowed "Database not initialized" and read `provider_not_configured` on every host. Now a
   store must be named (DATABASE_URL or EZCORP_DB_PATH; PostgreSQL and `:memory:` must also name their keys), or the
   probe stops with `store_not_named` and opens nothing. A store that fails to open or read is `store_unavailable`,
   logged by error name only. The record carries `store: { kind, opened }`, never a path or URL. The code journey
   uses the same helper. Assumption: DATABASE_URL names a store as well as EZCORP_DB_PATH, because the proof stack's
   web process runs on PostgreSQL.
2. **The broker sent an OAuth login to the api-key wire.** It now applies the shared `resolveModelForCredential`
   swap (the one build-pi-agent.ts and providers/llm.ts use). Readiness asks the same swap whether the credential
   kind can run the pin; the check lives in factory-broker.ts only, and registry.ts carries only the override entry.
3. **An API key alone made the subscription-only pin "ready".** The swap leaves a key's model unchanged, so a key
   would have been sent to the subscription endpoint. Readiness now names it `model_not_available`.

## Commits

| Commit | Subject | Hook suites |
|---|---|---|
| `cccf8a0cb` | fix(providers): route the factory pin through the OAuth login it runs on | 3 |
| `935acc794` | feat(factory): re-pin the reference model to openai gpt-5.6-luna (C10 revision) | 9 |
| `46c2e573c` | docs(w10c): gates, C10 amendment notes and todo for the Codex pin revision | 0 |
| `90fa8ffa4` | fix(providers): the readiness probe names its store; the broker check stays in the broker | 3 |
| `e6ea78c22` | feat(factory): re-pin the reference model to openai gpt-6-luna (user amendment) | 11 |
| `ac33cd7eb` | fix(providers): an API key alone cannot make the subscription-only pin ready | 1 |
| `7bf9831eb` | docs(w10c): gates and C10 record for the gpt-6-luna amendment | 0 |
| `71c6add0f` | feat(factory-graph-proof): opt-in persistent deployment for the sign-in flow | 1 |
| `86c7852e0` | docs(w10c): gates for the persistent deployment and the sign-in flow | 0 |
| `f98d620a5` | fix(factory-graph-proof): the harness never prunes shared image storage | 1 |
| this commit | test(reference-image): the lock's evaluation model is the definition's evaluator pin | 3 |

The branch holds 11 commits with this one (10 at `f98d620a5`, as validator-6 counted; report 4 said 11 in error).

All hook suites passed in the hook (logs/commit-c*.log). No commit mapped more than 12.

## Digests (compiled definition digest, `sha256:`)

| Definition | Haiku (`cccf8a0cb`) | gpt-5.6-luna (`935acc794`) | gpt-6-luna (`e6ea78c22`, final) |
|---|---|---|---|
| reference.code.v1 | `c09d3752592f1877412bb23f053a44c0a640787ed66dfeee68a425937c531005` | `79b950ca68fcee5ab5e790571e08ca702ad136e5b61743349dd8b07757792a64` | `e2fd8db63abab006276871d5e787c0e34e2aabae4dcaccc100fd5f5995534b70` |
| reference.image.v1 | `379331564ec611f98253cf04835b255c274be4eb12b9b80aacbfa7b4531a53d8` | `67f09608cd46efeb8b54091e537633a636b671207f47da553df3d543ee22979e` | `4e97085263457f42031f6cd7e002074f75403bf8a2d305083a9ccf062d3ff112` |
| reference image lock | `5ea903d2b52dae1b06a67aeca5b671c9ac215113007cb8bf8cf469f7a24558fe` | `744eca18bdc02f985483736831fee8103c86b25e62560c09be4bd704ad2e284d` | `c8ba8b1faa4badcd3f581baf27e84cdc385103b00e100b9c13725a5a243930fd` |
| reference.data.v1 | `1113c493f8db9738aea9582b0ec6ec4167e53556ca96ae0dd10f29bd8e1f9412` | unchanged | unchanged |
| reference.catalog.v1 | `2a32247059e5e5bf495313a9c9948e1675ad5d70bed3ed149408299c35bd8792` | unchanged | unchanged |

The catalog digest does not move: `referenceCatalogV1` names its children by fixed reference digests, not by their
compiled digests. No test pins a reference digest literally, so no hash check was touched. Producer:
`/tmp/factory-platform-evidence/w10c/digests.ts`; logs `digests-before.log`, `digests-after.log`, `digests-gpt6.log`.

## Gates

- [x] G1 (R1): red first, before any fix (ruling: the two `provider_not_configured` logs stand as the red).
  CHECK: `bash /tmp/factory-platform-evidence/w10c/r1-probe.sh <label> <json>`
  EVIDENCE: `readiness-base.json`, `logs/r1-base-anthropic.log`, `logs/r1-luna-pin-only.log` (both exit 1,
  `["provider_not_configured"]`), `logs/r1-router-diag.log`. The misspelt-id refusal is a unit test (G4).
- [x] G2 (R2): `gpt-6-luna` enters the registry only for the openai-codex OAuth provider; red first.
  CHECK: `bun test --timeout 30000 ./src/__tests__/registry-oauth-model-resolution.test.ts`
  EXPECT: before the entry the probe reads `["model_not_available", "provider_not_configured"]`; after it,
  `["provider_not_configured"]` only. EVIDENCE: `logs/r2-gpt6-probe-red.log`, `logs/r2-gpt6-unit-red.log` (10 fail),
  `logs/r2-gpt6-probe-green.log`, `logs/r2-gpt6-unit-green.log` (46 pass). Cases: the entry's exact values; absent
  from the api-key and pi-ai codex catalogs and from google's OAuth list; the OAuth swap reaches the subscription
  endpoint; `gpt-6-lunna` is refused by name.
- [x] G3 (R3): every factory pin re-pinned to `gpt-6-luna`; one SDK constant replaces seven literals.
  CHECK: `git grep -n -E 'claude-haiku-4-5-20251001|gpt-5.6-luna' -- src/factory 'packages/@ezcorp/factory-*' scripts/`
  EXPECT: only `scripts/cache-proof-live.ts` and history comments. Not re-pinned: `scripts/cache-proof-live.ts` is an
  Anthropic prompt-cache proof, not a factory pin. Generic tests, the seo-watcher example and docs/validation
  receipts are untouched. `c02-conformance.json` and `guest-model-transcript.json` hold protocol sample pins.
- [x] G4 (R4): routing proof, no network. `provider:oauth:openai` holds only "fixture-oauth-token".
  CHECK: `bun test --timeout 30000 ./src/providers/factory-broker.test.ts ./scripts/verify-factory-reference-code-provider.test.ts`
  EVIDENCE: `logs/r4-red.log` (4 fail), `logs/r4-green.log`, `logs/b-broker.log`, `logs/b2-apikey-red.log` (1 fail),
  `logs/b2-apikey-green.log` (31 pass). Cases: ready with kind `oauth`; the call goes to `openai-codex-responses` at
  chatgpt.com with the OAuth token although a BYOK key is stored; three concurrent calls each take the OAuth path; no
  login names `provider_not_configured`; `gpt-6-lunna` names `model_not_available`; an api-key-only model under the
  login and the subscription-only pin under a key both name `model_not_available` and are never sent; the regression
  pair (gpt-5.5: login to the subscription endpoint, never api.openai.com; key to the api-key endpoint, unchanged); a
  login lost between readiness and the call is refused.
- [x] G4a (ruling (a)): the probe names its store.
  EVIDENCE: `logs/a-store-red.log` (6 fail; the no-store command created a database under HOME), `logs/a-store-green.log`
  (9 pass). Cases: store kind and `opened`, no path in output; `store_not_named` for no store, `:memory:` without keys,
  PostgreSQL without keys; a command with no store writes nothing in its folder or HOME; a store that fails to open is
  `store_unavailable`, not a missing credential; `:memory:` stays valid.
- [x] G5 (R5): digests recorded (table above); no hash check weakened.
- [x] G6 (R6): the W11 semantic evaluator pin (`sdxl-lock.json` `evaluation.model`; the SDK's three
  `semanticEvaluation*` runners and `validateImage`) is `gpt-6-luna`. SDXL model revision, closure digests and guest
  image pins unchanged. EVIDENCE: hook run of `e6ea78c22` (11 suites), `logs/c5-cov-b.log` (157 pass).
- [x] G7 (R7): `/tmp/factory-platform-evidence/w10c/SIGN-IN.md`, for the ruled flow: the W10c owner holds the lock,
  starts one persistent deployment (`run.sh hold`), the user signs in at its URL (Settings, Models, Connect OpenAI
  Subscription), `run.sh probe` shows `ready: true`, `credentialKind: "oauth"`, and the stack stops within 30 minutes.
- [x] G7a (ruling item 2): opt-in persistent deployment in the proof stack.
  CHECK: `bun test --timeout 30000 ./scripts/factory-graph-proof/deployment.test.ts`
  EXPECT: 9 pass; `deployment.ts` 65/65 lines, 16/16 functions. EVIDENCE: `logs/r8prep-deployment.log`,
  `logs/c8-cov-d.log`, `cov/d.lcov`. Cases: the folder only under `/run/user/<uid>/`, never in the repository, HOME
  or the evidence folder; first start fresh name and secrets, nothing written; later start reuses the same database
  and key material and asks for no new name; a folder that names a dropped database is refused by that name
  (`deployment_database_missing`); half-written, tampered (including an injected database name) and unreadable
  folders are `deployment_incomplete`; key files are 0600, the folder 0700; the probe environment points at the
  deployment's database with its own secret and salt. `stack.ts`, `hold.ts`, `deployment-probe.ts` and `run.sh`
  are harness code: proved only by a real start, under the lock at R8 (the first hold is that proof).
- [x] G6a (validator-6 DRY item): `sdxl-lock.json` `evaluation.model` can no longer drift from the SDK constant.
  `lock.test.ts` walks `referenceImageV1` for every runner reference that names a model (at least four, one value)
  and asserts the lock's `evaluation.model` equals it. `publication.test.ts` and `semantic-quorum.test.ts` compare
  provenance with the lock's value, not a literal. No test under `src/factory/reference-image/` names the model id.
  EVIDENCE: `logs/c11-image.log` (106 pass, 3 hook-mapped files); `logs/c11-mutation.log` (the lock changed to
  `gpt-6-lunna`: the new case fails; the file restored).
- [x] G9 (ruling item 4): the graph-proof harness never prunes shared image storage.
  The runner stages files into one pinned image and builds none (`PodmanRunner.build` reports `imageDigest: this.image`),
  so a pass has no image of its own to remove by tag; the line is removed, not replaced.
  CHECK: `bun test --timeout 30000 ./scripts/factory-graph-proof/harness-hygiene.test.ts`
  EXPECT: red with the line named, then 2 pass. EVIDENCE: `logs/g9-red.log`
  (`run.sh:84: podman image prune -f > "$W19A_OUT/image-prune.log" 2>&1`), `logs/g9-green.log`, `logs/g9-diff.txt`.
  Diff:
  ```diff
  @@ -80,8 +80,6 @@ case "${1:-}" in
       one_pass mock forced-failure control-forced-failure
       bun "$REPO/scripts/factory-graph-proof/verify-diagnostics.ts" "$W19A_OUT" control-forced-failure || status=1
       bun "$REPO/scripts/factory-graph-proof/summarize.ts" "$W19A_OUT" || status=1
  -    # The guest images are built per pass; remove the untagged layers they leave.
  -    podman image prune -f > "$W19A_OUT/image-prune.log" 2>&1
       exit $status
  ```
  The guard covers every `.sh`, `.ts`, `.mjs` and `.js` file under `scripts/factory-graph-proof/` and every prune
  form (image, system, container, volume; podman or docker); its own first case checks the pattern on positive and
  negative lines (grep here is ugrep). Guard set 468 pass, gate-integrity integ/w00 clean (`logs/*-c10.log`).
- [ ] G8 (R8): the real legs. OPEN: waits for the coordinator (wave4h push, the user's sign-in, the heavy lock).
  Scheduled into the same lock holds: the sign-in hold itself; `scripts/factory-graph-proof/run.sh pass mock none`
  at this head (the harness changed); `tests/postgres/factory-definitions.test.ts`; and the lint fix below with its
  hook-mapped PostgreSQL suites.

## Lock-free legs (final code head `ac33cd7eb`)

| Leg | Result | Evidence |
|---|---|---|
| package builds, typecheck, lint, factory boundaries | all exit 0 (lint: 1 pre-existing warning, below) | `logs/static-c6.log` |
| hook-mapped suites with lcov | 3 files and 8 files, all pass | `logs/c6-cov-a.log`, `logs/c5-cov-b.log` |
| factory-sdk package tests | 246 pass, 32 files | `logs/c5-sdk.log` |
| factory suites that read the reference definitions | 112 pass, 10 files | `logs/c5-consumers.log` |
| registry consumers (oauth swap, model router, tier ladder) | 117 pass, 3 files | `logs/c5-registry-consumers.log` |
| web suites that read the definitions | 33 pass, 2 files | `logs/c5-web.log` |
| guard set (`w00/guard-suites.sh`) | 468 pass, 2 skip (host-conditional cases in larger files), 36 files | `logs/guard-final.log` |
| new-file and patch coverage, BASE_REF=integ/w00 | PASSED; every changed executable line covered | `logs/cov-gates-c6.log` |
| CRAP, touched functions | max 9.0, all 100 percent covered | `logs/crap-c6.log` |
| gate-integrity | integ/w00 clean; origin/main the 8 expected lines, none new | `logs/gate-integrity-final.log` |

The coverage legs against `origin/main` measure the whole feature branch and fail on files this package does not touch
(`logs/cov-gates-c2-attempt1.log`); the per-package judgement is against integ/w00, as in every earlier package.

Not run (heavy, needs the lock): `tests/postgres/factory-definitions.test.ts` reads the definitions, pins no model or digest.

Accepted by the coordinator: `scripts/cache-proof-live.ts` stays on its Anthropic pin; it is a prompt-cache proof,
not a factory pin.

Notes:
- The connection module's own info log line prints the PGlite path for a `pglite-file` store. The readiness record
  never does; a receipt that keeps the full stdout should be read with that in mind.
- Pre-existing lint warning at the base: `tests/postgres/helpers/factory-recovery-databases.ts:50` (`noCommaOperator`).
  Seen, fix scheduled: W10c fixes it at R8 time under the lock, where its hook-mapped PostgreSQL suites run.
- The `podman image prune -f` at the end of `run.sh all` is removed (G9).
