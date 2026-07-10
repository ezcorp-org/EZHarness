# substack-pipeline

EZCorp extension that turns **one URL** into a polished, original
Substack-style article **plus a cover image**, with a bounded human
approve/revise loop.

Sibling to [`substack-pilot`](../substack-pilot) — that extension is
one-shot (summarize → compose → push a Substack draft). This one owns the
**staged + iterative** flow and **reuses** substack-pilot's proven URL
fetch + summarize logic instead of duplicating it. Output is **in chat
only**: no Substack credentials, no `substack-mcp`, no draft creation.

## What you get

Three deterministic tools the LLM sequences (per the bundled SKILL):

| Tool                      | Role-prompted stage(s)                                   |
| ------------------------- | -------------------------------------------------------- |
| `draft_substack_post`     | SUMMARIZER (reused via cross-ext) + WRITER               |
| `revise_substack_post`    | WRITER (prev draft + user feedback)                      |
| `finalize_substack_post`  | ILLUSTRATOR + IMAGE (cross-ext)                          |

State (summary, current draft, round count) is held in
**conversation-scoped extension storage** between tool calls — not
shuttled back through the LLM.

## Architecture

```
SKILL contract — LLM sequences; ask_user_question = platform's wired human turn:

user URL
  └─ draft_substack_post({url,styleNote?})       [subprocess]
        ├─ invoke substack-pilot__summarize_urls  (cross-ext; NOT requiresUserInput)
        ├─ WRITER (ctx.llm)                        → draft
        └─ Storage("conversation").set scratch
  └─ LLM shows draft → ask_user_question(Approve|Request changes)   [LLM → wired path]
        ├─ Approve         → finalize_substack_post()
        └─ Request changes → ask_user_question(free-text) → revise_substack_post({feedback})
                                ├─ Storage.get scratch
                                ├─ WRITER(prevDraft+feedback)        → newDraft
                                └─ Storage.set scratch  (loop ≤ 5 rounds)
  └─ finalize_substack_post()                     [subprocess]
        ├─ Storage.get scratch
        ├─ ILLUSTRATOR (ctx.llm)                   → image prompt
        ├─ invoke openai-image-gen-2__generate     (cross-ext; NOT requiresUserInput)
        └─ Storage.delete scratch → article + cover image (renders inline)
```

The four "agents" are deterministic role-prompted stages
(`lib/prompts.ts`): **summarizer** (reused from substack-pilot),
**writer**, **reviser** (= writer + feedback), **illustrator**. Only the
*sequencing of the human turn* is LLM-driven — forced by the host
limitation below.

## Host limitation (why the human turn is LLM-orchestrated)

The intuitive design — one tool that internally
`invoke()`s `ask-user__ask_user_question` for a self-contained
approve/revise loop — **does not work** with the current host:

- `src/extensions/tool-executor.ts:1697` — `handlePiInvoke` calls
  `executeToolCall` **without** the 6th `invocationMetadata` argument on
  the cross-ext path.
- `src/extensions/tool-executor.ts:1208` — `executeToolCall` only sets
  `_meta.invocationMetadata` from that (absent) arg, so a cross-ext
  invoked `ask_user_question` receives no `toolCallId`/`conversationId`
  and returns `"Error: missing tool-call context"`
  (`docs/extensions/examples/ask-user/index.ts:168`).
- `src/runtime/ask-user-registry.ts` (used by
  `web/.../api/ask-user/answer`) is populated **only** by the LLM-facing
  `wireAskUserToolForTurn` — so even a forged id could never be resolved
  by a real user click on the cross-ext path.

Therefore a `requiresUserInput` tool only works when **the LLM** calls it
through the wired path. `src/__tests__/substack-pipeline.integration.test.ts`
pins this with a regression test — if the host later threads
`invocationMetadata` on the invoke path, that test flips and signals the
design can be simplified back to a single tool.

`substack-pilot__summarize_urls` and `openai-image-gen-2__generate` are
**not** `requiresUserInput`, so cross-ext invoking those is fine (pattern
proven by [`code-review-delegator`](../code-review-delegator)).

## Permission contract

- `llm.providers` — WRITER + ILLUSTRATOR stages call `ctx.llm`.
- `storage` — conversation-scoped scratch state.
- `dependencies` — `substack-pilot`, `openai-image-gen-2`. **Not**
  `ask-user` (the LLM calls it; it is not a cross-ext dependency).
- No `network` (fetch happens inside substack-pilot's subprocess), no
  `shell`, no `env`.

## Tests

```bash
# unit (root bunfig scopes default `bun test`, so use --cwd)
bun test --cwd docs/extensions/examples/substack-pipeline
# integration (regression-pin + working cross-ext wiring)
bun test src/__tests__/substack-pipeline.integration.test.ts
# e2e (browser: ask-user card render → click → resume)
cd web && bunx playwright test substack-pipeline.spec.ts
```

Unit tests inject every seam (`_setLlmForTests`, `_setInvokeForTests`,
`_setStoreForTests`) — zero network / LLM / subprocess.

**E2E** (`web/e2e/substack-pipeline.spec.ts`) drives the real chat UI:
send → the LLM-called `ask_user_question` card renders in **running**
state → click "Approve" → POST `/api/ask-user/answer`
`{toolCallId,answer}` → `tool:complete` flips to answered → run resumes
to `finalize_substack_post`. Plus the "Request changes" → free-text
follow-up variant. Runtime events are injected with `emitSse` — the
runtime stream is SSE (`ws.ts` EventSource → `stores.svelte.ts`
`createWSClient`); the older `emitWs` WebSocket transport is dead for
the current app (this is why pre-existing `emitWs`-based streaming specs
like `task-card-actions.spec.ts` fail — a stale-spec issue unrelated to
this extension).

The platform card's own logic is additionally unit-covered by
`web/src/lib/components/tool-cards/AskUserQuestionCard.component.test.ts`
and the host flow by `src/__tests__/ask-user.e2e.test.ts`.

## Files

```
substack-pipeline/
├── ezcorp.config.ts                   — manifest (3 tools, llm+storage, deps)
├── index.ts                           — 3 JSON-RPC dispatchers
├── lib/
│   ├── pipeline.ts                    — draftPost / revisePost / finalizePost
│   ├── prompts.ts                     — WRITER/ILLUSTRATOR prompts + helpers
│   ├── invoke-helpers.ts              — summarizeUrl + generateCoverImage
│   └── scratch.ts                     — conversation-scoped state + seam
├── skills/substack-pipeline/SKILL.md  — LLM orchestration contract
├── index.test.ts                      — unit
└── README.md
```

## Out of scope (v1)

- Substack draft creation / `substack-mcp` / credentials.
- First-class editable agentConfigs (stages are role prompts).
- Canvas-card editor UI; cron triggers; multi-URL input.
