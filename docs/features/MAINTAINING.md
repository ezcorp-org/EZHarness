# Maintaining `docs/features/`

> _The authoritative rules for keeping the feature-oriented documentation map correct over time: what belongs here, the exact 8-section template every doc follows, the 6-domain folder taxonomy, and how to add, update, and ground every claim in source._

This is meta-documentation. It does **not** describe an EZCorp capability — it
describes how to write and maintain the docs that do. Read it before adding or
editing anything under `docs/features/`. Every rule here exists so a new
contributor can produce a correct doc from this file alone.

## Intent

`docs/features/` is the **feature-oriented map** of EZCorp: one Markdown file
per user-facing or developer-facing capability, grouped into six domain folders,
cross-linked into a wiki via `[[slug]]` references. It is the entry point a
contributor (or an LLM agent) reads to understand *what a capability is, how it
works end-to-end, and which files implement it* — without reading the whole
codebase first.

It is deliberately **not** an API reference generator and **not** a duplicate of
the deep specs in `docs/*.md`. Each feature doc is grounded in real source
(every path, symbol, route, and env var must exist), links out to the deep spec
when one exists, and honestly records known gotchas and open issues. The value
of the map is its accuracy; a stale or invented claim is worse than no doc,
because it sends readers down the wrong path with false confidence.

## How it works

### What belongs here (scope)

A file under `docs/features/` documents **one capability** — a coherent slice of
behavior a user or developer would name as a thing ("Conversations & Threading",
"Web Search", "Projects & Root Resolution"). A capability typically spans
multiple files, a DB table or two, an API surface, and some UI.

| Belongs in `docs/features/` | Does **not** belong |
|---|---|
| A user-facing or developer-facing **capability** that spans several files | A **single file** — document it with a header comment, not a feature doc |
| A behavior with an API surface, UI entry point, or SDK contract | A **test fixture**, mock, or harness helper |
| Something a reader would name and ask "how does X work?" | **Dead code** or a deprecated path kept only for compatibility |
| A cross-cutting concern wired through the runtime (e.g. permissions, audit) | An internal helper with no independent behavior (document it inside the feature that owns it) |

If you can't write a one-sentence Intent that names a *capability* (not a
file or a function), it doesn't get its own doc — fold it into the doc for the
feature that owns it.

### The doc template (8 sections, exact)

Every feature doc has the **same eight parts**, in this order. The two existing
references — `chat/conversations.md` and `tools/web-search.md` — are the
canonical examples; match them exactly.

1. **`# Title` + blockquote tagline** — an `H1` title (the human name of the
   capability) immediately followed by a one-paragraph `> _italic_` blockquote
   that summarizes the whole feature in a sentence or two. This is the elevator
   pitch a reader skims first.
2. **`## Intent`** — *why this exists and what problem it solves.* Prose, not a
   list. Frame the capability and the key design decision behind it.
3. **`## How it works`** — *the end-to-end mechanism.* The longest section. Use
   `###` sub-headings (data model, the request pipeline, dispatch path, etc.)
   and number the steps of any pipeline so a reader can trace the data path.
4. **`## Usage`** — *how to invoke it.* REST tables (`Method & path | Scope |
   Purpose`), SDK snippets, UI entry points, and an **Env vars / settings**
   subsection. This is the operator/consumer-facing reference.
5. **`## Key files`** — *a bulleted list of the load-bearing source files*, each
   with a one-line description of its role. Repo-relative paths only. This is the
   jump table from concept to code.
6. **`## Features it touches`** — *a `[[slug]]` wiki-link list* of every other
   feature this one interacts with, each with a one-line description of the
   interaction. This is what weaves the map together.
7. **`## Related docs`** — *links to the deep spec(s) under `docs/*.md` or
   `docs/extensions/*`.* If none exists, state explicitly that this file is the
   primary reference.
8. **`## Notes & gotchas`** — *honest caveats, known open issues, and
   non-obvious invariants.* Bold the lead phrase of each bullet. Mark open
   security findings and stale upstream docs explicitly.

#### Copyable skeleton

```markdown
# <Human Name of Capability>

> _<One-or-two-sentence summary of the whole feature.>_

## Intent

<Why this exists, the problem it solves, the central design decision. Prose.>

## How it works

### <Sub-aspect, e.g. Data model>

<Grounded mechanism. Number pipeline steps.>

### <Sub-aspect, e.g. The request pipeline>

1. <Step one, citing the real symbol/file.>
2. <Step two.>

## Usage

### REST API

| Method & path | Scope | Purpose |
|---|---|---|
| `GET /api/<thing>` | `read` | <what it does> |

### UI entry points

- <route or component> — <what the user does here>

### Env vars / settings

- `EZCORP_<VAR>` (default …) — <effect>
- Settings key `<key>` — <effect>

## Key files

- `src/<path>.ts` — <one-line role>
- `web/src/routes/api/<path>/+server.ts` — <one-line role>

## Features it touches

- [[<slug>]] — <how they interact>

## Related docs

- [<deep spec>](../../<spec>.md) — <what it covers>
- <or: "No standalone spec exists; this file is the primary reference.">

## Notes & gotchas

- **<Lead phrase>.** <The caveat, open issue, or invariant.>
```

### Folder taxonomy (6 domains)

Every doc lives in exactly one of six domain folders. Pick the folder by the
capability's **primary surface**, not by every file it touches.

| Folder | Holds | Pick it when the capability is primarily about… |
|---|---|---|
| `chat/` | The conversation substrate: threading, messages, runs, streaming, attachments, goal/autopilot | …the chat itself — conversations, the message tree, the send/stream pipeline |
| `composer/` | The message-input experience: the mention grammar, slash/feature/lesson expansion, the composer UI | …what happens *as the user types* a message, before it's sent |
| `orchestration/` | Multi-actor coordination: agents, teams, sub-conversations, loops, scheduling, cron | …agents/teams running work, or scheduled/recurring execution |
| `extensions/` | The extension ecosystem: the SDK, runtime/RPC, sandbox & isolation, permissions & grants, the bundled catalog, Pages Hub, entities | …the third-party extension system and its host boundary |
| `tools/` | Capabilities the LLM invokes: built-in file tools, web search, and other host-provided tools | …a tool the model calls during a turn |
| `platform/` | Cross-cutting infrastructure: projects, RBAC/permission modes, settings, audit/observability, API security, persistent memory, the remote-harness control plane | …instance-wide plumbing that isn't chat, composer, orchestration, extensions, or a tool |

Tie-breakers:
- A capability has **one** home even if it spans domains — choose by its
  primary noun. (Mention grammar is composer even though it feeds chat; the
  active-run IDOR is a chat concern even though it's a security issue.)
- If two folders feel equally right, prefer the **more specific** one and add a
  `[[slug]]` cross-link from the other domain's relevant doc.
- Do not invent a seventh folder. If nothing fits, it probably belongs inside an
  existing feature's doc, not a new one.

### The `[[slug]]` wiki-link system

Cross-links use `[[slug]]` where `slug` is the **target doc's filename without
`.md`** (e.g. `web-search.md` → `[[web-search]]`). Slugs are folder-agnostic —
`[[conversations]]` resolves regardless of which folder the linking doc lives in,
so slugs must be **globally unique** across all six folders. Links to deep specs
under `docs/*.md` use normal relative Markdown links (`[text](../../slug.md)`),
**not** `[[…]]` — reserve `[[…]]` for feature-to-feature edges.

## Usage

### Add a new feature doc

1. **Confirm it's a capability**, not a file/fixture/dead-code (see scope table).
2. **Pick the folder** from the taxonomy by primary surface.
3. **Choose a kebab-case slug** that is globally unique and matches the wiki-link
   target (`web-search`, `conversations`, `permissions-and-grants`). The filename
   is `<slug>.md`.
4. **Copy the skeleton** above into `docs/features/<folder>/<slug>.md`.
5. **Fill it grounded in code** — open the real source as you write; every path,
   symbol, route, env var, and settings key must exist (see Accuracy rules).
6. **Wire the graph**: add `[[…]]` links under *Features it touches*, and add a
   reciprocal `[[<new-slug>]]` link to each feature doc it relates to.
7. **Register it in the index**: add the entry to `docs/features/README.md`
   under the matching domain heading (`### chat`, `### tools`, …) as a
   `- [Title](folder/slug.md) — one-line summary.` line, matching the format of
   the surrounding entries.
8. **Link, don't duplicate**: under *Related docs*, link the deep spec in
   `docs/*.md` if one exists; otherwise state this doc is the primary reference.

### Update an existing doc when code changes

1. **Re-verify Key files** — renamed/moved/deleted files are the most common rot.
2. **Re-verify the Usage surface** — route paths, scopes, request fields, env
   vars, and settings keys drift fastest. Diff the doc's REST table against the
   actual `+server.ts` handlers.
3. **Re-verify behavior in How it works** — if the pipeline changed, renumber
   the steps; don't leave a stale step in place.
4. **Re-validate every `[[slug]]`** — a link to a renamed or deleted doc is a
   dead edge. Update both ends.
5. **Update Notes & gotchas honestly** — if a known issue was fixed, change
   `(OPEN)` to fixed (or remove it); if a new caveat appeared, add it.
6. **Ground every changed claim in source before committing** (see Accuracy).

### Where each kind of info goes (quick reference)

| Kind of info | Section it goes in |
|---|---|
| API route + scope | *Usage → REST API* table; the `+server.ts` also under *Key files* |
| Env var | *Usage → Env vars / settings* |
| Settings KV key | *Usage → Env vars / settings* |
| DB table / column | *How it works → Data model*; the schema file under *Key files* |
| UI route / component | *Usage → UI entry points*; the component under *Key files* |
| SDK call / method | *Usage* (snippet); the SDK module under *Key files* |
| Security caveat / open finding | *Notes & gotchas* (bold the lead, mark `(OPEN)`) |
| Related feature | *Features it touches* (`[[slug]]`) |
| Deep spec link | *Related docs* (relative Markdown link) |
| Non-obvious invariant | *Notes & gotchas* |

## Key files

- `docs/features/MAINTAINING.md` — this guide (the authoritative maintenance rules).
- `docs/features/chat/conversations.md` — canonical full-template example (rich pipeline + REST table + IDOR gotcha).
- `docs/features/tools/web-search.md` — canonical example (SDK usage, env/settings, stale-upstream-doc gotcha).
- `docs/features/platform/projects.md` — canonical example (two-concept disambiguation, containment asymmetry gotcha).
- `docs/features/README.md` — the grouped index of all feature docs (exists; every new doc must add its `- [Title](folder/slug.md) — summary.` entry under the right domain heading).
- `CLAUDE.md` — the binding **Development lifecycle**, **Remote testability contract**, and **Mention grammar** that feature docs must stay consistent with.
- `docs/development-lifecycle.md` — the full trunk-based lifecycle a doc-change PR follows.
- `docs/harness-contract.md` — the remote-testability spec referenced from any doc that adds an `/api/*` route.

## Features it touches

- [[conversations]] — the canonical template exemplar; mirror its section shape and gotcha style.
- [[web-search]] — exemplar for SDK + env/settings usage and the "upstream README is stale" gotcha pattern.
- [[projects]] — exemplar for disambiguating two same-named concepts and recording a containment asymmetry.
- [[mention-grammar]] — composer docs document the **five** real sigils (`! @ / $ %`); keep them in sync with CLAUDE.md's five-sigil table (see Notes).

(These `[[…]]` links resolve once the index lists their targets; the three
exemplar docs already exist.)

## Related docs

- [docs/development-lifecycle.md](../development-lifecycle.md) — trunk-based branch → PR → squash-merge flow a doc change follows.
- [docs/harness-contract.md](../harness-contract.md) — remote-testability contract; cite it whenever a feature doc covers a new route.
- [docs/slash-commands.md](../slash-commands.md), [docs/context-compaction.md](../context-compaction.md), [docs/extensions/data-storage.md](../extensions/data-storage.md) — examples of the deep specs feature docs should **link, not duplicate**.
- `CLAUDE.md` (repo root) — the project-instruction source of truth feature docs must not contradict.

## Notes & gotchas

- **Ground every claim in source before you commit — no exceptions.** Open the
  actual file and confirm the path, symbol, route, scope, env var, and settings
  key exist *as written*. Do not infer a path's existence from a naming pattern,
  and do not copy a claim from a prior doc without re-checking it — prior docs
  rot too. An invented `src/…` path or a non-existent route is the single most
  damaging error a feature doc can ship.

- **Paths are repo-relative, always.** Write `web/src/routes/api/conversations/+server.ts`,
  never an absolute `/home/...` path and never a bare filename. Relative
  Markdown links to deep specs are computed from the doc's folder depth
  (`docs/features/<folder>/x.md` → `../../slug.md`).

- **Record known gotchas and open issues honestly — these are live examples:**
  - **Active-run IDOR (OPEN).** `GET`/`POST /api/conversations/[id]/active-run`
    has no conversation-ownership check (SvelteKit doesn't wrap child
    `+server.ts` in a parent guard), so any authenticated user can poll another
    tenant's live `partialResponse` or cancel their run. Documented as OPEN in
    `chat/conversations.md` and `platform/projects.md`; keep it marked OPEN
    until the route actually gates ownership.
  - **Five sigils — keep CLAUDE.md and the composer docs in lockstep.**
    `web/src/lib/mention-logic.ts` defines **five** mention sigils (`!`, `@`,
    `/`, `$`, **`%`** for `lesson` / Lessons-Keeper), and the `!` sigil nests
    the `EZ` runtime-action kind (`![EZ:name]`). CLAUDE.md's "Mention grammar"
    table already lists all five rows plus the `EZ` kind; composer/chat docs
    (e.g. `conversations.md`, `mention-grammar.md`) must stay consistent with
    it. If the grammar changes in source, update CLAUDE.md, the composer docs,
    and this list together — don't let any of the three drift.
  - **Coverage of `docs/features/` is broad but never assume it's complete.**
    Absence of a doc does not mean absence of a feature — when in doubt, grep the
    code, not the doc set. (Two capabilities that once lacked docs are now
    covered: the **entities** feature lives in
    `extensions/data-and-entities.md`, and the **cron daemon** —
    `src/extensions/cron.ts` + `src/startup/background-timers.ts` — lives in
    `extensions/scheduling-and-loops.md`. Both landed in `extensions/`, a
    reminder to place a doc by its primary surface rather than a first guess.)

- **`docs/features/` is the map, `docs/*.md` is the territory.** The deep spec
  (e.g. `context-compaction.md`, `harness-contract.md`, `slash-commands.md`,
  `extensions/*`) is the single source of truth for a mechanism's full detail.
  A feature doc summarizes and **links** to it under *Related docs* — it must not
  re-derive the spec's full content, because two copies drift. When a feature
  has no deep spec, the feature doc *is* the primary reference and should say so.

- **Stay consistent with CLAUDE.md's binding contracts.** A doc that adds an
  `/api/*` route must note the **Remote testability contract** (register it in
  `src/api-registry.ts` with a scope); a doc covering a `/api/__test/**` route
  must note the fail-closed test-surface gate. Don't restate the whole contract
  — link `docs/harness-contract.md` — but never document a route in a way that
  contradicts it.

- **A doc change is still a lifecycle change.** Per CLAUDE.md's **Development
  lifecycle**, edits here go on a `docs/…` branch, through a PR with a non-author
  review, squash-merged to `main`. Docs-only changes don't trip the coverage
  gate, but they do need the review.

- **Keep the index (`README.md`) in sync.** `docs/features/README.md` is a
  grouped index (by the six folders) and already lists every existing doc under
  its domain heading as a `- [Title](folder/slug.md) — summary.` line. Every new
  doc MUST add such an entry under its domain heading. An entry that points at a
  renamed/deleted file is as much a rot bug as a dead `[[slug]]`.

- **One capability, one doc, one folder.** Resist splitting a capability across
  two files or duplicating a section into a sibling doc. If two docs would share
  a large block, that block is its own feature — extract it and `[[link]]` both.
