# Handoff — approval timeouts (C4-T) and the chat-card answer surface (C4-C)

**Date:** 2026-07-31 · **Written for:** an agent with zero context on this work.
**Base:** `feat/ez-factory` @ `1f49d4b1` (89 commits ahead of `main@afac7d36`).

Two scoped pieces. They are independent — do them in either order, or in
parallel in separate worktrees. Every claim below carries a `file:line`;
**verify each one against source before building on it.** On this program,
uncited assertions were wrong nine times out of nine and cited ones always
held.

---

## 0. Ground rules that were earned the hard way

- **Work in your own worktree.** `git worktree add ./worktrees/<slug> -b <branch> feat/ez-factory`.
  Never edit another worktree.
- **Prefix every bash command with `cd <your worktree> &&`** and use absolute
  paths inside heredocs. A backgrounded command resets the shell cwd, and a
  relative path then resolves against a drifted tree. This bit this session
  three times; the tripwire was always an impossible fact in the *content*
  (a file "not found" that plainly existed), never noticing location.
- **`git add <explicit paths>`, never `-A`.** Verify `git diff --cached --stat`
  before and after each commit.
- **Assert the property, not something adjacent**, and **verify each test
  DISCRIMINATES**: reintroduce the defect, watch the test fail. A test that
  passes both ways reads as coverage and is worse than none.
- **Name what you did NOT cover** rather than implying coverage.

### Validation (all must pass)

```
bun run typecheck
bun run lint                      # must stay at the 52-warning baseline
bun scripts/gate-integrity.ts
bun run test                      # backend; 15669 pass / 0 fail / 1031 files at base
cd web && bunx vitest run         # 455 files / 5173 tests at base
bun run test:coverage             # gate PASSED, 934 enforced files at base
```

E2E — **the full suite is NOT the gate.** A blanket run is ~622 failures on
clean `main`; `web/e2e/lanes.json` documents 230+ specs as `unwired`
("runs in NO CI job today"). The blocking check is the `mock-gate` lane:

```
cd web && mapfile -t ARGS < <(bun ../scripts/e2e-lane-args.ts mock-gate)
CI=1 bunx playwright test --project=chromium "${ARGS[@]}"     # 105 pass / 0 fail
```

Check `ss -ltnp | grep :4173` is empty first; kill stray `vite preview` after.
**If you screenshot to verify a UI change, `PI_SKIP_INIT=1 bun run build`
first** — `vite preview` serves the BUILT output, and this session produced two
"after" screenshots identical to the "before" one for exactly that reason.

### Repo guards that will fire on you (all of them are right)

| Guard | What it wants |
|---|---|
| `scripts/coverage-thresholds.json` | a key (default 100) for every new source file |
| `scripts/test-coverage.sh` | new `web/src` files need a vitest-leg entry + `--coverage.include`. **CODEOWNERS-owned** — say so in your report |
| `web/e2e/lanes.json` | every new spec needs exactly one lane |
| `web/e2e/evidence-covers.json` | every `@evidence` spec needs source globs |
| `src/__tests__/helpers/mock-cleanup.ts` | every `mock.module()` target needs registering |
| `workflow-approval-chokepoint.test.ts` | any **mutating** handler under `api/workflows/approvals/**` must call `answerApproval` |
| `workflow-route-ladder.server.test.ts` | a name-scoped workflow route uses the ladder; an id-scoped one must delegate to a run-owner authority |

---

## 1. C4-T — wire the approval timeout sweep

### What is wrong

Three layers are built and **nothing connects them**:

1. `workflow-executor.ts:1510` computes and stores
   `expiresAt = now + step.timeoutMs` on the parked approval row.
2. `workflow-approvals.ts:136` `listExpiredWorkflowApprovals(now)` and
   `:152` `expireWorkflowApproval(id)` exist and are correct (both CAS on
   `status='pending'`).
3. **No caller.** Grep for either name outside tests and its own module: zero
   hits. `onTimeout` (`src/types.ts:442`, type `ApprovalTimeoutPolicy` =
   `"abort" | "approve" | "skip"`) is read by nothing at all.

So a deadline is written to the database and no clock ever looks at it.

**This is now user-visible and actively wrong.** The approvals inbox renders
the deadline (`web/src/routes/(app)/workflows/approvals/+page.svelte`, via
`describeDeadline` in `web/src/lib/workflow-approvals-logic.ts`), including
past the deadline: *"Expired — this run may already have been failed."* Nothing
fails it. The run stays parked forever. Shipping that string was a mistake made
in this session; your change is what makes it true — **or you must fix the
copy** (see the trap below).

### What to build

A sub-tick on `HostMaintenanceDaemon` (`src/extensions/host-maintenance-daemon.ts`).
The pattern is already there twice: `:341` (`GIN_SWEEP_TICK_MODULO`) and `:376`
(`VERSION_SWEEP_TICK_MODULO = 24`, `:81`). Follow it — a modulo sub-tick inside
the existing `try/catch`.

Each expired approval must have its `onTimeout` policy applied:

| policy | meaning |
|---|---|
| `abort` (default) | the run fails closed |
| `approve` | answer as approved and resume |
| `skip` | skip the step and resume |

### THE TRAP — read this before writing code

**A naive sweep will be silently refused and expire nothing, with every test
green.** `answerApproval` (`src/runtime/workflow-answer-approval.ts`) gained an
ownership check this session (commit `8e54ab1f`): with **no `rbacScope`
declared** — which is the default — the actor must be the run's **owner**, or
an admin, and a run with a NULL `user_id` is **admin-only**. The timeout sweep
answers on the *clock's* behalf with `userId: null` and no admin flag, so it
lands in exactly the branch that returns `forbidden`.

Consequences you must handle:

- The sweep needs an explicit **system actor** (`{ userId: null, isAdmin: true }`
  or a purpose-named equivalent). Decide deliberately and comment WHY, because
  "the sweep is allowed to bypass the owner check" is a security statement.
- **Write a test that asserts a row actually changed** — `status` moved off
  `pending`, and the run's fate matches the policy. A test that only asserts
  "the sweep ran" passes against a sweep that is refused every time. This is
  the interaction-class defect: two correct properties (the ownership check is
  right; the sweep is right) that are broken *in combination*.

Second trap: `workflow-executor.ts:1494-1499` documents that an `expired` row
is deliberately **re-parked** ("the sweep decides what an expiry MEANS via
`onTimeout`, and if the run got here with an expired row the sweep has not
applied its policy yet"). So after your sweep applies policy, confirm a run
cannot ping-pong between expired and re-parked.

Third trap — **the UI copy**. "Expired — this run may already have been failed"
is only true for `onTimeout: "abort"`. Under `approve` or `skip` the run
*continues*. Either make the copy policy-aware or make it neutral. It is
currently a lie; do not leave it as a differently-shaped lie.

### Done means

- A sub-tick invoking the sweep, gated like its siblings.
- All three policies applied, each with a test asserting the **row** and the
  **run's** resulting state.
- A test proving the sweep is not refused by the ownership check.
- Discrimination checks for each (remove the branch → the test fails).
- UI copy matching what the system actually does.
- `docs/features/orchestration/workflows.md` updated — it currently says these
  fields are "recorded but not yet enforced". That sentence must go.

---

## 2. C4-C — the chat-card answer surface

### What is wrong

C4's design calls for **three** answer surfaces sharing one guard (ported
invariant 7): REST, the Hub action, and a chat card. Two exist:

- REST — `web/src/routes/api/workflows/approvals/[id]/+server.ts`
- Hub tab — `src/runtime/workflow-approvals-hub-page.ts`

The chat card does not, because a workflow run has **no conversation**:
`workflowScopeKey()` mints a synthetic `workflow-run:<id>` precisely so every
conversation-keyed lookup fails **closed**, and `workflow_approvals` carries no
conversation column.

### The chosen approach (option 2 of three that were considered)

Render the card from the **tool result**, where a conversation genuinely
exists. `handleWorkflowsRpc` (`src/extensions/workflows-handler.ts:186`) carries
`ctx.conversationId` (`:128`, threaded at `:271`). When a workflow invoked from
a chat parks on an approval, that handler's result is the natural carrier.

The card's text is already built and tested: `formatGateRelay()` in
`src/runtime/workflow-approval-relay.ts` returns `{ stop, directive, text,
items }` and enforces ported invariant 2 — the finding cannot be rendered
*without* the "relay verbatim, do not pre-judge, STOP" directive, and item text
is never truncated, re-cased, re-ordered or de-duplicated. **Use it. Do not
write a second formatter** — that is the drift invariant 2 exists to prevent.

Rejected alternatives, so you do not re-litigate them: adding a nullable
`conversation_id` to `workflow_approvals` (a column most rows would never use),
and dropping the card entirely (still the honest fallback if option 2 proves
unworkable — say so rather than forcing it).

### Constraints

- **Answer through `answerApproval` and nothing else.** The chokepoint test
  asserts this by **call count on a spy**, not by inspection — a card that
  reimplemented the rules, however correctly, fails it. See
  `src/__tests__/workflow-approvals-hub-page.test.ts` for the pattern to copy.
- **Per-item consent.** The Hub tab deliberately *cannot* answer an
  item-consent approval — a page action's payload admits only flat values, so
  a ticked list cannot ride in one, and a button sending none (refused) or all
  (consent laundering) is worse than a pointer to the inbox. A chat card has no
  such limit, so it **may** support item consent — but if it does, it must send
  exactly what the human ticked, never the offered list. `buildAnswerBody` in
  `web/src/lib/workflow-approvals-logic.ts` already encodes that rule and is
  tested; reuse it if the card is Svelte-side.
- Tool cards live in `web/src/lib/components/tool-cards/`. Match a sibling's
  structure. Frontend-visual changes need an `@evidence` Playwright spec
  calling `captureEvidence(...)`, plus lane + evidence-covers entries.

### Done means

- A parked approval raised by a chat-invoked workflow renders an answerable
  card in that conversation.
- Answering it routes through `answerApproval`, proven by call count.
- The relay's directive and verbatim items are what the card shows.
- Ownership is enforced (the same rule as every other surface — see §1's trap).
- `@evidence` spec + lane + evidence-covers entries.

---

## 3. State you are inheriting

- `feat/ez-factory` @ `1f49d4b1`: Phase 1 (C1), Phase 2 (C4, steps 1-9),
  Phase 5 (C2, merged), Phase 6 (C6, merged).
- **Not started:** Phase 3 (C5 trace/telemetry), Phase 4 (C7 skip/sub-workflows),
  Phase 7 (C3 delegated execution — security-critical), Phase 8 (the
  `ez-factory` extension), Phase 9 (delete `ez-code-factory`).
- Authoritative specs are in `docs/plans/`; `2026-07-29-c4-implementation.md`
  governs Phase 2 detail and wins on any conflict.
- The branch is **3 commits behind `main`** — rebase or merge `main` before the PR.
- `scripts/test-coverage.sh` (CODEOWNERS-owned) has been extended several times
  to measure new files. Adding to it is fine and expected; flag it in your report.

## 4. Report back

State plainly: what you built, which tests prove which property, the result of
each **discrimination** check, every gate's output, and — required — what you
did **not** do and why. If an instruction here turns out to be wrong, say so
**before** complying and wait for an answer; a confidently-written instruction
was overturned repeatedly on this program, several of them the lead's.
