# W10c: Codex provider pin revision

Brief: `/tmp/factory-platform-evidence/w00/briefs/w10c.md`. Owner w10c-codex-pin, branch `wp/w10c-codex-pin` off integ/w00
`1992630f3`. Worktree: `.worktrees/w10c-codex-pin` under the feature worktree. Evidence root:
`/tmp/factory-platform-evidence/w10c/` (report.txt, SIGN-IN.md, readiness-base.json, logs/).

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

Amendment notes (not rewrites) sit after the two pinned paragraphs of
`docs/plans/2026-09-12-composable-factory-platform-contracts.md` (reference code v1, reference image v1).

## What the branch found

1. **The id is already in the registry.** pi-ai 0.85.1 (the lockfile pin) ships `gpt-5.6-luna` in its `openai-codex`
   catalog with the exact shape R2 names (openai-codex-responses, chatgpt backend, reasoning, text and image, 272k
   window, 128k output), and in the `openai` api-key catalog. The router resolves `openai/gpt-5.6-luna` with source
   `catalog`. So R1's "unavailable model" red cannot occur, and a `LOCAL_OAUTH_OVERRIDES` entry would be dead code
   (`resolveOAuthModel` returns pi-ai's entry first). No override entry was added. R2 became tests that prove the
   OAuth path. pi-ai's codex catalog does not list `gpt-6-luna`.
2. **The probe never opened the configuration store.** `factoryProviderReadiness` read settings with no `initDb()`;
   the credential lookup swallowed "Database not initialized" and returned null. The probe read
   `provider_not_configured` on every host, signed in or not. The reference code journey had the same defect.
3. **The broker sent an OAuth login to the api-key wire.** It sent to the router's model (`openai-responses` at
   api.openai.com), where a ChatGPT-plan token is refused. It now applies the shared `resolveModelForCredential`
   swap (the one `providers/llm.ts` applies). Readiness names a model the credential kind cannot run as
   `model_not_available`, through `credentialServesModel`, which the swap now shares.

## Commits

| Commit | Subject | Hook suites |
|---|---|---|
| `cccf8a0cb` | fix(providers): route the factory pin through the OAuth login it runs on | 3, all green |
| `935acc794` | feat(factory): re-pin the reference model to openai gpt-5.6-luna (C10 revision) | 9, all green |
| this commit | docs(w10c): gates, C10 amendment notes, todo | 0 |

## Digests (compiled definition digest, `sha256:`)

| Definition | Before (`cccf8a0cb`) | After (`935acc794`) |
|---|---|---|
| reference.code.v1 | `c09d3752592f1877412bb23f053a44c0a640787ed66dfeee68a425937c531005` | `79b950ca68fcee5ab5e790571e08ca702ad136e5b61743349dd8b07757792a64` |
| reference.image.v1 | `379331564ec611f98253cf04835b255c274be4eb12b9b80aacbfa7b4531a53d8` | `67f09608cd46efeb8b54091e537633a636b671207f47da553df3d543ee22979e` |
| reference image lock | `5ea903d2b52dae1b06a67aeca5b671c9ac215113007cb8bf8cf469f7a24558fe` | `744eca18bdc02f985483736831fee8103c86b25e62560c09be4bd704ad2e284d` |
| reference.data.v1 | `1113c493f8db9738aea9582b0ec6ec4167e53556ca96ae0dd10f29bd8e1f9412` | unchanged |
| reference.catalog.v1 | `2a32247059e5e5bf495313a9c9948e1675ad5d70bed3ed149408299c35bd8792` | unchanged |

The catalog digest does not move: `referenceCatalogV1` names its children by fixed reference digests
(`digest("a")`, `digest("b")`, `digest("c")`), not by their compiled digests. No test pins a reference digest
literally, so no hash check was touched. Producer: `/tmp/factory-platform-evidence/w10c/digests.ts`;
logs `logs/digests-before.log`, `logs/digests-after.log`.

## Gates

- [x] G1 (R1): red first, before any fix.
  CHECK: `bash /tmp/factory-platform-evidence/w10c/r1-probe.sh <label> <json>` (the probe on a fresh in-memory deployment)
  EXPECT: base pin `anthropic/claude-haiku-4-5-20251001` unready by name; the luna pin alone, unready.
  EVIDENCE: `readiness-base.json`, `logs/r1-base-anthropic.log` (exit 1, `["provider_not_configured"]`),
  `logs/r1-luna-pin-only.log` (exit 1, `["provider_not_configured"]`, NOT `model_not_available`: see finding 1),
  `logs/r1-router-diag.log` (store open: the pin resolves from the catalog; `gpt-5.6-lunna` is `model_not_available`).
  Both probe legs print "provider configuration could not be read": finding 2.
- [x] G2 (R2): the id reaches the subscription endpoint only through the OAuth path.
  CHECK: `bun test --timeout 30000 ./src/__tests__/registry-oauth-model-resolution.test.ts ./src/__tests__/oauth-model-swap.test.ts`
  EXPECT: 15 pass. EVIDENCE: `logs/r2-registry.log`. No override entry (finding 1).
- [x] G3 (R3): every factory pin re-pinned; one SDK constant replaces seven literals.
  CHECK: `git grep -n claude-haiku-4-5-20251001 -- src/factory 'packages/@ezcorp/factory-*' scripts/`
  EXPECT: only `scripts/cache-proof-live.ts` and two history comments. EVIDENCE: commit `935acc794`.
  Not re-pinned: `scripts/cache-proof-live.ts` is an Anthropic prompt-cache proof (it calls the Anthropic catalog and
  asserts Anthropic cache-write fields), not a factory pin. The generic tests, the seo-watcher example and
  docs/validation receipts are untouched, as the brief orders. `c02-conformance.json` and `guest-model-transcript.json`
  carry protocol sample pins (`model-v1`, `claude-opus-5`), not the reference pin.
- [x] G4 (R4): routing proof, no network.
  CHECK: `bun test --timeout 30000 ./src/providers/factory-broker.test.ts ./scripts/verify-factory-reference-code-provider.test.ts`
  EXPECT: red at base for the endpoint, concurrency, api-key-only and command cases; green after.
  EVIDENCE: `logs/r4-red.log` (20 pass, 4 fail, each for the stated reason), `logs/r4-green.log` (24 pass).
  Cases: stored `provider:oauth:openai` with "fixture-oauth-token" gives ready, kind `oauth`; the call goes to
  `openai-codex-responses` at chatgpt.com with the OAuth token although a BYOK key is also stored; three concurrent calls
  each take the OAuth path; no login names `provider_not_configured` only; `gpt-5.6-lunna` names `model_not_available`;
  an api-key-only model under the login names `model_not_available` and is never sent; a login lost between readiness
  and the call is refused; the probe command on a fresh deployment opens the store.
- [x] G5 (R5): digests recorded (table above); no hash check weakened.
- [x] G6 (R6): the W11 semantic evaluator pin (`sdxl-lock.json` `evaluation.model`, and the three
  `semanticEvaluation*` runners plus `validateImage` in the SDK) is `gpt-5.6-luna`. The SDXL model revision, its closure
  digests and the guest image pins are unchanged.
  CHECK: the hook-mapped suites of `935acc794`. EVIDENCE: `logs/c2-mapped.log` (162 pass, 9 files).
- [x] G7 (R7): the user's sign-in step.
  EVIDENCE: `/tmp/factory-platform-evidence/w10c/SIGN-IN.md`. Open question in it: the proof stack makes a new product
  database and encryption secret per start, so the sign-in must happen inside the R8 hold, or the stack needs a fixed
  database option (stack.ts is not owned by W10c).
- [ ] G8 (R8): the real legs. OPEN: waits for the coordinator's word (wave4h push, the user's sign-in, the heavy lock).

## Lock-free legs at `935acc794` (plus the docs-only working tree)

| Leg | Result | Evidence |
|---|---|---|
| package builds, typecheck, lint, factory boundaries | all exit 0 (lint: 1 pre-existing warning, below) | `logs/static-c1.log`, `logs/static-c2.log` |
| hook-mapped suites with lcov | 3 files 35 pass; 8 files 157 pass | `logs/cov-a.log`, `logs/cov-b.log` |
| factory-sdk package tests | 246 pass, 32 files | `logs/c2-sdk.log` |
| other factory suites that read the reference definitions | 112 pass, 10 files | `logs/c2-consumers.log` |
| web suites that read them | 33 pass, 2 files | `logs/c2-web.log` |
| guard set (`w00/guard-suites.sh`) | 468 pass, 2 skip (host-conditional cases in larger files), 36 files | `logs/guard-c2.log` |
| new-file and patch coverage, BASE_REF=integ/w00 | PASSED; all changed executable lines covered (3 files) | `logs/cov-gates-c2.log` |
| CRAP, touched functions | max 9.0, all 100 percent covered | `logs/crap-c2.log` |
| gate-integrity | integ/w00 clean; origin/main the 8 expected lines, none new | `logs/gate-integrity-c2.log` |

New-file and patch coverage against `origin/main` measure the whole feature branch and fail on files this package does not
touch (`logs/cov-gates-c2-attempt1.log`); the per-package judgement is against integ/w00, as in every earlier package.

Not run (heavy, needs the lock): `tests/postgres/factory-definitions.test.ts` reads the reference definitions but pins no
model or digest.

Pre-existing finding, not fixed here: `tests/postgres/helpers/factory-recovery-databases.ts:50` has a biome
`noCommaOperator` warning at the base. A fix there maps PostgreSQL suites in the hook, which need the heavy lock.
