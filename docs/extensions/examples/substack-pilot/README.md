# substack-pilot

EZCorp extension that lets you define unlimited Substack **post types** (each with its own system prompt) and produce AI-drafted posts from URLs, on demand, in chat.

## What you get

- **Post-type CRUD in chat** — natural-language `create / list / get / update / delete`.
- **`summarize_urls`** — fetch each URL, extract the article text, return a short structured summary.
- **`generate_substack_draft`** — pick a post type, summarize URLs, compose the body using the type's system prompt, and create a draft via [substack-mcp](https://github.com/marcomoauro/substack-mcp).
- **Three default post types** seeded on first use: `weekly`, `monthly`, `ad-hoc`.
- **One bundled skill** (`substack-author`) that teaches the LLM the right tool-call order.

## Architecture

```
chat:  "Use the weekly post type, here are this week's links: <urls>"
  │
  ▼
LLM (sees the substack-author skill + tool list)
  │
  ├─ get_post_type({slug:"weekly"})            ── post-types.ts ─► Storage (user scope)
  ├─ generate_substack_draft({postTypeSlug, urls})
  │     ├─ summarize_urls       ── summarize.ts ─► fetch + ctx.llm
  │     ├─ compose body         ── summarize.ts ─► ctx.llm
  │     └─ substack-mcp.create_draft_post
  │            ── substack.ts ─► npx substack-mcp@latest (stdio MCP)
  ▼
draft appears in your Substack dashboard
```

### Why the in-extension MCP child process?

The manifest declares `mcpServers: [substack-api]` for transparency, but the EZCorp host registry only auto-launches `mcpServers` when an extension's `kind` is `"mcp"` — and `kind:"mcp"` extensions are not allowed to have an `entrypoint`. Since this extension has its own tools (CRUD + summarize + draft orchestration), we spawn `substack-mcp` from inside `lib/substack.ts` using `@modelcontextprotocol/sdk`'s stdio transport. The MCP child runs under the extension's process-level sandbox and inherits only the `SUBSTACK_*` env vars we explicitly pass.

## Setup

### 1. Install

```bash
ezcorp ext install ./docs/extensions/examples/substack-pilot
```

### 2. Configure Substack credentials

Open `/extensions/substack-pilot` in the EZCorp UI and fill in:

| Field                | Source                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| Publication URL      | `https://yourname.substack.com`                                                                              |
| Session token        | Per the [substack-mcp creator guide](https://implementing.substack.com/p/mcp-server-for-substack)            |
| User ID              | Numeric Substack user id (same guide)                                                                        |

These are passed only to the `substack-mcp` child process — they are never logged, never sent to the LLM, and never leave your local EZCorp instance.

### 3. Confirm in chat

Type `![ext:substack-pilot]` in the composer to wire the extension into the conversation, then:

> What Substack post types do I have?

The LLM calls `list_post_types`, which auto-seeds the three defaults if your storage is empty.

## Usage

### Generate the weekly draft from URLs

> `![ext:substack-pilot]` Use the **weekly** post type. Links:
> https://example.com/a
> https://example.com/b
> https://example.com/c

Behind the scenes:
1. `get_post_type({slug:"weekly"})` — reads the system prompt.
2. `generate_substack_draft({postTypeSlug:"weekly", urls:[…]})` — fetches each URL, summarizes, composes the body using the weekly system prompt, and creates the draft in Substack.
3. Reply: draft confirmation + 2-line preview.

### Create a new post type

> Create a new post type called **"Deep Dive"**, slug `deep-dive`, cadence monthly, system prompt: *"Write a long-form analytical piece, 1500-2500 words…"*

The LLM calls `create_post_type` with `{name, slug, systemPrompt, cadence}`.

### Edit an existing post type

> Make the weekly post type more conversational — add "use second-person voice and ask one question to the reader at the end of each link summary."

The LLM calls `update_post_type({slug:"weekly", patch:{systemPrompt:"<merged>"}})`.

### Delete

> Delete the ad-hoc post type, I never use it.

The skill instructs the LLM to read back the system prompt and ask for explicit confirmation before deleting.

## Tools reference

| Tool                       | Args                                                              | Returns                              |
| -------------------------- | ----------------------------------------------------------------- | ------------------------------------ |
| `list_post_types`          | —                                                                 | `{ postTypes: [{slug,name,cadence}] }` |
| `get_post_type`            | `{ slug }`                                                        | `{ name, slug, systemPrompt, … }`    |
| `create_post_type`         | `{ name, slug, systemPrompt, cadence?, defaults? }`               | created record                       |
| `update_post_type`         | `{ slug, patch }`                                                 | updated record                       |
| `delete_post_type`         | `{ slug }`                                                        | confirmation or NOT_FOUND error      |
| `summarize_urls`           | `{ urls: string[], maxWordsPerSummary?: number }`                 | `{ summaries: [{url,title,summary}] }` |
| `generate_substack_draft`  | `{ postTypeSlug, urls, titleOverride?, subtitleOverride? }`       | `{ ok, title, subtitle, mcpResponse, bodyPreview }` |

## Slug rules

- Lowercase alphanumerics and hyphens only: `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`
- 1–64 chars
- No leading/trailing hyphens
- Immutable once created (to rename, create a new one and delete the old)

## Running tests

The repo's root `bunfig.toml` scopes default `bun test` to `src/__tests__/`, so extension tests run with an explicit `--cwd`:

```bash
cd docs/extensions/examples/substack-pilot
bun test
```

Or from the repo root:

```bash
bun test --cwd docs/extensions/examples/substack-pilot
```

The test suite has zero external dependencies — fetch, LLM, and the substack-mcp caller are all injected via test seams (`_setStoreForTests`, `_setBackendsForTests`, `_setMcpCallerForTests`).

## Out of scope

- **Publishing** — `substack-mcp` exposes drafts only; you review and publish from Substack's UI.
- **Scheduled / cron triggers** — on-demand only. Revisit if usage shows it would help.
- **A canvas-card UI** — chat-driven CRUD is sufficient at v1; a card-based editor is a future iteration.

## Files

```
substack-pilot/
├── ezcorp.config.ts             — manifest
├── index.ts                     — JSON-RPC tool dispatcher
├── lib/
│   ├── post-types.ts            — CRUD over extensionStorage (user scope) + lazy seed loader
│   ├── summarize.ts             — fetch + LLM per-URL summarization
│   └── substack.ts              — generate_substack_draft + substack-mcp caller
├── skills/substack-author/
│   └── SKILL.md                 — LLM-facing usage guide
├── prompts/
│   ├── weekly.md                — default seeds, loaded lazily on first call
│   ├── monthly.md
│   └── ad-hoc.md
├── scripts/
│   ├── postinstall.ts           — emits setup hint, verifies seed files
│   └── preuninstall.ts          — preserves user data
└── tests/                       — unit + integration coverage
```
