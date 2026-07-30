# ez-factory — program handoff

**Date:** 2026-07-29 · **Written for:** a session with zero context on this work.

Everything below is stated so it can be acted on without re-deriving it. Where a
claim matters, it carries a `file:line`. **Claims without citations in this
program's specs were wrong nine times out of nine** — see §7.

---

## 1. Branch state

Three worktrees under `worktrees/`, all branched from `main@abc41f35`. **`main`
has since moved to `afac7d36`, so all three are 3 commits behind** — rebase or
merge `main` in before opening the PR.

| Branch | Worktree | HEAD | State |
|---|---|---|---|
| `feat/ez-factory` | `ez-factory` | `895308c9` | Trunk. Phase 1 + Phase 2 (partial) + all planning docs. |
| `feat/ez-factory-c2` | `ez-factory-c2` | `c9904398` | **Phase 5 COMPLETE**, reviewed clean end to end. |
| `feat/ez-factory-c6` | `ez-factory-c6` | `4fe5c23d` | Phase 6. **All 8 defects FIXED and their tests VERIFIED to discriminate** — see §3. Verified 2026-07-29: typecheck green, lint at the 52-warning baseline, `gate-integrity` PASSED, `bun run test` **15304 pass / 0 fail / 1014 files**, `bun run test:coverage` **20444 pass / 0 fail**, coverage gate PASSED (916 files), **e2e blocking `mock-gate` lane 105 pass / 0 fail**, visual-evidence lane 8 pass. |

**Setup in a fresh worktree is not automatic:** `bun install` at the root, then
`bun install` **and** `bun run prepare` inside `web/` (generates
`web/.svelte-kit/tsconfig.json`, without which typecheck fails).

**`feat/ez-factory-c2` branched at `3267cbbe`**, before Phase 2's steps 3–4. Its
~3,400 lines have **never executed against the current executor**. A green
`src/extensions/__tests__/**` proves internal consistency only — run the
**workflow** suites after merging it.

---

## 2. Phase status

**Delivered, reviewed clean:**

- **Phase 1 — C1 per-step model.** `WorkflowStep.model` + `WorkflowDefinition.defaultModel`:
  `provider`, `model`, `temperature`, `maxTokens`, `effort`. Effort reaches the
  provider via `executor.ts:480` `createPiLlmAdapter` → `executor-helpers.ts:124`
  → `completeSimple`/`streamSimple` (`:146-147`, `:174-175`). `ModelEffort` matches
  pi-ai's `ThinkingLevel` (`pi-ai/dist/types.d.ts:21`) exactly. The
  absent-override path is byte-identical, proven by `Object.keys(options) === ["apiKey"]`.
- **Phase 5 — C2 dynamic triggers.** `ctx.triggers` register/unregister/list,
  `permissions.triggers` envelope, host-minted slugs, `ezcorp/trigger-fire`
  key-keyed dispatch, lifecycle sweeps, admin read route. Both silent-kill
  hazards closed. 100% coverage on all four new files.

**In progress:**

- **Phase 2 — C4.** Steps 1–7b reviewed clean. Durable run state, crash recovery
  branching on `run_phase`, `persistCritical`, suspend/resume, `approval` step
  kind, `answerApproval` chokepoint, REST answer surface, structural consent
  boundary. **Remaining:** the Hub-action and chat-card answer surfaces, step 8
  (async `X-EZ-Workflow-Async: 1` header + `WorkflowRunner` daemon), step 9
  (resume/cancel routes).
  ~~**One outstanding item:** `workflow-run-persistence.test.ts:2036` asserts the
  returned object only — add a run-**row** assertion.~~ **DONE, and this entry
  was wrong when written.** The row assertions landed in `8098ea0a` at 15:40,
  21 minutes *before* this doc was first written, and survived two later
  amendments. They are at
  `src/__tests__/workflow-run-persistence.test.ts:2045-2048`
  (`after?.status === "suspended"`, `after?.finishedAt === null`, plus the
  approval row still `pending`). Verified to **discriminate**: routing the
  `approval-pending` refusal through `refuseTerminal` instead of
  `refuseTransient` fails two tests.
- **Phase 6 — C6.** Ownership ladder, definition versions, fork, dry-run, editor
  UI, e2e specs, **15** threshold keys (all at 100). **All 8 defects fixed and
  their tests verified to discriminate — §3.** Phase 6 is DONE.

**Not started:** Phase 3 (C5 trace/telemetry), Phase 4 (C7 skip/sub-workflows),
Phase 7 (C3 delegated execution), Phase 8 (the `ez-factory` extension),
Phase 9 (delete `ez-code-factory` + docs + e2e sweep).

Phases 3, 4, 7 were **deliberately** not started: each depends on a shape still
moving (C5/C7 on the executor, C3 on C6's resolver). Two of Phase 6's defects
came from exactly that kind of parallel guessing.

---

## 3. Phase 6's eight defects — ALL FIXED, discrimination VERIFIED

**Status: all eight fixed in `3966b5df..45a38487`** (seven commits):
`a1fae164` D1 · `eb123b54` D2+D5 · `be2ab5b7` D6 · `d0318b56` D3 ·
`88259e0b` D4 · `ab594fd9` D7 · `45a38487` D8.
Plus **`4fe5c23d`** — the D6 completion, below.

**Discrimination audit COMPLETE (2026-07-29).** Every fix's defect was
reintroduced in a `/tmp` snapshot and its test observed to FAIL. Results:

| Defect | Discriminates | Proof |
|---|---|---|
| D1 report | ✅ 4 sub-properties | enforce gates on stubs → 5 fails; drop the status downgrade → 4; drop the gate-row mode cue → 1; make taint shallow → 2 |
| D1 **UI** | ✅ | `edit/+page.svelte` reverted to pre-fix → the e2e test fails on both projects |
| D2+D5 | ✅ | message-matching classifier restored → 4 fails |
| D3 | ✅ | latest-version stamping restored → 2 fails, asserted on the **DB row** via SQL |
| D4 | ✅ | re-throw removed → 2 fails |
| D6 | n/a (comment-only) | claims verified true against source — **but the fix was incomplete; see below** |
| D7 | ✅ (typecheck) | field made optional → `TS2578: Unused '@ts-expect-error' directive` |
| D8 | ✅ **both directions** | delete the sub-tick → tick-24 fails; sweep every tick → ticks-1-23 fails |

Two specific worries in the original version of this section, both resolved:
D1's UI half **is** covered (the only surface is the e2e spec — there is no
component test for that page), and D7 does **not** leave the daemon passing
`{}` — `host-maintenance-daemon.ts:378` passes `{ pinnedVersionIds: [] }`, and
it is the only production call site.

**D6 was NINE SITES SHORT — fixed in `4fe5c23d`.** The original fix scoped the
claim in `workflows.md`, `workflow-versions.ts` and `workflow-executor.ts` and
missed every other place the same two claims are made, so the branch shipped a
direct self-contradiction: `schema.ts:542` said *"Resume compares the version id
first and reads this ONLY when the version id is NULL"* — verbatim the rule the
doc three files away says **no code implements** — and
`workflow-definition-hash.ts` still forecast the redefinition in the future
tense as though C6 had not landed on this very branch. Whichever a reader opened
first is what they inherited, which is the whole failure D6 was filed against.
The rule is now stated once (`db/queries/workflow-versions.ts`) and every other
site points at it. Two follow-on staleness bugs from D3 came out with it:
`definition_version_id` NULL means **three** things after D3, not two (the third
— content matched no version — is the only one a live system can newly
produce), and `definition_hash` is no longer "the version row's hash" but always
the hash of the graph that **ran**.

**Lesson this adds:** a comment-only fix has no test that can fail, so the only
control is *grep for every other site making the same claim*. D6 changed three
of twelve. `grep -rniE "consulted only when|cannot disagree|AUTHORITATIVE"` over
`src/` found the rest in seconds.

The original diagnoses follow, retained because they state what each fix had to
achieve and are the reference for the discrimination checks.

### Original diagnoses (in the priority order they were fixed)

**D1 (CRITICAL) — a dry run reports green on fabricated data.** Refs into a
stubbed step resolve to a Proxy; `applyOp` returns **true** for `exists`,
`truthy`, `neq`, `not(eq)` against it — the commonest gate shapes over an agent
output. Two halves, both required:
- *Report:* a gate with any stub-derived operand → `mode: "evaluated-on-stubs"`,
  verdict recorded but **not enforced**, run continues. Gates over deterministic
  operands enforce as built. `DryRunReport.status` must never be bare
  `"success"` when any gate ran on stubs. `isDryRunStub` already exists.
- *UI:* `web/src/routes/(app)/workflows/[name]/edit/+page.svelte:272-273` renders
  `status === 'success'` as a plain green badge. The per-step amber "stubbed" cue
  (`:284`) sits on the upstream **agent** step; the gate that consumed the
  fabricated value renders teal. The cue points at the wrong row.
- `workflow-dry-run.test.ts:195` currently asserts the green outcome as
  **intended** — update it to assert the labelled outcome.

**D2 + D5 (HIGH) — must change in one commit.** `asNameConflict`
(`src/db/queries/workflows.ts:82-89`) classifies on **message text**. Drizzle
wraps the driver error: SQLSTATE is on `.cause.code` (PGlite) / `.cause.errno`
(bun-sql), and the constraint name never reaches `err.message`. So the 409 race
close is inert and 500s. Also `migrate.ts:134` renames
`pipeline_definitions → workflow_definitions` and **Postgres does not rename
constraints**, so a lineage DB carries `pipeline_definitions_name_key`.
- Use the existing **`isUniqueViolation`** (`src/db/session-backfill.ts:118`) —
  its comment documents this exact failure. Delete the duplicated rule.
- **Simultaneously** rebuild `workflow-name-conflict-race.test.ts`. Its fixture
  hand-builds errors whose message strings contain the matcher's tokens
  (`:77`, `:88`, `:107`, `:116`), so it proves a fact about the fixture. Rebuild as
  `Object.assign(new Error("Failed query: …"), { cause: { code: "23505" } })` plus
  the bun-sql variant. It must **fail** before the matcher change. Keep the two
  negative tests.

**D6 (HIGH) — `docs/features/orchestration/workflows.md:65` ships a wrong safety
rationale in the present tense.** It says version id and hash "cannot disagree"
(true only of each other — both can disagree with what ran) and that the hash is
"consulted only when the version id is NULL" (a rule **no code implements**;
neither field is read anywhere in `src/` or `web/`). Scope the first claim; mark
the second as the contract C4 will implement.

**D3 — a run records a version it did not execute.** (a) The route executes
`resolved.entry.definition` but the executor does its own
`getWorkflowByName(name)` (`workflow-executor.ts:266-270`), so a YAML workflow
shadowing a DB row records the **DB row's** version. (b) `updateWorkflow` then
`ensureWorkflowVersion` are not transactional; a failure between them leaves
every later run stamped stale. Record the version of the definition you were
**handed**.

**D4 — the "violations propagate" claim is false.** `workflow-dry-run.ts:197`
claims `WorkflowDryRunViolation` propagates; the per-step catch
(`workflow-executor.ts:500`) turns it into an ordinary batch failure. Make it
true or delete the claim. **This is also the test that must fail loudly if
`stepSubstitute` is lost in the merge** — see §8.

**D7 — make `pinnedVersionIds` required.** `host-maintenance-daemon.ts:370`
calls `sweepWorkflowDefinitionVersions({})` on a daily tick inside a `try/catch`
that logs `warn` and continues. When C3 lands without supplying ids, the RESTRICT
violation degrades to a log line and the sweep **silently stops reaping,
permanently**. No test can catch it from where the call lives — a compile error
beats a log line.

**D8 (modest) — the cadence pair is inert.** `"ticks 1-23 do NOT sweep"` and
`"tick 24 runs the sweep"` both assert `toHaveLength(3)` against a keep of 50, so
neither can distinguish swept from not-swept; both pass with the sweep deleted.
Its comment claims a proof-by-contrast that does not exist. Seed past the keep
window so the two counts differ.

---

## 4. Planning documents

All on `feat/ez-factory` under `docs/plans/`. `tasks/` is **gitignored** — the
program spec there does not ship and each worktree carries its own copy.

| Doc | Authoritative for |
|---|---|
| `2026-07-29-ez-factory-design.md` | The program: 7 deltas C1–C7, migrations, C3 security review, **18 ported ez-code-factory invariants** (§4 is the binding checklist for Phase 9) |
| `2026-07-29-c4-implementation.md` | **Phase 2.** §7 build order, §11/§11.1 acceptance criteria |
| `2026-07-29-c2-implementation.md` | Phase 5 (done). §12 appendix: 9 spec errors |
| `2026-07-29-c6-implementation.md` | Phase 6 |
| `2026-07-29-c5-implementation.md` | Phase 3 (not started) |
| `2026-07-29-c7-implementation.md` | Phase 4 (not started) |
| `2026-07-29-c3-implementation.md` | Phase 7 (not started). Security-critical |
| `2026-07-29-ez-factory-extension-design.md` | Phase 8 |
| `2026-07-29-integration-plan.md` | The merge — **see §8** |
| `2026-07-29-tooling-defects.md` | §6 maintainer handover |

---

## 5. Environment hazards that produce *green results from wrong code*

**Working-directory drift.** A backgrounded command resets the session cwd
("Session cwd remains …"), after which `cd` does not persist. **A `cd` prefix is
NOT sufficient** — a heredoc with relative paths in its body still resolves
against the drifted cwd. **The control is absolute paths inside the write
itself.** Four agents including the lead hit this; in every case the tripwire was
an **impossible fact in the content** (a test count that couldn't be right, a git
log showing another branch's commits), never noticing location. Echo `pwd` on
anything whose output you will act on.

**Playwright reuses another tree's server.** `web/playwright.config.ts:74` is
`reuseExistingServer: !process.env.CI` on fixed port 4173. With multiple
worktrees, a bare `bun run test:e2e` can silently test a different branch's build
and report green. **Always pass `CI=1`**, and check `ss -ltnp | grep :4173` is
empty first — a killed run leaves the `vite preview` process holding the port,
and the next run dies with "port already used". `CI=1` also sets `forbidOnly`,
`workers: 4`, `reporter: list`; `retries: 0` in both modes (verified,
`playwright.config.ts:25`).

**`bun run test:e2e` is NOT the gate, and running it whole is meaningless.**
A blanket run gives **622 failures on clean `main`** (measured 2026-07-29, both
`main@afac7d36` and `feat/ez-factory-c6`; c6 ≈614, i.e. not worse). CI never does
this. The blocking check derives ANCHORED args from the **`mock-gate` lane** of
`web/e2e/lanes.json` (`ci.yml:165-168`), chromium only:

```bash
cd web && mapfile -t ARGS < <(bun ../scripts/e2e-lane-args.ts mock-gate)
CI=1 bunx playwright test --project=chromium "${ARGS[@]}"   # 105 pass / 12 skip / 0 fail
```

`lanes.json` gives every spec exactly one lane and documents `unwired` as *"the
HONEST backlog: runs in NO CI job today"* — **230+ specs**, including
`branding`, `workflows`, `accessibility`, `marketplace`, `validate-prod-shape`.
Those are the 622. `mock-gate` (13 specs) and `real-auth` (8) are blocking;
`evidence-soft` hard-fails the visual-evidence job only for diff-credited specs;
`docker` runs via `scripts/docker-test-all.sh`. `src/__tests__/e2e-lanes.test.ts`
enforces exhaustiveness, so a new spec with no lane entry fails the backend
suite — C6's three workflow specs are all in `evidence-soft`. Re-run that lane
with `CI=1 EZCORP_E2E_EVIDENCE=1 bunx playwright test --project=chromium
--grep @evidence <specs>`.

This supersedes the old "ignore `marketplace.spec.ts`" note, which understated
the situation by two orders of magnitude: marketplace is simply one of 230+
unwired specs. **A "clean full-suite e2e baseline" does not exist and cannot be
obtained** — do not spend time chasing one.

**Running a repro safely.** `git archive <sha> | tar -x -C /tmp/<name>`, symlink
`node_modules`. Gives a runnable tree that cannot touch anyone's worktree. Do
**not** leave scratch tests in a builder's `src/__tests__/` — `scripts/test.sh`
globs it and they join that agent's counts.

**Git discipline with shared worktrees.** `git add <explicit paths>` — never
`-A`. Verify `git diff --cached --stat` before and after each commit. Before any
revert, `git show --stat <sha>` to check it doesn't touch files outside its
stated scope: **a revert takes back everything a commit contained, including
files the committer did not author.**

**Cherry-picking across these branches does not work.** A pick conflicts on
**base divergence**, not file overlap. `bd9abc2e` onto `feat/ez-factory-c2`
produces a 174-line conflict where c2's side is empty, because Phase 2's feature
tests landed after c2's base.

---

## 6. Pre-existing repo defects — NOT this program's, for the PR

1. **`scripts/gate-integrity.ts` has a proven false-negative path.** `stripNoise`
   (`:271-283`) tracks quote state **per line**, so a line beginning with a
   closing backtick followed by `as {` opens a phantom quote, swallows the `{`,
   and the brace counter closes the test body early. Both directions reproduce:
   assertions after the desync become invisible (false positive), **and a test
   with no assertions at all can pass** (false negative). Fixtures in
   `2026-07-29-tooling-defects.md`. CODEOWNERS-owned (`.github/CODEOWNERS:26`) —
   worked around by hoisting row shapes to named type aliases.
2. **The Playwright port reuse** above. `playwright.config.ts` is CODEOWNERS-owned
   (`.github/CODEOWNERS:61`).
3. **~230 e2e specs are red on `main` and gate nothing.** Originally filed as
   "`marketplace.spec.ts:210` is broken on `main`" (true — it asserts
   `border-blue-500` after the page migrated to design tokens, and
   `git diff main..feat/ez-factory` on that path is empty). The real scope is
   far larger: a full-suite run is **622 failures on clean `main`**, and
   `web/e2e/lanes.json` classifies 230+ specs as `unwired` — *"the HONEST
   backlog: runs in NO CI job today"*. So they cannot regress a PR, and fixing
   them is not this program's job. See §5 for the command that IS the gate.
   Worth raising as its own issue; do **not** try to get a clean full-suite
   baseline before this PR (the earlier advice to do so was unachievable).

---

## 7. The four defect classes, and two rules

Every serious finding on this program presented as a **passing check**.

1. **Interaction** — two properties each correct, broken in combination.
   *Example:* the approval consent boundary correctly refused a hostile resume
   **and** the refusal routed through a helper that terminalized the run. Both
   checks green; the enforcement was a denial-of-service. The test asserted the
   returned object, never the row.
2. **Inert code** — computed, stored, never read. *Example:* C2's per-key quota
   cap was written at registration and no consumer existed; the registration test
   passed while the feature did nothing.
3. **Inert coverage** — 100% lines from assertions adjacent to the property
   rather than on it. *Example:* webhook index tests asserted "a duplicate is
   rejected" and passed with the defect present *and* fixed. Verify a test
   **discriminates**: reintroduce the defect and confirm it fails.
4. **Wrong rationale, correct code** — the behaviour is right, the stated reason
   is wrong, and the reason is what the next person relies on. *Examples:* a
   commit crediting a spy call-count with a property only a structural scan had;
   D6's doc paragraph.

**Rule 1 — an uncited assertion in a spec is where the defect is.** All nine C2
spec errors came from claims made without a `file:line` citation; every cited
claim held. Check the uncited assertions first rather than reading front-to-back.

**Rule 2 — assert the property, not something adjacent to it**, and name the test
after the property so a future refactor fails loudly.

---

## 8. The merge

`2026-07-29-integration-plan.md` (`51f2e9d0`, re-verified `ba96fd95`) carries its
own standing lesson: **it was accurate when written and wrong within hours** —
the conflict set went from one file to six. **Re-run the conflict analysis
immediately before merging, never from cache.**

Order: **C2 first** (furthest behind; every trunk commit widens the gap), then
**C6**.

**The riskiest line is still `src/runtime/workflow-executor.ts`** — the only file
where two branches edit the same lines. C6's `stepSubstitute` plumbing overlaps
the trunk's `executeFrom`/suspend-resume restructure, and keeping both hunks is
almost certainly right.

**This is no longer a SILENT hazard — D4's fix closed it.** The old warning
("if `stepSubstitute` is lost, nothing fails … D4's test currently would not
catch this") was true when written and is now false. Verified 2026-07-29 by
deleting the call site: **9 tests in `workflow-dry-run.test.ts` fail**, and the
first one throws `WorkflowDryRunViolation` naming the dispatch it attempted,
because violations are now recorded at their throw sites and re-thrown before a
report is built. So the merge check is simply: run
`bun test src/__tests__/workflow-dry-run.test.ts` after resolving that file.

Other checks: `coverage-thresholds.json` (three branches adding keys to one JSON
object — a botched resolution silently drops a threshold, which is a gate
weakening nobody notices); `src/extensions/types.ts` (three branches extend
`permissions`); migrations are all additive `IF NOT EXISTS` except C2's single
`DROP INDEX`, which is safe because its replacement covers a strict superset in
the same pass.

After merging C2, **run the workflow suites**, not just the extension ones.

---

## 9. Handover notes for Phase 8 (from Phase 5's author)

1. **C2 delivers the trigger, not the ability to act on it.** A cron/webhook fire
   is ownerless, so `ctx.workflows.run(...)` from a fire handler soft-fails
   `-32106` until C3 lands. **Do not demo Phase 5 with a workflow-running job.**
2. **`ctx.triggers.on(key, …)` must be called on EVERY startup for every key the
   extension holds** — not just at creation. A row with no registered handler
   drops its fires **silently**, and the orphan sweep reads the handler registry,
   so an unwired key is one the host eventually sweeps away. On boot, iterate
   every stored job and re-register its trigger handler.

## 10. Also required for Phase 7 (C3)

- **`src/extensions/workflows-handler.ts:373`** — `runtime.getWorkflows().find(w => w.name === fullName)`
  is the **last ownership-unaware resolution** in the codebase, and it is the
  extension trigger path C3's `runFor` takes over. D7 goes exactly there.
- C3's spec §11 carries **P1** (the `action` parameter must be threaded so D7 asks
  `run` specifically) and **P2** (record the `capability-types.ts:118-120` revisit
  answer *in that file*). Neither is optional.
- `ezcorp:workflows:run` is deliberately **not** in `SENSITIVE_KINDS`
  (`capability-types.ts:95-120`), and reason 2 rests on the workflow being
  extension-shipped. A user-forked workflow breaks that premise, so C3 needs a
  **separate** capability valued by job ref. Do not widen the existing one.
