# Feature Index — Design

**Date:** 2026-05-01
**Status:** Approved (brainstorm complete, implementation pending)

## Problem

Users want a way to tell the chat assistant "these are the files associated with feature X — look here first." Today there's no first-class concept of a "feature" in EZCorp; users must paste file lists by hand or hope the LLM finds the right files on its own.

## Goal

Introduce a project-scoped **Feature Index**:

- A DB-backed registry of features per project (name, description, associated files).
- A new mention sigil `$[feature:name]` in the chat composer (joining `!`, `@`, `/`).
- A "Scan features" action on the per-project settings page that auto-populates the index from the filesystem.
- Hybrid ownership: agent-discovered features and user-created features coexist; rescans never clobber user edits.

## Non-goals (deferred)

- LLM-driven feature discovery (proposed initially, dropped from MVP — directory-based heuristics get ~80% of the value).
- Async / streaming scan progress (deterministic scan is sub-second).
- Cross-cutting feature membership computed from the import graph.
- Auto-refresh on file changes.

## Section 1 — Data model & scope

Per-project, in DB. Lives on `/project/[id]/settings`, not global settings.

**`src/db/schema.ts` additions:**

```ts
features
  id           text PK (uuid)
  projectId    text FK → projects.id (cascade)
  name         text   // slug, unique per project
  description  text   // shown in UI; injected to LLM
  source       text   // 'user' | 'agent'
  createdAt    timestamp
  updatedAt    timestamp

featureFiles
  featureId    text FK → features.id (cascade)
  relpath      text   // project-relative
  source       text   // 'user' | 'scan'
  addedAt      timestamp
  PRIMARY KEY (featureId, relpath)
```

**Mention grammar update** — extend the table in `CLAUDE.md`:

| Sigil | Kind | Token | Source |
|---|---|---|---|
| `$` | `feature` | `$[feature:name]` | DB (`features` table, scoped to active project) |

`source` columns are load-bearing: rescans replace only `source='agent'` / `source='scan'` rows. User edits survive.

## Section 2 — Scan flow (deterministic)

Trigger: "Scan features" button on `/project/[id]/settings`.
Endpoint: `POST /api/projects/:id/features/scan`. Synchronous.

1. Walk the project FS under the active project root, respecting `.gitignore` and reusing the symlink-escape filter from `@[file:…]` resolution.
2. Group by feature root: each immediate child directory under known source roots (`src/`, `web/src/`, `packages/*/src/`, plus user-configured roots) becomes a feature candidate.
3. Slug = directory name. Description placeholder = `"Files under <relpath>"`. User can edit.
4. Persist: upsert `features` (`source='agent'`); replace agent-sourced `featureFiles` for each feature. User-created features and user-pinned files are untouched.

**Edge cases:**

- Files outside known source roots → skipped.
- Empty / single-file features → skipped (noise).
- Cross-cutting files → live in their own dir's feature; users add manual associations as needed.

LLM refinement is deferred. If demand surfaces, add a per-feature "Refine description" button that calls a single completion.

## Section 3 — Settings UI

Component: `web/src/lib/components/FeatureIndex.svelte`, mounted on `/project/[id]/settings`.

**Top bar:** `[ Scan features ]`, `[ + New feature ]`, search input.

**Table:** one row per feature.

| | Name | Description | Files | Source | Actions |
|---|---|---|---|---|---|
| ▶ | `chat-attachments` | Files under `src/chat/attachments` | 12 | agent | edit / delete |

Expanding a row reveals the file tree (recursive `<ul>`) with per-leaf:

- Relpath
- Badge: `scan` (auto) or `pin` (user)
- `×` to remove
- "Add file" picker (reuses the `@[file:…]` autocomplete) at the bottom

**Edits:**

- Inline name + description editing → `PATCH /api/projects/:id/features/:featureId`.
- Renaming an agent-sourced feature flips `source` to `'user'` so rescans don't clobber.
- Delete prompts confirmation; FK cascades `featureFiles`.

Empty state: prompts the user to scan or create manually.

## Section 4 — Chat-side wiring

**Composer picker** (`web/src/lib/mention-logic.ts`):

- Add `$` to the sigil regex; add `feature` to the kind union.
- Token format: `$[feature:name]`. Stored verbatim in `messages.content` like other mentions.

**Search endpoint** (`web/src/routes/api/mentions/search/+server.ts`):

- New branch on `type=feature`: queries the active project's `features` table; returns `{ name, description, fileCount }`.

**Server-side expansion** (`src/runtime/stream-chat/build-prompt.ts` + new `applyFeatureExpansion` in `src/runtime/mention-wiring.ts`):

For each `$[feature:<name>]` in the user message, prepend a system note:

> **Feature: `chat-attachments`**
> Files under `src/chat/attachments`. Look at and modify these files first when working on this feature:
> - `src/chat/attachments/content-builder.ts`
> - `web/src/lib/chat/attachment-client.ts`
> - …

The raw `$[feature:…]` token stays in user-visible text; the LLM sees substituted system note + original message. Files are listed as plain text (not as `@[file:…]` tokens) — the LLM can `@`-read on demand. No double-expansion.

**Unknown / deleted feature:** silent no-op, mirroring `@[file:…]` pointing at a deleted file.

## Section 5 — File-by-file change list

**Backend (`src/`):**

- `src/db/schema.ts` — add `features` + `featureFiles` tables.
- `src/db/migrations/add-feature-index.ts` *(new)* — migration following existing pattern.
- `src/db/queries/features.ts` *(new)* — `listFeatures`, `getFeature`, `createFeature`, `updateFeature`, `deleteFeature`, `replaceAgentFiles`.
- `src/runtime/mention-wiring.ts` — add `applyFeatureExpansion` parallel to `applyCommandExpansion`.
- `src/runtime/stream-chat/build-prompt.ts` — call `applyFeatureExpansion` in the same pass that handles `@[file:…]`.
- `src/runtime/scan/feature-scan.ts` *(new)* — deterministic FS walker.

**Frontend (`web/`):**

- `web/src/lib/mention-logic.ts` — add `$` sigil + `feature` kind.
- `web/src/routes/api/mentions/search/+server.ts` — handle `type=feature`.
- `web/src/routes/api/projects/[id]/features/+server.ts` *(new)* — `GET` (list) + `POST` (create).
- `web/src/routes/api/projects/[id]/features/[featureId]/+server.ts` *(new)* — `PATCH` + `DELETE`.
- `web/src/routes/api/projects/[id]/features/scan/+server.ts` *(new)* — `POST` triggers scan.
- `web/src/lib/components/FeatureIndex.svelte` *(new)* — table + file tree + edit affordances.
- `web/src/routes/(app)/project/[id]/settings/+page.svelte` — mount `<FeatureIndex>`.

## Test plan

**Unit (`bun test`):**

- `src/__tests__/feature-scan.test.ts` — fixture project tree → asserts grouping, slug names, skip rules.
- `src/__tests__/mention-wiring-feature.test.ts` — `$[feature:x]` → system-note text; unknown feature silent no-op; no re-parsing of expanded text.
- `src/__tests__/db-features-queries.test.ts` — CRUD + `replaceAgentFiles` preserves `source='user'` rows.

**Integration:**

- `src/__tests__/build-prompt-feature.test.ts` — full pipeline: user message with `$[feature:…]` → final prompt has the right system note prepended.
- `web/src/lib/chat/__tests__/mention-logic-feature.test.ts` — sigil regex picks up `$`, no conflict with `!`/`@`/`/`.

**E2E (Playwright):**

- `web/e2e/feature-index-scan.spec.ts` — settings → Scan → table populated → expand → file tree → rename → rescan → rename survived.
- `web/e2e/feature-mention-injection.spec.ts` — type `$chat`, pick from dropdown, send → assert assistant turn was prompted with the file list.

## Open questions / risks

- **`.gitignore` parsing:** the existing `@[file:…]` resolver reads `.gitignore`; we'll reuse that helper. If it doesn't already handle nested ignores, that gap surfaces here too.
- **Slug collisions:** two top-level dirs named the same in different roots (e.g. `src/components/` and `web/src/components/`). Mitigation: prefix with parent root segment when collision detected (`web-components` vs `src-components`).
- **PGlite vs external Postgres:** schema must work on both. The existing schema already uses `pgTable` and the migrations target both, so following that pattern is fine.
- **CLAUDE.md mention-grammar table:** must be updated atomically with the sigil regex change to keep docs honest.
