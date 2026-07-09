# Knowledge Base (RAG)

> _Project-scoped uploaded documents (≤10MB) that are chunked, locally embedded into a 384-dim pgvector index, and retrieved by cosine similarity for automatic injection into each chat turn (as an uncached block outside the cached system prefix)._

## Intent

The Knowledge Base lets a user attach reference documents to a project and have their contents surface automatically in chat, without copy-pasting. On upload a file is split into overlapping text chunks, each chunk is embedded with a local model, and the vectors are stored in Postgres (pgvector). On every chat turn, the user's message is embedded and the top-K most similar chunks for the active project are pulled into the prompt under a "## Knowledge Base" section. This is **distinct** from [[persistent-memory]] (auto-extracted facts about the user) and [[lessons]] (mention-expanded `%[lesson:…]` tokens): KB content is verbatim user-uploaded document text, retrieved by vector similarity, and rides the **same memory-injection code path** as memories.

## How it works

### Upload → process (async)

`POST /api/knowledge-base` (`web/src/routes/api/knowledge-base/+server.ts`):

1. **Auth + validation** — `requireScope(locals, "read")` then `requireAuth`. The body is `multipart/form-data` with `file` + `projectId`; `projectId` is validated as a UUID via `uploadKBFileSchema`.
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
3. `searchKBChunksForQuery` (`src/memory/retrieval.ts`) wraps `searchKBChunks(embedding, projectId, 5)` — top-5 by cosine distance (`embedding <=> $vec`), filtered to `f.status = 'ready'` and the active `project_id`, joined back to `knowledge_base_files` for the `filename`.
4. `buildSystemPromptWithMemories` (`src/memory/injection.ts`) builds a `## Knowledge Base` block, prefixed with an instruction to cite sources as `[1]`, `[2]`. Each chunk renders as `[Source N: <filename>] <content>`. Memories and KB chunks **share one 2000-token budget** (`DEFAULT_TOKEN_BUDGET`); memories are greedily filled first, then KB chunks until the budget runs out. The raw block is returned as `injectionBlock`.

The injected block is **not** merged into `ctx.system` — `setup-tools.ts` stashes it on `ctx.systemMemoryTail`, and at payload time (`build-pi-agent.ts`) Anthropic requests carry it as a separate **trailing system block with no `cache_control`** (`src/runtime/stream-chat/system-cache-split.ts`), so the query-dependent recall varies per turn without busting the cached region-1 prefix (system + tools); other providers get it merged into the plain `systemPrompt` string. See [[context-compaction]] / [[streaming-runtime]] for how the prompt feeds the model.

### Lifecycle UI feedback

`web/src/lib/components/KnowledgeBaseTab.svelte` polls `GET /api/knowledge-base?projectId=…` every 3s while any file is `processing`, then stops — so the chunk count / "ready" state appears without a manual refresh.

## Usage

### REST API

| Method & path | Scope | Purpose |
|---|---|---|
| `GET /api/knowledge-base?projectId=…` | `read` | List a project's KB files, filtered to the caller's own (`!f.userId \|\| f.userId === user.id`). `projectId` required. |
| `POST /api/knowledge-base` | `read` | Upload. `multipart/form-data`: `file` + `projectId`. 10MB cap, extension whitelist, quota-gated. Returns `201 { id, status: "processing" }`. |
| `GET /api/knowledge-base/[id]` | `read` | Fetch one file row (404 if not the owner). |
| `DELETE /api/knowledge-base/[id]` | `read` | Delete a file (cascades its chunks). 404 if not the owner; 204 on success. |

> Note: the mutating routes (`POST`/`DELETE`) are gated by `requireScope(locals, "read")`, **not** a write scope — see gotchas.

### UI entry point

- The **Memories** page (`web/src/routes/(app)/memories/+page.svelte`) has a **Knowledge Base** tab. It mounts `KnowledgeBaseTab.svelte`, which renders `FileUpload.svelte` (drag-drop / click) over the active project and a table of files with size / chunk count / status / delete (two-click confirm). The tab requires an active project (`store.activeProjectId`).
- Retrieval is **automatic** — there is no chat tool, slash command, or `@`/`!` mention to invoke the KB; it is injected silently per turn when the project has ready chunks.

### Settings / env

- `global:memoryEnabled` (setting) — when `false`, `buildSystemPromptWithMemories` short-circuits and injects **nothing**, so KB injection is disabled along with memory injection (it is the same gate).
- `limits:maxKnowledgeBase` (setting, default 100) — per-resource file quota read by `checkStorageQuota`.
- The embedding model is downloaded/cached locally by Transformers.js on first use; no API key.

## Key files

- `web/src/routes/api/knowledge-base/+server.ts` — list (GET) + upload (POST): validation, quota, eager `file.text()`, fire-and-forget chunk+embed pipeline.
- `web/src/routes/api/knowledge-base/[id]/+server.ts` — GET/DELETE one file; per-file owner check (404 on mismatch).
- `web/src/routes/api/knowledge-base/schema.ts` — `uploadKBFileSchema` (projectId UUID; file handled via formData).
- `src/db/queries/knowledge-base.ts` — `insertKBFile` / `updateKBFile` / `listKBFiles` / `getKBFile` / `deleteKBFile` / `insertKBChunk` (raw-SQL vector insert) / `searchKBChunks` (top-K cosine) / `hasKBChunks` (fast existence gate).
- `src/memory/chunking.ts` — `chunkText` (512/50, newline-aware) + `isAllowedFile` / `ALLOWED_EXTENSIONS`.
- `src/memory/embeddings.ts` — local `Xenova/all-MiniLM-L6-v2` 384-dim embedder; `generateEmbedding`, `EMBEDDING_MODEL_ID`, token-cap enforcement.
- `src/memory/retrieval.ts` — `searchKBChunksForQuery` wrapper (also hosts memory `hybridSearch`).
- `src/memory/injection.ts` — `buildSystemPromptWithMemories`: shared memory+KB token budget, `## Knowledge Base` block with citation instruction; returns `kbSourcesUsed`.
- `src/memory/types.ts` — `KBChunkResult` (`id`, `content`, `chunkIndex`, `filename`, `fileId`, `similarity`); `EMBEDDING_DIMENSIONS = 384`.
- `src/runtime/stream-chat/setup-tools.ts` — wires the `hasKBChunks` gate → query embed → `searchKBChunksForQuery` → injection into the per-turn parallel setup.
- `src/db/schema.ts` — `knowledgeBaseFiles` / `knowledgeBaseChunks` tables + `KBFile`/`KBChunk` types.
- `src/db/migrate.ts` — `CREATE EXTENSION vector`, KB table DDL, HNSW cosine index, `user_id` backfill migration.
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
- [[api-security]] — every route is gated by `requireScope` + `requireAuth` with a per-file owner check.

## Related docs

None yet — this is the primary reference. (See [conversations](conversations.md) for the chat substrate and [context-compaction](../../context-compaction.md) for how the injected prompt becomes the input window and why the KB block rides outside the cached system prefix.)

## Notes & gotchas

- **`kbSourcesUsed` is computed but never surfaced.** `buildSystemPromptWithMemories` returns a `kbSourcesUsed` array, and `ChatMessage.svelte` has a "sources used" popover that renders it (`{filename} [chunk N]`). But `setup-tools.ts` only assigns `injection.memoriesUsed` to `run.memoriesUsed` — `kbSourcesUsed` is **never** written to the run result, persisted, or streamed. The KB-source attribution UI is therefore effectively dead: the prop always arrives empty even when KB chunks were injected. (Memory attribution does flow, via `runs.result.output.memoriesUsed`.)
- **`org_scoped` is display-only.** The `knowledge_base_files.org_scoped` column and its purple "Org" badge in `KnowledgeBaseTab` exist, but the upload route never sets it `true`, and `searchKBChunks` filters **only** by `project_id` (+ `status='ready'`). There is no org-scoped ingestion or cross-project/org retrieval path today.
- **Mutating routes use the `read` scope.** `POST` (upload) and `DELETE` both call `requireScope(locals, "read")`, not a write scope, so a `read`-scoped developer API key can mutate the KB. Likely an oversight relative to other chat routes that gate writes with a `chat` scope.
- **Ownership is per-file, not project-RBAC.** Access is checked as `!file.userId || file.userId === user.id` (legacy null-owner rows are visible to everyone; otherwise only the owner). There is **no** admin override and no project-membership gate — a project collaborator who is not the uploader cannot see another user's KB files, and admins get no special access on these routes.
- **Processing is fire-and-forget — restarts orphan in-flight files.** Chunk+embed runs in an un-awaited IIFE after the `201` returns. If the process restarts (or the first embedding-model download is slow) mid-processing, the row is stranded at `status='processing'` with no retry/resume; it never reaches `ready` or `error`, and the UI polls forever. There is no re-index or re-process endpoint.
- **Binary/unsupported content is whitelist-gated, not sniffed.** Eligibility is purely by file **extension** (`ALLOWED_EXTENSIONS`); content isn't inspected. A binary file renamed to `.txt` would be `file.text()`-decoded and embedded as garbage.
- **No de-dup / size budget on chunks.** Re-uploading the same file creates a second file row + a duplicate set of chunks (counted against the 100-file quota, not a chunk/byte quota). Retrieval can then return near-identical chunks from duplicate files.
- **Embedding model dim is locked at 384.** `generateEmbedding` throws if the model returns a non-384 vector, and the column is `vector(384)`. A model swap requires a coordinated dim change + re-embed; `EMBEDDING_MODEL_ID` is the single source of truth.
