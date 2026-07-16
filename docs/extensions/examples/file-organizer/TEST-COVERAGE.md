# file-organizer — Test Coverage Audit

> Status snapshot: 2026-06-19 (rev 2). Author: e2e coverage audit pass.
>
> **VERDICT (do we have FULL e2e coverage?): NO — and it cannot be FULL
> in the dev container.** The host fs/daemon/applier + pure logic are
> thoroughly real-tested and CI-gated (`bun test`). The browser-level e2e
> is now split into: (a) a 23-case **mock** UI suite, and (b) a 12-case
> **real-backend** Docker-gated suite (all active `test()`; only the
> proposal-accept case self-skips at runtime when no daemon proposal is on
> disk) that asserts on real validator responses + real on-disk
> `config.json`. The former blocker to a true "add → SEE it in the Hub"
> e2e — the **data-dir split** (§7) — is now FIXED (the render subprocess
> resolves its data dir from `EZCORP_EXTENSION_DATA_ROOT`, the project root
> the host writes to, instead of the vite-SSR `process.cwd()` of
> `/app/web`), so those "add → see it in the Hub" assertions are now
> ACTIVE `test()` cases ("data dirs aligned").
> e2e gates **nothing** in CI (there is no Playwright job) — see §6.
> **Honesty framing:** this document distinguishes **mock-backend** tests
> (which validate UI rendering / wiring against stubbed HTTP) from
> **real-backend** tests (which exercise the actual subprocess render,
> daemon, applier, fs, and validation). A green mock test is **not**
> end-to-end validation — it only proves the UI renders the tree the mock
> handed it and POSTs the body we expected.

---

## 1. TL;DR

- The extension's **pure logic** (config, rules, proposals, applier-plan,
  quarantine, fswalk) and the **host fs layer** (daemon, applier, state,
  events dispatcher) are **very well covered** by real-fs `bun test`
  suites. These are the load-bearing safety guarantees and they are
  CI-gated (`test-backend` job).
- The **e2e layer is 100% mock-backend** today
  (`web/e2e/file-organizer-hub.spec.ts`, 23 cases). It never starts the
  render subprocess, never calls the real add-folder validator, never
  touches the daemon or `/api/fs/list`. Every real bug found this session
  (data-dir split, picker 403, render provenance) was **invisible** to it.
- There is **no e2e job in CI** (`.github/workflows/ci.yml` has
  typecheck / test-backend / test-web / lint / manifest-lock / coverage,
  **no playwright**). So e2e gates **nothing** today — mock or real.
- After this pass we add a **real-backend, Docker-gated** spec
  (`web/e2e/file-organizer-real.spec.ts`) that hits the live dev
  container and asserts on **real** add-folder responses + real
  `config.json` persistence. It is correctly gated so it does **not**
  run in the default mock suite.

**Do we have a "validate everything" e2e?** No — see §7.

---

## 2. Coverage matrix (feature surface × layer)

Legend — Backend: **mock** = stubbed HTTP, **real** = real fs/subprocess.
CI: ✅ gated by a `ci.yml` job, ❌ not gated.

### 2a. Hub pages (render)

| Surface | Unit | Integration | e2e | Backend | CI |
|---|---|---|---|---|---|
| overview page tree (`lib/page.ts` `buildOverview`) | ✅ `lib/page.test.ts` | — | ✅ `file-organizer-hub.spec.ts` "overview…" | unit=real-pure / e2e=**mock** | unit ✅ / e2e ❌ |
| review page tree (`buildReview`, dual-mode, pagination, segments) | ✅ `lib/page.test.ts` | — | ✅ hub.spec (accept/reject/deletes/undo/restore) | unit=real-pure / e2e=**mock** | unit ✅ / e2e ❌ |
| folders page tree (`buildFolders`) | ✅ `lib/page.test.ts` | — | ✅ hub.spec (mode/preset/ignore/add) | unit=real-pure / e2e=**mock** | unit ✅ / e2e ❌ |
| **render subprocess** (host→subprocess `ezcorp/page.render`) | — | partial `index.test.ts` (in-memory FsLayer) + `index-hostfs.test.ts` (SDK-throw arms) | ❌ none | integration=**mock fs** | ✅ (bun) / e2e ❌ |
| **render provenance** (token mint in `hub-render-pull.ts` authorizing subprocess reverse-RPC fs reads) | — | `src/__tests__/hub-render-pull.test.ts` | ❌ none (NEW real spec exercises it implicitly) | **real-ish** (host unit) | ✅ |

### 2b. Host events / actions (`src/extensions/file-organizer-events.ts` → `IN_PROCESS_EVENTS`, dispatched to `file-organizer-state.ts`)

All 23 in-process events are routed-and-tested at the host layer
(`file-organizer-events.test.ts` dispatcher routing +
`file-organizer-state.test.ts` mutation behavior, both **real fs**).
Columns: **e2e (mock)** = a Playwright case drives the action button
against a stubbed `{ok}`; **e2e (REAL)** = a Docker-gated
`file-organizer-real.spec.ts` case POSTs the live events route and
asserts on the **real** `{ok,message}` and/or the **real** on-disk
`config.json` (read via `docker exec`).

| Event | Host unit/integ (real fs) | e2e (mock) | e2e (REAL) | CI |
|---|---|---|---|---|
| select-segment | ✅ | ✅ (page action) | — | host ✅ / e2e ❌ |
| page-window | ✅ | ✅ (page action) | — | host ✅ / e2e ❌ |
| focus | ✅ | ✅ (table row action) | — | host ✅ / e2e ❌ |
| reload-config | ✅ | — | — | host ✅ |
| scan-now | ✅ | — | — | host ✅ |
| accept | ✅ | ✅ "review: accept…" | ✅ real proposal accept (**skips when no daemon proposal on disk**) | host ✅ / e2e ❌ |
| reject | ✅ | ✅ "review: reject…" | — | host ✅ / e2e ❌ |
| reject-segment | ✅ | — | — | host ✅ |
| confirm-deletes | ✅ | ✅ "batch-confirm deletes…" | — | host ✅ / e2e ❌ |
| undo-batch | ✅ | ✅ "undo last auto-batch…" | — | host ✅ / e2e ❌ |
| dismiss-stale | ✅ | — | — | host ✅ |
| retry-failed | ✅ | — | — | host ✅ |
| restore | ✅ | ✅ "restore from quarantine…" | — | host ✅ / e2e ❌ |
| purge | ✅ | — | — | host ✅ |
| empty-quarantine | ✅ | — | — | host ✅ |
| purge-expired | ✅ | — | — | host ✅ |
| set-mode | ✅ | ✅ "set mode (Auto)…" | ✅ real persist (`fully-auto`) | host ✅ / e2e ❌ |
| toggle-preset | ✅ | ✅ "toggle a preset…" | ✅ real persist (`junk-sweep`) | host ✅ / e2e ❌ |
| **add-folder** | ✅ state + `file-organizer-picker-path-integration.test.ts` | ✅ mock hub.spec | ✅✅✅✅ typed-absolute **accept+persist**, relative **refusal**, unreachable **refusal**, descendant **already-covered refusal** | host ✅ / e2e ❌ |
| set-backlog-policy | ✅ | — | ✅ real persist (`include-existing`) | host ✅ |
| remove-folder | ✅ | — | ✅ real persist (folder gone) | host ✅ |
| add-ignore | ✅ | ✅ "add an ignore…" | ✅ real persist (`*.partial`) | host ✅ / e2e ❌ |
| add-rule | ✅ | — | ✅✅ valid-DSL **persist** + malformed-DSL **refusal** | host ✅ |
| teach-rule (agent/overview action) | ✅ (config `addFolderRule` + DSL in `rules.test.ts`) | ✅ "Teach-a-rule prompt…" | — (agent-forwarded, not in-process) | host ✅ / e2e ❌ |

**Real-backend e2e gaps that remain (by design, NOT mock-stubbed):**
`reject`, `reject-segment`, `confirm-deletes`, `undo-batch`,
`dismiss-stale`, `retry-failed`, `restore`, `purge`, `empty-quarantine`,
`purge-expired`, `scan-now`, `reload-config`, `select-segment`,
`page-window`, `focus` have **no real-backend e2e**. Most are
proposal/quarantine-lifecycle ops that need a daemon-produced proposal
or a quarantined entry on disk to exercise meaningfully (the real spec's
`accept` case is the template — it conditionally `test.skip`s when no
pending proposal exists). They are all **real-fs unit/integration
tested** at the host layer, so the safety guarantees are covered; what's
missing is the browser→route→disk round-trip for them specifically.
A seeded proposals.json / quarantine manifest fixture in the container
would let these flip from host-unit-only to real-backend e2e.

### 2c. Host daemon / applier / state / config

| Surface | Coverage | Backend | CI |
|---|---|---|---|
| daemon (`file-organizer-daemon.ts`) — modes, stability, dedup, lockfile, kill-switch, circuit-breaker, real interval | `file-organizer-daemon.test.ts` (66 tests) | **real fs**, injected clock | ✅ |
| applier (`file-organizer-applier.ts`) — copy/verify/unlink, containment, journal replay, symlink-leaf, EXDEV | `file-organizer-applier.test.ts` (28) + `file-organizer-applier-exdev.test.ts` (10, mocked fs-promises for error branches) | **real fs** + targeted fs mock | ✅ |
| state (`file-organizer-state.ts`) — CAS accept/reject, config mutations, quarantine, audit gate | `file-organizer-state.test.ts` (~45) | **real fs** | ✅ |
| config validation (`lib/config.ts`) | `lib/config.test.ts` (27, 100%) | real-pure | ✅ |
| security (no-network, containment, fail-closed) | `src/__tests__/security/file-organizer-security.test.ts` (7) | **real subprocess** w/ `--preload` | ✅ |

### 2d. Cross-cutting concerns

| Concern | Covered? | Where | Backend | CI |
|---|---|---|---|---|
| **Data-dir split** (FIXED: render + daemon now agree on the data dir via `EZCORP_EXTENSION_DATA_ROOT`) | ✅ covered by active `test()` "data dirs aligned" cases (add-folder appears / config reflects / Review renders) | `file-organizer-real.spec.ts` | real | e2e ❌ |
| **Picker → real `/api/fs/list`** (Browse) | ❌ no real coverage; real endpoint **403s** for `dir=/` (jailed to project root) | — | — | ❌ |
| **Picker → validation** (typed path → `normalizeFolderPath`) | ✅ `file-organizer-picker-path-integration.test.ts` | real validator | ✅ |
| toast on refused add (`ok:false`) | ✅ mock hub.spec + **NEW real spec (real refusal string)** | mock + **real** | e2e ❌ |
| live SSE invalidation (`ext:page-state` re-pull) | ✅ hub.spec "live invalidation" | mock | e2e ❌ |
| daemon auto-tick (lockfile boot-token) | ✅ daemon.test | real fs | ✅ |

### 2e. Agent tools (`index.ts`)

| Tool | Covered? | Where | Backend | CI |
|---|---|---|---|---|
| describe_current_workflow | ✅ | `index.test.ts` (tool dispatch) | mock (in-mem FsLayer) | ✅ |
| propose_target_workflow | ✅ | `index.test.ts` | mock | ✅ |
| apply_workflow_config | ✅ | `index.test.ts` + config guards | mock | ✅ |
| set_folder_rules | ✅ | `index.test.ts` + config | mock | ✅ |
| teach_rule | ✅ | `index.test.ts` + `rules.test.ts` (DSL) | mock | ✅ |
| propose_moves | ✅ | `index.test.ts` + `proposals.test.ts` | mock | ✅ |
| organize_backlog | ✅ | `index.test.ts` + config `setBacklogPolicy` | mock | ✅ |
| **agent tools end-to-end via a real LLM run** | ❌ none | — | — | ❌ |

---

## 3. Honest assessment of the existing e2e (`web/e2e/file-organizer-hub.spec.ts`)

**It is 100% mock-backend.** Every case calls `mockApi(...)`, then
`page.route("**/api/hub/pages/<id>", …)` to fulfill a hand-written tree,
and `page.route("**/api/extensions/file-organizer/events/<evt>", …)` to
fulfill `{ok:true}` / `{ok:false}` envelopes. **No real render
subprocess, no daemon, no applier, no real validator, no real
`/api/fs/list` runs.** It is a faithful **UI-rendering + action-wiring**
suite — and valuable as such — but it must not be presented as
end-to-end validation of the feature.

### The "BROWSE + select" fiction (lines 262–318)

The case
`"folders: BROWSE + select in the file-path picker yields an ABSOLUTE
path"` mocks `/api/fs/list` to return `[{name:"Downloads", isDir:true}]`
at `dir=/`, then drives the picker's Browse button and asserts the
selected value is `/Downloads`.

**This does not happen against the real backend.** Verified live this
session: `GET /api/fs/list?dir=/` returns **403** — the endpoint is
sandbox-jailed to the project root, so Browse cannot list `/` and cannot
reach an arbitrary watch folder. In the real app the **only** working
add-folder path is a **typed absolute path** (e.g.
`/app/projects/fo-test-watched`). The "absolute-mode" picker fix only
affects browse/select, which is exactly the jailed flow.

**Recommendation:** **Keep, but relabel.** It is a legitimate
**component-logic** check that absolute-mode browse emits `/`-rooted
values (it asserts the picker browses `/` not `~`, which is the real
regression it guards). It is **not** a backend integration check and the
docstring should say so. The real add-folder path is now covered by the
typed-absolute case in `file-organizer-real.spec.ts`. (This pass adds a
clarifying note to that case's docstring rather than deleting a useful
component regression guard.)

---

## 4. Prioritized GAP list

1. **[P0] No e2e CI job at all.** e2e gates nothing. Even the mock suite
   could regress silently. → §6 recommendation.
2. **[RESOLVED] No real-backend e2e for the headline flow.** Until this
   pass, "add a watched folder" was only ever exercised against a mock
   that returns `{ok:true}`. The real validator, real config.json write,
   and real refusal strings were never asserted from the browser. →
   **addressed** by `file-organizer-real.spec.ts`: add-folder accept +
   persistence + all three refusal branches, plus a full config-mutation
   round-trip (set-mode/toggle-preset/add-ignore/set-backlog-policy/
   add-rule/remove-folder) asserted against the real on-disk config, plus
   add-rule DSL refusal, the picker 403, and — now that the data-dir split
   is fixed (item 3) — the "add → see it in the Hub render" round-trip
   ("data dirs aligned"). **12 cases, all active `test()`; only the
   proposal-accept case self-skips live when no daemon-produced proposal is
   on disk (11 pass / 1 skip, or 12 / 0 when one is pending).** The
   remaining proposal/quarantine-lifecycle events still lack a real-backend
   e2e (they need an on-disk proposal/quarantine fixture — see §2b).
3. **[RESOLVED] Data-dir split.** Previously, in the dev container an add
   succeeded (`/app/.ezcorp/…/config.json` gained the entry) but the Hub
   render read `/app/web/.ezcorp/…/config.json` (the vite-SSR `process.cwd()`)
   and showed "No folders watched". → **fixed**: the extension now resolves
   its data dir from `EZCORP_EXTENSION_DATA_ROOT` (the project root, e.g.
   `/app`, injected by the host) instead of `process.cwd()`, so reader and
   writer agree; the `$CWD` fs-grant likewise expands to the project root so
   the host-mediated read of `/app/.ezcorp/…` is covered by the extension's
   `["$CWD"]` grant. The real spec's three "appears/reflects in the Hub
   render" assertions ("data dirs aligned") are now **active `test()`**
   cases, not skips. Prod (cwd `/app`) always agreed on both sides, so prod
   was never affected.
4. **[P1] Picker Browse is unreachable in the real app (403).** Product
   decision needed: either relax the fs-list jail for the Hub picker, or
   drop Browse from the file-path prompt and document "typed absolute
   only". No test can make Browse work until that decision lands.
5. **[P1] Render subprocess + provenance has no e2e.** The host-unit
   `hub-render-pull.test.ts` covers token mint, but nothing drives the
   full host→subprocess render from a browser against real state. The
   new real spec exercises it implicitly (the folders page renders via
   the subprocess), but does not assert provenance specifically.
6. **[P2] Agent tools have no real-LLM e2e.** All 7 tools are unit-tested
   against an in-memory FsLayer; none are exercised through an actual
   model run writing real config/proposals. (Lower priority — the host
   state layer that the tools ultimately hit IS real-fs tested.)
7. **[P2] Mock e2e missing UI states.** Loading skeleton, render-error
   card + Retry, prompt cancel/escape, confirm cancel, empty states per
   page, optimistic→re-pull on every action. → addressed by the mock
   bucket expansion in this pass.

---

## 5. What this audit pass adds

- **Mock bucket** (`file-organizer-hub.spec.ts`, expanded): loading
  skeleton, render-error card + Retry recovery, refresh re-pull,
  prompt cancel + Escape-to-cancel, confirm cancel (no POST), folders
  empty-state, review empty quarantine, overview no-attention state.
  **Docstring updated** to state these validate UI rendering against
  MOCKED backends only, and to flag the Browse case as component-logic.
- **Real bucket** (`file-organizer-real.spec.ts`, Docker-gated,
  **12 cases, all active `test()`** — only the proposal-accept case
  self-skips live when no daemon proposal is on disk — on
  `ezharness-app-1`, overridable via `EZCORP_APP_CONTAINER`): log in to the
  live container and assert on **real**
  responses + **real** on-disk
  `config.json` (read via `docker exec … cat
  /app/.ezcorp/extension-data/file-organizer/config.json`, the WRITER
  dir). Cases:
  1. **add-folder typed absolute** → accepted + persisted (oracle: the
     entry is on disk AND a re-add is refused "already being watched").
  2. **add-folder relative** → exact refusal
     `Path must be an absolute, valid filesystem path.`
  3. **add-folder unreachable absolute** → the
     "isn't visible to the EZCorp container — mount it…" message, and
     the path is NOT written to config.
  4. **add-folder descendant** of a watched folder → "Already covered by
     watched folder …" (uses an EXISTING subdir so it clears the
     reachability exists-probe and reaches the overlap guard).
  5. **add-rule malformed DSL** → exact parse error `missing '->
     destination'` (parser runs before config, no valid folder needed).
  6. **config-mutation round-trip** against a REAL folder id read back
     from config.json: `set-mode` (`fully-auto`), `toggle-preset`
     (`junk-sweep`), `add-ignore` (`*.partial`), `set-backlog-policy`
     (`include-existing`), `add-rule` (valid DSL), `remove-folder` —
     each asserted against the persisted config.
  7. **picker Browse** → real `GET /api/fs/list?dir=/` returns **403**
     (documents the sandbox jail; only typed-absolute add works).
  8. **UI refusal toast** → the real Folders page + relative path renders
     the real refusal as an error `alert`.
  9. **add-folder APPEARS in the Hub render** ("data dirs aligned") → a
     real add surfaces in the Folders render (reader + writer now share the
     data dir — see §4.3).
  10. **config mutation REFLECTS in the Folders Hub render** ("data dirs
      aligned") → a toggled preset on a sibling folder renders post-mutation.
  11. **Review Hub render loads** against the live backend ("data dirs
      aligned") → the render succeeds reading the same dir the daemon writes.
  12. **proposal-lifecycle accept** → accepts a REAL pending daemon proposal
      and asserts the row is no longer pending (the ONLY case that
      self-skips, and only when no pending proposal is on disk).
  - **Skip (1, conditional):** only the proposal-accept case (#12)
    `test.skip`s at runtime — when no daemon-produced pending proposal is on
    disk (honest — it asserts a REAL file move when one exists). The three
    "appears/reflects in the Hub render" cases ("data dirs aligned") are now
    **active** — the data-dir split they used to be blocked on is fixed
    (§4.3).
  - **Rate limiter:** the events route allows **10 actions/min/user**
    (fixed 60s window). The suite fires more than that, so `postEvent`
    rides out a 429 by waiting `Retry-After` and retrying — a real user
    never hits this. The describe runs `mode: "serial"` with a 90s
    per-test timeout for this reason.
  - **Cleanup:** the suite snapshots `config.json` in `beforeAll` and
    restores the exact bytes in `afterAll`, so the shared container is
    left exactly as found (verified: no folder/preset/ignore/rule
    pollution post-run).
  - **Real findings surfaced (no product change made — TEST task):**
    (a) the events route does **not** validate `mode`/`preset` values —
    an invalid `mode` returns `ok:true` but `setFolderMode` silently
    no-ops it (the config layer guards, the route doesn't). The tests
    therefore use REAL enum values. (b) `add-folder` runs the
    reachability **exists-probe before** the overlap guard, so a
    non-existent descendant path returns the visibility message, not
    "already covered" — the descendant test uses an existing subdir.

---

## 6. CI wiring recommendation (do NOT auto-apply the Docker job)

Add an **e2e-mock** job to `.github/workflows/ci.yml` (safe, no Docker,
mirrors the existing `webServer` preview the playwright config already
builds):

```yaml
  e2e-mock:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: 1.3.14 }   # pin to match the rest of ci.yml
      - run: bun install --frozen-lockfile
      - run: cd web && bunx playwright install --with-deps chromium
      - run: cd web && bunx playwright test --project=chromium
```

- **What it gates:** UI rendering + action-wiring of the Hub (and every
  other mock e2e spec). It would have caught a broken tree render, a
  wrong POST body, a missing testid, a dialog regression.
- **What it does NOT gate:** the real subprocess render, the daemon, the
  real validator, the data-dir alignment, the picker 403 — because the mock
  suite stubs all of those (the data-dir alignment is instead covered by the
  Docker-gated real spec's "data dirs aligned" cases). **Do not let a green
  `e2e-mock` job be read as "the feature works end-to-end."**

The **Docker real-backend suite** (`DOCKER_TEST=1`) should **not** be
wired into PR-blocking CI yet: it needs a seeded container
(`docker-auth-setup.ts` expects `test@test.com`/`Test123!` on `:3000`).
Run it as a **manual / nightly non-blocking** workflow (or locally) until
that seeded container (and the picker decision) can be provided in CI.
Gate it explicitly so a missing container fails fast rather than silently
passing.

---

## 7. Plain answer: do we have a "validate everything" e2e?

**Not as one CI-enforced gate — but the add-folder round-trip is now
covered.** After this pass we have, for the headline add-folder flow:

- ✅ a **real-backend** assertion that the validator + config persistence
  work (typed absolute add, real refusal),
- ✅ a **real-backend** "add a folder **and see it appear in the Hub
  render**" assertion — the data-dir split that used to block this is now
  **FIXED** (§2d, §4.3), so those "data dirs aligned" cases are active
  `test()` in the Docker-gated spec, AND
- ✅ a much stronger **mock** UI suite.

Two things still keep this short of a single "validate everything" gate
that runs on every PR:

1. **Picker decision (unresolved):** Browse 403s against the jailed
   `/api/fs/list`, so the realistic point-and-click add can't reach a
   watch folder — the working real add-folder path is a **typed absolute
   path**. Needs a product decision (relax jail for the Hub picker, or
   drop Browse).
2. **No e2e CI job:** even the coverage we *do* have — mock and
   Docker-gated real — isn't enforced on PRs.

Until those land, the honest statement is: **the host fs/daemon/applier
and pure logic are thoroughly real-tested and CI-gated; the browser-level
e2e is mock-backend plus a Docker-gated real suite that DOES assert the
full "add → see it in the Hub" round-trip (the data-dir split is fixed);
what's missing is a point-and-click Browse path (jailed 403) and any e2e
job wiring so this runs on PRs.**
