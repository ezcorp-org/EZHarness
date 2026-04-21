# Auto Note Classification Guide

You are classifying short captures into one of six categories. Always pick the single best fit and call `capture` with `category`, `title`, and `tags` set. If you do not pass those, the extension falls back to a naive keyword matcher that drops most inputs into `ideas/` — that is the failure mode this guide exists to prevent.

## The six categories

### `references`
Topics to **learn about** — docs, papers, links, subject areas, curiosities. Any capture that says "read more about X" / "look into Y" / "what is Z" is a reference.

- `"learn more about cows"` → references, tags: [cows, animals, biology]
- `"PostgreSQL MVCC internals"` → references, tags: [postgres, database, mvcc]
- `"https://arxiv.org/abs/2305.12345 — paper on RAG eval"` → references, tags: [rag, evaluation, paper]
- **Not a reference**: `"I should actually read that paper by Friday"` — that has a deadline, it's a **task**.

### `ideas`
**New** thoughts you want to propose or explore — feature concepts, product ideas, brainstorms, open questions. "What if…", "we could…", "imagine if…".

- `"what if we added dark mode to the dashboard"` → ideas, tags: [dark-mode, ui, dashboard]
- `"brainstorm: gamify the onboarding checklist"` → ideas, tags: [onboarding, gamification]
- `"random thought — pricing tiers by seat type"` → ideas, tags: [pricing, tiers]
- **Not an idea**: `"decided we're using dark mode"` — that's a **decision**.

### `tasks`
**Actionable** items with an implied verb and/or deadline. Something the user intends to DO.

- `"deploy the staging fix tonight"` → tasks, tags: [deploy, staging, fix]
- `"fix the login timeout bug before demo"` → tasks, tags: [bug, login, demo]
- `"TODO: migrate the analytics pipeline"` → tasks, tags: [migration, analytics]
- **Not a task**: `"we should probably migrate analytics someday"` — vague with no commitment; better as an **idea**.

### `decisions`
A **choice** that's been made (or is being weighed) with rationale or trade-offs. Past-tense commitments or ongoing deliberations.

- `"going with Postgres over MongoDB — we need transactions"` → decisions, tags: [postgres, mongodb, database]
- `"decided to sunset the v1 API after Q3"` → decisions, tags: [api, v1, sunset, q3]
- `"thinking about switching CI from CircleCI to GitHub Actions"` → decisions (weighing a trade-off), tags: [ci, circleci, github-actions]
- **Not a decision**: `"what if we used GitHub Actions?"` — that's an **idea**, no weighing happening yet.

### `journal`
**First-person observations** from a specific time — daily logs, reflections, what happened today. Usually past tense and personal.

- `"today I noticed users bouncing on the pricing page"` → journal, tags: [pricing, analytics, observation]
- `"reflection: the sprint went better than last time because we scoped smaller"` → journal, tags: [sprint, retrospective]
- `"this morning the deploy failed twice — tired"` → journal, tags: [deploy, incident]
- **Not journal**: `"users bounce on pricing page"` — that's a bare observation; classify as **references** (data/fact) or **ideas** (if proposing a fix).

### `meetings`
Notes from a **meeting** — attendees, discussion, action items surfaced during a conversation.

- `"Meeting with @alice @bob — decided to hire two more SDEs, rework onboarding in Q3"` → meetings, tags: [hiring, onboarding, q3]
- `"Standup: blocked on the auth review"` → meetings, tags: [standup, auth, blocked]
- `"Retro action items: ship smaller PRs, add CI latency alarms"` → meetings, tags: [retro, ci, process]
- **Not a meeting**: A 1-person thought about a meeting topic — if there's no "meeting happened" context, classify by the content itself.

## Tagging

Produce **3-5 tags**. Rules:
- lowercase kebab-case (`oauth2`, `github-actions`, `dark-mode`)
- nouns preferred over verbs
- include **one broad topic** (`auth`, `frontend`, `animals`, `hiring`) and **1-2 specific terms**
- don't repeat the title back as tags
- don't include stopwords (`the`, `and`, `to`, etc.)

## Title

- `<=60 chars`
- declarative
- strip filler: "we should", "I want to", "thinking about"
- for references: make it noun-first ("Learn more about cows", not "About cows")

## Worked example — the motivating case

Input: `learn more about cows`

Classification:
- **Category**: `references` (topic to learn about; not an idea, not a task)
- **Title**: `Learn more about cows` (already good)
- **Tags**: `[cows, animals, biology, learning]` (broad + specific)

Tool call:
```
capture(
  text="learn more about cows",
  category="references",
  title="Learn more about cows",
  tags=["cows","animals","biology","learning"],
  mode="yolo"
)
```

Result: file created at `references/learn-more-about-cows.md`, NOT `ideas/`.
