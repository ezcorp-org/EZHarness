# Knowledge Base (RAG)

> _Project-scoped uploaded documents (≤10MB) that are chunked, locally embedded into a 384-dim pgvector index, and retrieved by cosine similarity for automatic injection into each chat turn (as an uncached block outside the cached system prefix)._

## Intent

The Knowledge Base lets a user attach reference documents to a project and have their contents surface automatically in chat, without copy-pasting. On upload a file is split into overlapping text chunks, each chunk is embedded with a local model, and the vectors are stored in Postgres (pgvector). On every chat turn, the user's message is embedded and the top-K most similar chunks for the active project are pulled into the prompt under a "## Knowledge Base" section. This is **distinct** from [[persistent-memory]] (auto-extracted facts about the user) and [[lessons]] (mention-expanded `%[lesson:…]` tokens): KB content is verbatim user-uploaded document text, retrieved by vector similarity, and rides the **same memory-injection code path** as memories.

## How it works

### Upload → process (async)

`POST /api/knowledge-base` (`web/src/routes/api/knowledge-base/+server.ts`):

1. **Auth + validation** — `requireScope(locals, "write")` then `requireAuth`. The body is `multipart/form-data` with `file` + `projectId`; `projectId` is validated as a UUID via `uploadKBFileSchema`.
2. **Quota** — `checkStorageQuota(user.id, "KnowledgeBase", currentCount)` enforces `maxKnowledgeBase` (default **100** files); over-quota → **429**.
3. **Gate checks** — extension whitelist via `isAllowedFile` (`src/memory/chunking.ts`'s `ALLOWED_EXTENSIONS`: `.txt .md .csv .json .yaml .yml .toml .ts .js .py .go .rs .html .xml .css .sh .sql .env .cfg .ini .log`) → 400; size > `MAX_FILE_SIZE` (10MB) → 400.
4. **Read text eagerly** — `await file.text()` runs **before** the response returns (the `File` handle would be gone otherwise).
5. **Insert file row** with `status: "processing"`, stamping `userId: user.id`. Returns `201 { id, status: "processing" }` immediately.
6. **Fire-and-forget processing** — an un-awaited async IIFE then: `chunkText(text)` → for each chunk `generateEmbedding(chunk.content)` → `insertKBChunk({ fileId, content, chunkIndex, embedding })` → `updateKBFile(fileId, { status: "ready", chunkCount })`. Any throw flips the row to `status: "error"`.

### Chunking (`src/memory/chunking.ts`)

`chunkText` is character-based (default `chunkSize = 512`, `overlap = 50`), **newline-aware**: when a chunk boundary lands mid-text it tries to break at the last `\n` after the 50% mark, so chunks tend to end on line boundaries. Adjacent chunks share `overlap` characters. Text ≤ `chunkSize` is a single chunk.

### Embedding (`src/memory/embeddings.ts`)

`generateEmbedding` runs a **local** Transformers.js feature-extraction pipeline — `Xenova/all-MiniLM-L6-v2` (`EMBEDDING_MODEL_ID = "Xenova/all-MiniLM-L6-v2@384"`), **384-dim** (`EMBEDDING_DIMENSIONS`), mean-pooled + L2-normalized. Input is truncated to `CHUNK_TOKENS` (256) tokens via `tokenizer.model_max_length` (the same budget as memory chunking — input-only, never touching output caps). No external embedding API is called.

### Storage (`src/db/queries/knowledge-base.ts`, pgvector)

- `knowledge_base_files` — one row per upload (`projectId`, `filename`, `mimeType`, `fileSize`, `chunkCount`, `status`, `userId`, `orgScoped`).
- `knowledge_base_chunks` — `fileId` (FK `ON DELETE CASCADE`), `content`, `chunkIndex`, `embedding vector(384)`. An **HNSW** index (`idx_kb_chunks_embedding USING hnsw (embedding vector_cosine_ops)`) backs cosine search; `idx_kb_chunks_file_id` backs cascade deletes.
- `insertKBChunk` uses **raw SQL** (`toVectorLiteral`) because Drizzle can't bind a `vector` literal; `searchKBChunks` likewise.

### Retrieval + injection (the memory path)

KB retrieval is wired **inside** the chat stream's parallel setup phase, not as a standalone tool:

1. `src/runtime/stream-chat/setup-tools.ts` runs a fast-path gate `hasKBChunks(projectId)` (alongside `hasMemories`) — if the project has **no** memories and **no** ready KB chunks, it skips embedding the query entirely.
2. The user message is embedded once (`generateEmbedding`), then reused for both the memory hybrid search and KB search.
3. `searchKBChunksForQuery` (`src/memory/retrieval.ts`) wraps `searchKBChunks(embedding, projectId, userId, 5)` — top-5 by cosine distance (`embedding <=> $vec`), filtered to `f.status = 'ready'`, the active `project_id`, and the files that `userId` may read (own + ownerless; see [Retrieval is user-scoped](#retrieval-is-user-scoped-and-follows-the-api)), joined back to `knowledge_base_files` for the `filename`.
4. `buildSystemPromptWithMemories` (`src/memory/injection.ts`) builds a `## Knowledge Base` block, prefixed with an instruction to cite sources as `[1]`, `[2]`. Each chunk renders as `[Source N: <filename>] <content>`. Memories and KB chunks **share one 2000-token budget** (`DEFAULT_TOKEN_BUDGET`); memories are greedily filled first, then KB chunks until the budget runs out. The raw block is returned as `injectionBlock`.

The injected block is **not** merged into `ctx.system` — `setup-tools.ts` stashes it on `ctx.systemMemoryTail`, and at payload time (`build-pi-agent.ts`) Anthropic requests carry it as a separate **trailing system block with no `cache_control`** (`src/runtime/stream-chat/system-cache-split.ts`), so the query-dependent recall varies per turn without busting the cached region-1 prefix (system + tools); other providers get it merged into the plain `systemPrompt` string. See [[context-compaction]] / [[streaming-runtime]] for how the prompt feeds the model.

### Sharing: `user_id IS NULL` means "shared with the project"

There is **one** way to share a KB file, and it is an ownerless row. A file whose
`user_id` is `NULL` is readable by **every authenticated caller**, on both read
surfaces, deliberately:

| Surface | Predicate | Ownerless row (`user_id IS NULL`) |
|---|---|---|
| `GET /api/knowledge-base` (list) | `files.filter(f => !f.userId \|\| f.userId === user.id)` | **included** for everyone |
| `GET /api/knowledge-base/[id]` (detail) | `if (file.userId && file.userId !== user.id) → 404` | **200** for everyone |
| `DELETE /api/knowledge-base/[id]` | `if (file.userId !== user.id && user.role !== "admin") → 404` | **admin-only** |

Read is shared; **write is not**. "Everyone may read it" is never widened into
"anyone may destroy it" — the DELETE gate is the fail-closed sec-H3 shape.

**List and detail are ONE contract.** The two read predicates must move together
or not at all: tightening detail alone yields a *list-but-404* (a file the user
sees and cannot open); tightening the list alone yields a file that is fetchable
by id but invisible. Both are annotated in-source with the anchor
`KB-SHARED-NULL-OWNER`, and
`src/__tests__/security/kb-ownerless-rows-are-shared.test.ts` asserts
list-visibility and detail-reachability agree row-for-row for every caller, so
they cannot drift apart.

Why `NULL` is read as *shared* and not *orphaned*:

1. **It can't happen by accident.** `POST /api/knowledge-base` always stamps
   `userId: user.id`, so no upload can mint an ownerless row. A row that is
   ownerless when it is read is a deliberate operator act, not drift.
2. **There is nothing else to say it with.** KB reads gate on per-file `userId`
   alone — neither read handler consults project membership — so a null owner
   *is* the sharing mechanism.
3. **Retrieval reads it the same way.** `searchKBChunks` scopes to
   `user_id IS NULL OR user_id = <caller>`, i.e. this exact predicate, so an
   ownerless file's chunks reach every member's chat turn and an owned file's
   chunks reach only its owner. See
   [Retrieval is user-scoped](#retrieval-is-user-scoped-and-follows-the-api).

**Sharing is durable.** It did not used to be. `src/db/migrate.ts` runs on
**every boot** (unversioned, idempotent-by-construction — `src/db/connection.ts`
calls `migrate()` on each open) and it used to re-run

```sql
UPDATE knowledge_base_files
   SET user_id = (SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1)
 WHERE user_id IS NULL;
```

with it, so a shared file was **adopted by the first admin at the next restart**
and silently stopped being shared. That adoption now lives in
`src/db/migrations/claim-ownerless-kb-files-once.ts` and fires **once, ever**,
guarded by a marker row in `settings` (`migration:kb-ownerless-claim-v1`). The
guard is a `NOT EXISTS` inside the `UPDATE`'s own `WHERE` — one statement, no
result-row inspection, so it behaves the same on PGlite and `Bun.sql`. The marker
is written only *after* the adoption succeeds, which is what makes it compose
with the migration circuit breaker in `src/db/connection.ts`: a boot that skips
`migrate()` (or a run that throws) leaves the work **pending**, never falsely
done. `src/__tests__/db-migration-claim-ownerless-kb-once.test.ts` replays real
boots against real PGlite to pin all of that.

The sibling backfills in `migrate.ts` (`conversations`, `memories`,
`agent_configs`) are deliberately left running every boot: none of them uses a
null owner to mean "shared", so their repetition costs nothing.

### Sharing is a product feature: `POST`/`DELETE /api/knowledge-base/[id]/share`

Ownerless rows used to be reachable only by an operator writing SQL. They are
now something a user creates, from the Knowledge Base tab, with one button.

The verb changes **exactly one thing**: `POST` sets `user_id = NULL`, `DELETE`
puts an owner back. No new access signal was introduced, so the list predicate,
the detail predicate and `visibleReadyFileIds` are **untouched** — they already
described these rows.

**Who may do what** (the rule and its full reasoning live in
`src/memory/kb-sharing.ts`; the route and the list route both call it, so the
button the UI offers and the action the server permits are one sentence):

| verb | who | why |
|---|---|---|
| `POST` (share) | the file's **current owner**, who is also a **member of its project** | it is their document; disclosure is theirs to make |
| `DELETE` (un-share) | the user who **shared** it, **or an instance admin** | de-escalation, and it returns the file to its original owner |

Three exclusions are deliberate:

1. **Other project members may not share your file.** Sharing decides whose
   chat turns a document is injected into; letting a member publish a document
   they do not own would re-open the confidentiality defect that scoping
   retrieval closed.
2. **Instance admins get no share override.** An admin cannot *read* another
   user's KB file (`GET [id]` 404s them, and retrieval gives them nothing), so
   an admin share would publish, to the whole project, a document the admin is
   not permitted to open and therefore cannot have reviewed. Admins keep the
   power they had — `DELETE` (sec-H3) — because destroying discloses nothing.
3. **A non-member owner may not share.** Neither read route checks membership,
   so an outsider who can name a `projectId` can upload to it; without this term
   they could then inject arbitrary text into every real member's prompt. The
   gate is `checkProjectRole(locals, file.projectId, "member")` over
   [[projects]]' `project_members`.

Un-share admits admins where share does not, and the asymmetry is the point: it
only ever *narrows* who can see a file, and it restores the file to `shared_by`
— **never to the actor** — so it cannot be used to take anything.

#### `shared_by`: provenance, and why a column was unavoidable

`user_id IS NULL` is still the only sharing *signal*. But nulling the owner
destroys the only record of whom the file came from, and un-sharing has to give
it back to someone. Without provenance the only implementable un-share is
"assign it to whoever clicked" — which is an **ownership takeover**: any member
could un-share a file someone else shared, become its sole reader and sole
deleter, and leave the real owner with a 404 on their own document.

So `knowledge_base_files.shared_by` (nullable, `ON DELETE SET NULL`) records the
sharer. It is read in exactly two places — to authorize un-share, and to render
"Shared by you" — and **never** by an access or retrieval predicate. If it were
wrong, sharing would behave identically; only un-sharing would be impossible.

Consequences worth knowing:

- **A shared file is admin-only to delete** (sec-H3, unchanged). The sharer's
  path is **Unshare → Delete**; both steps are authorized by `shared_by`.
- **Pre-existing ownerless rows are not backfilled** and so are un-shareable by
  anyone, admins included. They have no recoverable owner, and inventing one
  would repeat the un-sharing-by-restart mistake
  `claim-ownerless-kb-files-once.ts` exists to stop. Fail-closed.
- **A shared file counts against every member's quota**, since
  `checkStorageQuota` is fed the `!f.userId || f.userId === user.id` count.

### Retrieval is user-scoped, and follows the API

`searchKBChunks` / `hasKBChunks` (`src/db/queries/knowledge-base.ts`, anchor
`KB-RETRIEVAL-FOLLOWS-API`) narrow the project's `ready` files with

```sql
AND (f.user_id IS NULL OR f.user_id = <caller>)
```

— **your own rows plus ownerless (shared) rows, and nobody else's** — which is
character-for-character the rule the two read surfaces apply. `userId` is a
**required** positional argument on both functions and on the
`searchKBChunksForQuery` wrapper (`src/memory/retrieval.ts`), so a call site
cannot forget it the way an omitted optional could. The single production caller,
`src/runtime/stream-chat/setup-tools.ts`, passes the conversation owner
(`convRecord?.userId ?? null`) to both the fast-path existence check and the
search — the same value it already threads into the memory scope beside it.

A **null** actor (agent/CLI run, or a conversation with no owner) binds
`f.user_id = NULL`, which SQL never satisfies, so it degrades to the ownerless
subset: the rows any caller may read, never a superset.

This was a live confidentiality defect until it was fixed. Retrieval used to
filter on `project_id` + `status = 'ready'` **only**, so one member's uploaded
document was injected verbatim into *every* project member's chat turns while
those same members got a 404 from `GET /api/knowledge-base/[id]` for it — the API
asserted an ownership boundary the prompt ignored.
`src/__tests__/security/kb-retrieval-is-user-scoped.test.ts` now walks every
(caller × file) pair and asserts *injected-into-the-prompt === readable-through-
the-API*, with both sides executed against the same real database. Combined with
the `list === detail` equivalence in
`kb-ownerless-rows-are-shared.test.ts`, retrieval, list and detail are one closed
chain.

**Consequence, and it is intended:** a file owned by one member is no longer
retrieved for anybody else, even in a project they share. Teams who relied on
the old project-wide behaviour must share deliberately — an ownerless row — which
now survives restarts. Do **not** "restore" the old behaviour by widening this
predicate; widen the API's instead, and move all three together.

### Lifecycle UI feedback

`web/src/lib/components/KnowledgeBaseTab.svelte` polls `GET /api/knowledge-base?projectId=…` every 3s while any file is `processing`, then stops — so the chunk count / "ready" state appears without a manual refresh.

## Usage

### REST API

| Method & path | Scope | Purpose |
|---|---|---|
| `GET /api/knowledge-base?projectId=…` | `read` | List a project's KB files, filtered to the caller's own **plus every ownerless (shared) row** (`!f.userId \|\| f.userId === user.id`). `projectId` required. |
| `POST /api/knowledge-base` | `write` | Upload. `multipart/form-data`: `file` + `projectId`. 10MB cap, extension whitelist, quota-gated. Always stamps `userId: user.id`. Returns `201 { id, status: "processing" }`. |
| `GET /api/knowledge-base/[id]` | `read` | Fetch one file row. 404 if owned by someone else; **200 on an ownerless row** — same rule as the list. |
| `DELETE /api/knowledge-base/[id]` | `write` | Delete a file (cascades its chunks). 404 if not the owner **and** not an admin — ownerless rows are admin-only. 204 on success. |
| `POST /api/knowledge-base/[id]/share` | `write` | Share with the project (`user_id → NULL`, `shared_by → caller`). **Owner + project member only, no admin override.** 404 someone else's file / missing; 409 already shared or no project; 403 not a member. |
| `DELETE /api/knowledge-base/[id]/share` | `write` | Un-share, restoring the file to `shared_by` (never to the caller). **Sharer or instance admin.** 403 if shared by someone else or with no recorded sharer; 409 your own un-shared file; 404 someone else's un-shared file. |

The list route additionally returns, per row, the server-derived
`shared` / `sharedByYou` / `canShare` / `canUnshare` booleans
(`describeKBFileSharing`), which is what the UI draws its buttons from — the
client cannot re-derive the rule, since it knows neither the caller's id nor
their project membership.

> Note: the read pair (list + detail) treats `user_id IS NULL` as *shared*; the
> write pair (`POST`/`DELETE`) is fail-closed on the same rows. See
> [Sharing](#sharing-user_id-is-null-means-shared-with-the-project).

### UI entry point

- The **Memories** page (`web/src/routes/(app)/memories/+page.svelte`) has a **Knowledge Base** tab. It mounts `KnowledgeBaseTab.svelte`, which renders `FileUpload.svelte` (drag-drop / click) over the active project and a table of files with size / chunk count / status / **Share|Unshare** / delete (two-click confirm). A shared row carries a **Shared** (or **Shared by you**) pill; the Share/Unshare button appears only when the server said the action would succeed, so it is never a button that 403s. The tab requires an active project (`store.activeProjectId`) — note the store falls back to the `"global"` literal, so the "Select a project" state is reached only by an *empty* id, not a missing one.
- Retrieval is **automatic** — there is no chat tool, slash command, or `@`/`!` mention to invoke the KB; it is injected silently per turn when the project has ready chunks.

### Settings / env

- `global:memoryEnabled` (setting) — when `false`, `buildSystemPromptWithMemories` short-circuits and injects **nothing**, so KB injection is disabled along with memory injection (it is the same gate).
- `limits:maxKnowledgeBase` (setting, default 100) — per-resource file quota read by `checkStorageQuota`.
- The embedding model is downloaded/cached locally by Transformers.js on first use; no API key.

## Key files

- `web/src/routes/api/knowledge-base/+server.ts` — list (GET) + upload (POST): validation, quota, eager `file.text()`, fire-and-forget chunk+embed pipeline. Hosts the canonical `KB-SHARED-NULL-OWNER` rationale at the list filter.
- `web/src/routes/api/knowledge-base/[id]/+server.ts` — GET/DELETE one file. GET mirrors the list's shared-null-owner rule (404 only on someone else's file); DELETE is fail-closed with an admin-only escape hatch for ownerless rows.
- `web/src/routes/api/knowledge-base/[id]/share/+server.ts` — POST (share) / DELETE (un-share). Applies the rule from `src/memory/kb-sharing.ts`; the two mutations are guarded UPDATEs so a stale ownership check cannot publish a row.
- `src/memory/kb-sharing.ts` — the whole share/un-share rule as pure functions (`isKBFileShared`, `canShareKBFile`, `canUnshareKBFile`, `describeKBFileSharing`). One copy, called by BOTH the enforcing route and the advertising list route.
- `src/__tests__/security/kb-file-sharing-api.test.ts` — the route against real PGlite: every refusal, the two lost-race branches, and an *advertised === enforced* invariant over every (caller × file) pair with both sides executed.
- `src/__tests__/kb-sharing-rule.test.ts` — the rule in isolation, including the two properties (a non-owner can never share; un-share never makes the actor the owner).
- `web/src/lib/components/__tests__/KnowledgeBaseTab.sharing.component.test.ts` — the tab's sharing DOM, plus the mount-effect fetch-loop regression pin.
- `src/__tests__/security/kb-ownerless-rows-are-shared.test.ts` — pins list-visibility and detail-reachability as ONE invariant (per caller, per row) plus the read/write asymmetry; fails if either read side drifts.
- `src/__tests__/security/kb-retrieval-is-user-scoped.test.ts` — pins *injected-into-the-prompt === readable-through-the-API* for every (caller × file) pair, both sides executed against one real database; fails if retrieval is widened back to project-wide.
- `src/db/migrations/claim-ownerless-kb-files-once.ts` — the marker-guarded, one-shot adoption of ownerless KB rows to the first admin (replaces the every-boot reclaim that used to un-share files at restart). Replayed by `src/__tests__/db-migration-claim-ownerless-kb-once.test.ts`.
- `web/src/routes/api/knowledge-base/schema.ts` — `uploadKBFileSchema` (projectId UUID; file handled via formData).
- `src/db/queries/knowledge-base.ts` — `insertKBFile` / `updateKBFile` / `listKBFiles` / `getKBFile` / `deleteKBFile` / `insertKBChunk` (raw-SQL vector insert) / `searchKBChunks` (top-K cosine) / `hasKBChunks` (fast existence gate). Both readers share `visibleReadyFileIds`, which hosts the canonical `KB-RETRIEVAL-FOLLOWS-API` rationale.
- `src/memory/chunking.ts` — `chunkText` (512/50, newline-aware) + `isAllowedFile` / `ALLOWED_EXTENSIONS`.
- `src/memory/embeddings.ts` — local `Xenova/all-MiniLM-L6-v2` 384-dim embedder; `generateEmbedding`, `EMBEDDING_MODEL_ID`, token-cap enforcement.
- `src/memory/retrieval.ts` — `searchKBChunksForQuery` wrapper (also hosts memory `hybridSearch`).
- `src/memory/injection.ts` — `buildSystemPromptWithMemories`: shared memory+KB token budget, `## Knowledge Base` block with citation instruction; returns `kbSourcesUsed`.
- `src/memory/types.ts` — `KBChunkResult` (`id`, `content`, `chunkIndex`, `filename`, `fileId`, `similarity`); `EMBEDDING_DIMENSIONS = 384`.
- `src/runtime/stream-chat/setup-tools.ts` — wires the `hasKBChunks` gate → query embed → `searchKBChunksForQuery` → injection into the per-turn parallel setup.
- `src/db/schema.ts` — `knowledgeBaseFiles` / `knowledgeBaseChunks` tables + `KBFile`/`KBChunk` types.
- `src/db/migrate.ts` — `CREATE EXTENSION vector`, KB table DDL, HNSW cosine index, `user_id` column; calls the one-shot ownerless-row adoption (it does **not** inline the `UPDATE` any more).
- `web/src/lib/components/KnowledgeBaseTab.svelte` — file table + processing-status polling.
- `web/src/lib/components/FileUpload.svelte` — drag-drop / click upload, client-side extension + size pre-check.
- `web/src/lib/server/security/resource-quotas.ts` — `checkStorageQuota` + `maxKnowledgeBase` default.

## Features it touches

- [[persistent-memory]] — KB retrieval rides the exact same injection function (`buildSystemPromptWithMemories`), shares the embedder, the `hasMemories`/`hasKBChunks` fast-path gate, and one 2000-token budget.
- [[streaming-runtime]] — KB injection happens in `setup-tools.ts` during the per-turn parallel setup before the LLM call; the block rides `ctx.systemMemoryTail` into the payload.
- [[context-compaction]] — injected KB text is part of the input window; the shared 2000-token budget caps how much KB content lands in context, and the block is kept out of the cached system prefix (`system-cache-split.ts`).
- [[lessons]] — a sibling "Memories" page tab and a distinct retrieval mechanism (mention-expanded, not vector-retrieved); easy to conflate.
- [[attachments]] — also user-uploaded files, but per-message and capability-gated for the model, **not** chunked/embedded into a project-wide vector index.
- [[projects]] — KB files are project-scoped; `projectId` is required to list and upload.
- [[database-and-migrations]] — relies on the pgvector extension + HNSW index created in `migrate.ts`.
- [[api-security]] — every route is gated by `requireScope` (`read` for the two GETs, `write` for `POST`/`DELETE`) + `requireAuth`, then a per-file owner check in which `user_id IS NULL` reads as shared. Retrieval applies the same owner check, so the API boundary is not something the prompt can route around.

## Related docs

None yet — this is the primary reference. (See [conversations](conversations.md) for the chat substrate and [context-compaction](../../context-compaction.md) for how the injected prompt becomes the input window and why the KB block rides outside the cached system prefix.)

## Notes & gotchas

- **`kbSourcesUsed` is computed but never surfaced.** `buildSystemPromptWithMemories` returns a `kbSourcesUsed` array, and `ChatMessage.svelte` has a "sources used" popover that renders it (`{filename} [chunk N]`). But `setup-tools.ts` only assigns `injection.memoriesUsed` to `run.memoriesUsed` — `kbSourcesUsed` is **never** written to the run result, persisted, or streamed. The KB-source attribution UI is therefore effectively dead: the prop always arrives empty even when KB chunks were injected. (Memory attribution does flow, via `runs.result.output.memoriesUsed`.)
- **`org_scoped` is display-only.** The `knowledge_base_files.org_scoped` column and its purple "Org" badge in `KnowledgeBaseTab` exist, but the upload route never sets it `true`, and `searchKBChunks` never reads it (its scope is `project_id` + `status='ready'` + the per-user file predicate). There is no org-scoped ingestion or cross-project/org retrieval path today.
- **Ownerless rows are SHARED, deliberately — and list + detail are one contract.** `user_id IS NULL` is the knowledge base's only sharing mechanism, not an orphan marker; both read surfaces honour it and neither may be tightened alone (a *list-but-404* is the defect that creates). Full reasoning and the enforcing test are in [Sharing](#sharing-user_id-is-null-means-shared-with-the-project); the predicates carry the `KB-SHARED-NULL-OWNER` anchor in-source.
- **Ownership is per-file, not project-RBAC.** Access is checked as `!file.userId || file.userId === user.id` on reads. There is no project-membership gate on either READ route and **no admin read override** — a project collaborator who is not the uploader cannot see another user's KB files in the API, and neither can an admin. (Only `DELETE` has an admin escape hatch, for ownerless rows.) Membership is consulted in exactly one place: the **share** route, because that verb publishes into a project and so must know you are in it. A consequence worth noting: `GET`/`POST` do not check membership either, so an authenticated non-member who can name a `projectId` can list and upload to it — the share gate is what stops that becoming a prompt-injection path.
- **The KB tab used to fetch in an unbounded loop.** `fetchFiles` reads `files.length` synchronously (before its first `await`) to decide whether to show the spinner, which made `files` a dependency of the mount `$effect`; the same call then assigned a fresh `files` array, re-invalidating the effect. Measured at ~1800 `GET /api/knowledge-base` calls in four seconds, for as long as the tab was open. Fixed with `untrack` around the call and pinned by the last test in `KnowledgeBaseTab.sharing.component.test.ts` (which, without the fix, OOM-kills the vitest worker).
- **Retrieval is user-scoped, and it follows the API exactly.** `searchKBChunks` / `hasKBChunks` narrow to `user_id IS NULL OR user_id = <caller>` — own rows plus ownerless (shared) rows — the same predicate the two read surfaces apply, so what the model is fed matches what the caller could open. `userId` is a required argument at every level (`searchKBChunks`, `hasKBChunks`, `searchKBChunksForQuery`) and `setup-tools.ts` passes `convRecord?.userId ?? null`. This mirrors the memory path's `hybridSearch`. **It was not always so:** retrieval used to filter on `project_id` + `status='ready'` alone, injecting one member's upload into every member's chat turn while the API 404'd it — a live confidentiality defect, closed and pinned by `src/__tests__/security/kb-retrieval-is-user-scoped.test.ts`. The intended consequence: another member's owned file is no longer retrieved for you; share deliberately (ownerless row) instead.
- **Processing is fire-and-forget — restarts orphan in-flight files.** Chunk+embed runs in an un-awaited IIFE after the `201` returns. If the process restarts (or the first embedding-model download is slow) mid-processing, the row is stranded at `status='processing'` with no retry/resume; it never reaches `ready` or `error`, and the UI polls forever. There is no re-index or re-process endpoint.
- **Binary/unsupported content is whitelist-gated, not sniffed.** Eligibility is purely by file **extension** (`ALLOWED_EXTENSIONS`); content isn't inspected. A binary file renamed to `.txt` would be `file.text()`-decoded and embedded as garbage.
- **No de-dup / size budget on chunks.** Re-uploading the same file creates a second file row + a duplicate set of chunks (counted against the 100-file quota, not a chunk/byte quota). Retrieval can then return near-identical chunks from duplicate files.
- **Embedding model dim is locked at 384.** `generateEmbedding` throws if the model returns a non-384 vector, and the column is `vector(384)`. A model swap requires a coordinated dim change + re-embed; `EMBEDDING_MODEL_ID` is the single source of truth.
