# Repo tooling defects — maintainer report

**Date:** 2026-07-29
**Found by:** the `ez-factory` program (`feat/ez-factory`), incidentally
**Both defects are CODEOWNERS-owned.** We worked around them; we are **not**
proposing to patch either ourselves.

Two defects in shared repo tooling. Neither is caused by this branch and both
affect **every PR in the repo**, not just ours. Verified at `951a2419`.

| # | File | Severity | Failure direction |
|---|---|---|---|
| 1 | `scripts/gate-integrity.ts` | **High** | false positive **and false negative** — the gate can look away |
| 2 | `web/playwright.config.ts` | **Medium-High** | false confidence — green on the wrong build |

---

## Defect 1 — `gate-integrity.ts`: `stripNoise` loses quote state across lines

**File:** `scripts/gate-integrity.ts:271-283` (`stripNoise`), consumed by the
vacuous-test scanner at `:300-343`.
**Owner:** `@EZArchy` (`.github/CODEOWNERS:26`).
**CI job:** `gate-integrity` (`.github/workflows/ci.yml:247`, run at `:267`).

### Root cause

`stripNoise` tracks quote state in a local variable and **returns at end of
line**, so the state does not carry to the next line. A multi-line template
literal therefore desynchronizes it:

1. The **opening** backtick sets `quote`; the rest of that line is stripped; the
   function returns and the state is discarded.
2. Interior lines of the template are scanned **as if they were code**.
3. The **closing** backtick is then read as an *opening* quote — so everything
   after it on that line is stripped, including any `{` or `}`.

The brace walk at `:315-322` consumes that corrupted output, so `depth` drifts
from reality and the block boundary lands in the wrong place.

### Both failure directions, with a running repro

Save as `a.test.ts` — **false positive**: a real assertion is invisible because
the block is declared closed before it.

```ts
test("has assertions but they follow a multi-line template", async () => {
  const row = (await db.execute(sql`
    SELECT x FROM t WHERE id = ${id}
  `)) as {
    rows: Array<{ x: string }>;
  };
  expect(row.rows[0]?.x).toBe("y");   // line 7 — never seen
});
```

The closing `` ` `` on line 4 opens a quote, so the `{` after it is stripped; the
later `}` is still counted; `depth` reaches 0 at **line 6** and the scan stops
one line short of the assertion. Reported as `vacuous test (no assertion)`.

Save as `c.test.ts` — **false negative**, the severe one: a genuinely
assertion-free test **passes**, because the block runs long and swallows the
*next* test's assertion.

```ts
test("GENUINELY VACUOUS — no assertion anywhere in this block", async () => {
  const sqlText = `
  { this brace is inside a template literal
  `;
  doSomething(sqlText);
});

test("a later, legitimate test", () => {
  expect(1).toBe(1);              // counted for the block ABOVE
});
```

Here the interior line `{ this brace…` is scanned as code, so an unmatched `{`
is counted; `depth` never returns to 0 at the real end; the block extends to
line 11 and picks up the following test's `expect`.

Running the scanner's own logic over these three fixtures:

```
a.test.ts  opener@1  block ends@6   hasAssertion=false  -> FLAGGED vacuous   (false positive)
c.test.ts  opener@1  block ends@11  hasAssertion=true   -> pass              (FALSE NEGATIVE)
c.test.ts  opener@8  block ends@10  hasAssertion=true   -> pass
```

### Severity and blast radius

**High**, and the ranking is driven by the second direction. A gate that
produces noise is an annoyance — a reviewer learns to squint at it. A gate that
can **look away** silently weakens the feature contract's *"no assertion-free
tests"* rule for **every PR in the repo**, and the weakening is invisible: the
job is green.

The two directions also compound. Because the false positive trains everyone to
treat `gate-integrity` findings as noise, a real finding is more likely to be
waved through — which is exactly the condition under which the false negative
matters.

**Trigger shape** is common, not exotic: any test whose body contains a
multi-line template literal — i.e. most DB-backed tests in this repo, which use
`` sql`…` `` blocks routinely.

### Live instances

Three, all in `src/__tests__/workflow-run-persistence.test.ts` (phase 2's file),
all **false positives** — the first flagged test has **nine** assertions at
`:172-181`:

```
:140  test("run_phase defaults every pre-existing row to 'boundary' …")
:345  test("stores an approval with the documented defaults", …)
:409  test("deleting the answering user un-attributes the answer but keeps it", …)
```

### Our workaround — restructure the tests, not the gate

Hoist the SQL into a `const` above the call (or extract a query helper) so no
multi-line template sits between the test opener and its assertions. Five
minutes, no gate change, and the gate stays honest.

**We deliberately did not patch `gate-integrity.ts`.** It is CODEOWNERS-owned,
and editing a gate in the same PR that must pass it is the exact
weaken-the-gate move the feature contract forbids. A maintainer-applied
`gate-change-approved` label would be the only legitimate bypass, and it is not
warranted for a workaround this cheap.

### What a fix would need

Either direction is small; both need CODEOWNERS review:

- **Carry quote state across lines** — hoist `quote` out of `stripNoise` into
  the per-file scan so a template literal spanning lines stays "inside a
  string". Smallest diff; needs care that the state resets per file.
- **Strip template literals in a pre-pass** over the whole file before the
  line-wise walk, the way `stripBlockComments` (already called at `:300`)
  handles comments. More robust, and symmetric with the existing design.

Whichever is chosen, the fix should ship with the three fixtures above as
regression tests — the false-negative one especially, since nothing currently
proves the scanner does not look away.

---

## Defect 2 — `playwright.config.ts`: `reuseExistingServer` on a fixed port

**File:** `web/playwright.config.ts:74` (`reuseExistingServer: !process.env.CI`),
with `url: "http://localhost:4173"` at `:67`.
**Owner:** `@EZArchy` (`.github/CODEOWNERS:61` — explicitly listed).

### Root cause

Locally (`CI` unset) `reuseExistingServer` is **true**, and the server is
identified **only by port 4173**. Playwright probes the URL; if anything answers,
it adopts that server and skips its own `bun run build && bun run preview`.

With multiple worktrees active — which this program has run with throughout
(`ez-factory`, `ez-factory-c2`, and the primary tree) — a preview server left
running by **another tree** answers on 4173. A bare `bun run test:e2e` then
tests **that tree's build** while reporting against the current one.

### Severity and blast radius

**Medium-High.** The failure direction is **false confidence**: the suite is
green, the summary looks right, and the build under test was someone else's. No
error, no warning — the only symptom is a result that does not match the code.

Blast radius is any developer running e2e locally with more than one checkout,
which is now the normal shape of work on this repo (the worktree-isolation rule
in `CLAUDE.md` actively encourages multiple trees). It is worse for agents than
humans: an agent has no ambient sense that "the app looked stale".

### Our workaround

```
CI=1 bun run test:e2e
```

`CI=1` sets `reuseExistingServer: false` (`:74`), forcing a fresh build+preview.
Its other effects are benign or better: `forbidOnly: true` (`:18`),
`workers: 4` (`:26`), `reporter: "list"` (`:28`). `retries` stays 0 in both
modes (`:25`), so nothing is masked.

We also check the port is free before starting, since `CI=1` will fail to bind
rather than silently reuse — a loud failure, which is the correct trade.

### What a fix would need

- **Identify the server, not the port.** Probe a build-identifying endpoint
  (`/api/health` returning the image SHA, or a `?build=` marker) and only reuse
  when it matches the tree under test.
- **Or make the port per-worktree** — derive it from a hash of the repo root so
  two trees cannot collide, and let `reuseExistingServer` stay true for the
  fast local loop it exists to serve.
- **Or, cheapest:** leave the behaviour and add a startup log line naming the
  adopted server's origin and build, so a stale reuse is at least visible.

The first is the real fix; the third would have surfaced this in seconds.

---

## Summary for the maintainer

- **Defect 1 is the one to act on.** A quality gate with a false-negative path is
  a correctness problem in the gate itself. The repro is three files and the fix
  is a few lines in `stripNoise` — but it is CODEOWNERS-owned and needs a human.
- **Defect 2 is a footgun, not a bug in intent.** `reuseExistingServer` is
  correct for a single-tree workflow; it became unsafe when the repo standardized
  on worktrees. A build-identity probe or a per-worktree port resolves it.
- **Neither blocks the `ez-factory` program.** Both have workarounds in use, and
  this document exists so the workarounds do not quietly become the fix.
