# Feature Index ($ mentions)

> _A per-project registry of named "features" (a description + a curated file list) that the chat composer references via the `$[feature:name]` sigil; the server expands each token into a plain-text system note so the LLM knows which files to look at first._

## Intent

The Feature Index gives a project a first-class concept of a "feature" — a slug, a human-readable description, and a curated list of associated files. Instead of pasting file lists by hand each turn (or hoping the model finds the right files), a user types `$[feature:chat-attachments]` and the assistant receives a system note naming the description and the files to load first. The index is **hybrid-ownership**: a deterministic filesystem scanner auto-populates `agent`-sourced features, while users can hand-create features, rename them, and pin/unpin individual files — and rescans never clobber those user edits. This is the `$` member of the composer's five-sigil mention grammar (`!` `@` `/` `$` `%`).

## How it works

### Data model (two-table junction)

- **`features`** (`src/db/schema.ts`) — one row per feature: `id`, `projectId` (FK → `projects`, cascade), `name` (slug), `description`, `source ∈ {'user','agent'}`, `originPath` (the scanner-derived source dir, immutable across renames, `null` for hand-created rows), `createdAt`/`updatedAt`. Slug uniqueness is **per-project** — a `UNIQUE(project_id, name)` index declared in `migrate.ts` (not in the schema DSL) so PGlite and external Postgres both accept it.
- **`feature_files`** (`src/db/schema.ts`) — junction rows: `(featureId, relpath)` composite PK, plus `source ∈ {'user','scan'}` and `addedAt`. FK cascade drops every file row when the feature is deleted.

The two `source` columns are **load-bearing** for hybrid ownership (`src/db/queries/features.ts`):
- `features.source` — rescans only upsert `agent`-sourced rows; `user`-sourced (hand-created or user-renamed) feature rows are left untouched.
- `feature_files.source` — `replaceAgentFiles()` deletes/reinserts only `scan` rows; `user`-pinned files survive every scan.

### Composer → token (`$[feature:name]`)

`$` is registered in the shared mention module `web/src/lib/mention-logic.ts`: `MENTION_REGEX`'s fourth alternative is `\$\[(feature):(name)\]`, and the trigger logic maps the `$` sigil to `type: "feature"`. The autocomplete popover queries `GET /api/mentions/search?type=feature&projectId=…`, which calls `listFeatures(projectId)` and fuzzy-filters by the typed query (`web/src/routes/api/mentions/search/+server.ts`). Selecting a result inserts the structured token `$[feature:name]` into the composer.

### Server-side expansion (the data path)

Like `@[file:…]`, a `$[feature:…]` token is **persisted verbatim** in the user message; the LLM sees an extra prepended system note. Expansion happens in the build-prompt path:

1. `src/runtime/stream-chat/build-prompt.ts` runs `applyFeatureExpansion(userMessage, resolver)` (`src/runtime/mention-wiring.ts`) against the **original** `userMessage` in the same pass as `@[file:…]` resolution. Both are project-scoped and both **prepend** their note to the LLM-facing `text`.
2. The resolver is DB-backed: `getFeature(projectId, name)` (`src/db/queries/features.ts`) returns the feature's description + its files' relpaths, or `undefined` for an unknown / deleted feature (→ silent no-op).
3. `applyFeatureExpansion` walks tokens via a standalone `FEATURE_TOKEN_RE` (sourced from the shared `STRUCTURED_NAME_CHAR_CLASS` so it can never drift from the composer regex), dedupes by name in source order, and emits **one block per resolved feature**:
   ```
   **Feature: <name>**
   <description>. Look at and modify these files first when working on this feature:
   - src/foo.ts
   - src/bar.ts
   ```
   A feature with no files emits a description-only block (the "look at these files" sentence is omitted). Blocks are joined with `\n\n` and prepended to the prompt.
4. **No double-expansion** (design doc §4): files are emitted as **plain text** (`- src/foo.ts`), never as `@[file:…]` tokens. Any mention sigil that happens to appear inside a description or path stays literal. The whole pass is wrapped in `try/catch` — a missing feature or DB hiccup is non-fatal and never 500s the chat turn.

### Deterministic scanner (`POST .../features/scan`)

`scanFeatures(projectRoot)` (`src/runtime/scan/feature-scan.ts`) is a plain, sub-second FS walk — **no LLM calls**:

1. `realpath` the project root (handles symlinked checkouts).
2. Walk known source roots **in order**: `src/`, `web/src/`, `docs/extensions/examples/`, plus runtime-expanded `packages/*/src` and `packages/@scope/*/src`. Missing roots are silently skipped.
3. Each immediate child directory under a source root is a feature candidate; the slug is the directory basename.
4. **Slug-collision rule:** if a later root claims an already-taken slug, prefix it with the leading segment of its source root (`web/src/components` → `web-components` when `src/components` already took `components`). If even the prefixed slug collides, the candidate is dropped (a non-unique slug would fail the per-project `UNIQUE` constraint anyway).
5. Recursively collect every file under the candidate dir, **delegating filtering** to `listFilteredChildren` in the shared `src/runtime/fs/scan-fs.ts` module so the scanner and the `@[file:…]` autocomplete can never disagree on what counts as a project file. A per-dir cycle guard (`realpath` each descended dir into a `seen` set) terminates intra-project symlink loops.
6. Skip features with fewer than 2 files (single-file dirs are noise). Output is sorted by slug.

DoS caps bound the walk: `MAX_DEPTH = 16`, `MAX_FILES_PER_FEATURE = 5_000`, `MAX_TOTAL_FILES = 50_000` (shared global counter). When a cap is hit the offending list is truncated and the scan continues — a partial-but-useful result beats failing the whole scan.

### Rescan upsert (the hybrid-ownership invariant)

`POST /api/projects/[id]/features/scan` (`web/src/routes/api/projects/[id]/features/scan/+server.ts`) runs the scanner, then upserts results:

- Existing rows are indexed twice — by `originPath` (**matched first**, survives renames) and by `name` (back-compat fallback for legacy rows with a null `originPath`). A name-fallback hit is only accepted when the matched row has no `originPath` yet (avoids double-binding one row to two candidates).
- **New** candidate → `createFeature({source:'agent', originPath})` + `replaceAgentFiles`.
- Matched row with `source === 'user'` → only `replaceAgentFiles` refreshes the `scan` file slice; **name, description, and source are left untouched**.
- Matched `agent` row → refresh description if changed + `replaceAgentFiles`.
- Legacy name-matched rows get `originPath` **backfilled** so the next rescan uses the fast path and survives a future rename.
- Features that existed before but did **not** appear in this scan are **not deleted** (the dir may be temporarily moved, or the user pinned files there) — the user deletes the row explicitly.

### Source-flip policy (rename / edit protection)

`PATCH /api/projects/[id]/features/[featureId]` flips `features.source` from `'agent'` → `'user'` **only** on a name or description edit that *actually changes the value* (`web/src/routes/api/projects/[id]/features/[featureId]/+server.ts`). This is the mechanism that makes user-renamed features survive rescans. Critically:
- A **no-op** PATCH (re-asserting the current description) does **not** flip the source — this defends against the legacy `refreshFeatureFiles` round trip silently muting an agent feature from rescans (audit defect D4). The settings UI now uses the side-effect-free `GET .../[featureId]` for that fetch instead.
- A **file-only** PATCH (add/remove pins) keeps `source='agent'` — per-row `feature_files.source` already protects user pins, so a file pin does not promote the whole feature.
- The flip is enforced at the **endpoint**, never in `updateFeature` (which stays mechanical CRUD).

## Usage

### REST API (all under `/api/projects/[id]/features`)

| Method & path | Scope | Purpose |
|---|---|---|
| `GET /api/projects/[id]/features` | `read` | List every feature for the project with file counts (no file lists). |
| `POST /api/projects/[id]/features` | `chat` | Create a `source='user'` feature. Body: `name` (slug regex), optional `description`. **409** on slug collision. 201 echoes the row with `fileCount: 0`. |
| `POST /api/projects/[id]/features/scan` | `chat` | Synchronous FS walk → upsert `agent` rows. Returns the post-scan list. **400** if the project has no `path`. |
| `GET /api/projects/[id]/features/[featureId]` | `read` | Side-effect-free read of one feature with its full file list (drives the UI row-expand). |
| `PATCH /api/projects/[id]/features/[featureId]` | `chat` | Rename / edit description / `addFiles` / `removeFiles` (≥1 field, schema-refined). **409** on rename collision. Applies the source-flip policy. |
| `DELETE /api/projects/[id]/features/[featureId]` | `chat` | Delete the feature; FK cascade drops all `feature_files`. Returns `{ ok: true }`. |

Every endpoint requires an authenticated user (`requireAuth`) + scope (`requireScope`); mutating endpoints require `chat`, reads require `read`. PATCH/DELETE additionally scope the lookup to `(projectId, featureId)` so a caller with one project's id can't touch another project's feature by guessing its uuid.

### Boundary validation (`.../features/schema.ts`)

- **Slug** (`SLUG_RE`): `/^[a-z0-9_-]+$/i` — letters, numbers, hyphens, underscores (underscores allow scanner slugs like `web-__tests__`), ≤120 chars.
- **relpath** (`RELPATH_RE`): project-relative POSIX path — rejects a leading `/` and `..` **only as a path segment** (so `package..config.json` passes while `../foo`, `foo/../bar`, bare `..` are rejected — audit defect C7). `addFiles`/`removeFiles` are capped at 500 per request.

### UI entry point

The `FeatureIndex.svelte` component (`web/src/lib/components/FeatureIndex.svelte`) mounts on the per-project settings page (`web/src/routes/(app)/project/[id]/settings/+page.svelte`). It offers: a "Scan features" button, "+ New feature", inline name/description editing, row-expand to view files, per-file remove (`×`), and an "+ Add file" picker that **reuses the `@[file:…]` autocomplete** via `searchMentions(query, "path", projectId)` so it doesn't reinvent the symlink-escape filter. Errors surface as an inline banner (field-level Zod messages preferred over the generic top-level error).

### Composer

Type `$` in the chat composer to trigger the feature autocomplete (project-scoped). Selecting an entry inserts `$[feature:name]`; the raw token persists, and the LLM sees the expanded system note. There is **no env var or setting** gating feature expansion (unlike `EZCORP_SCAN_GLOBAL_COMMANDS` for slash commands) — it is always on when a `projectId` is present.

## Key files

- `src/db/schema.ts` — `features` + `feature_files` tables; the load-bearing `source` columns + `originPath`.
- `src/db/queries/features.ts` — CRUD + hybrid-ownership primitives: `listFeatures`, `getFeature`, `getFeatureById`, `getFeatureByOriginPath`, `createFeature`, `updateFeature`, `deleteFeature`, `replaceAgentFiles`, `addUserFile`, `removeFile`.
- `src/runtime/scan/feature-scan.ts` — deterministic FS scanner (`scanFeatures`, source roots, slug-collision rule, DoS caps).
- `src/runtime/fs/scan-fs.ts` — shared `listFilteredChildren` + `realpathInsideRoot` so the scanner and `@`-autocomplete never drift on filtering / symlink-escape.
- `src/runtime/mention-wiring.ts` — `applyFeatureExpansion` + `FEATURE_TOKEN_RE`; emits the per-feature system note (plain-text files, no double-expansion).
- `src/runtime/stream-chat/build-prompt.ts` — wires `applyFeatureExpansion` into the prompt with a `getFeature`-backed resolver, in the same pass as `@[file:…]`.
- `web/src/lib/mention-logic.ts` — `MENTION_REGEX` + trigger logic registering the `$` sigil / `feature` kind.
- `web/src/routes/api/mentions/search/+server.ts` — `type=feature` autocomplete branch (calls `listFeatures`, fuzzy-filters).
- `web/src/routes/api/projects/[id]/features/+server.ts` — list (GET) + create (POST).
- `web/src/routes/api/projects/[id]/features/scan/+server.ts` — synchronous scan → upsert.
- `web/src/routes/api/projects/[id]/features/[featureId]/+server.ts` — per-feature GET / PATCH / DELETE + source-flip policy.
- `web/src/routes/api/projects/[id]/features/schema.ts` — Zod slug + relpath validation.
- `web/src/lib/components/FeatureIndex.svelte` — settings-page UI (scan/create/edit/expand/pin).
- `docs/plans/2026-05-01-feature-index-design.md` — the design doc (data model, §4 no-double-expansion rule, §5 endpoint surface).

## Features it touches

- [[mention-grammar]] — `$` is one of the five composer sigils; it shares `mention-logic.ts`, `MENTION_REGEX`, and the `/api/mentions/search` endpoint.
- [[slash-commands]] — sibling literal expansion (`/[cmd:…]`); feature expansion follows the same "persist raw token, LLM sees substituted/prepended text, never re-parse" discipline.
- [[lessons]] — `%[lesson:…]` is the other build-prompt prepended-note expansion (it runs after feature expansion so lesson notes sit at the top).
- [[builtin-file-tools]] — feature file lists are emitted as plain-text paths the agent reads on demand via the file tools; `@[file:…]` resolution shares the same prompt pass.
- [[context-compaction]] — the prepended feature system note becomes part of the model input window the trimmer budgets.
- [[streaming-runtime]] — `build-prompt.ts` runs inside the stream-chat path; the expanded prompt feeds `executor.streamChat`.
- [[conversations]] — `$[feature:…]` tokens are typed in the chat composer and persisted on the message row.
- [[projects]] — features are project-scoped; `projectId` gates list/create/scan and the autocomplete.
- [[api-security]] — every route is gated by `requireAuth` + `requireScope`; per-feature lookups are project-scoped against uuid-guessing.

## Related docs

- [docs/plans/2026-05-01-feature-index-design.md](../../plans/2026-05-01-feature-index-design.md) — original design (problem, data model, §4 no-double-expansion, §5 endpoint surface, hybrid-ownership intent).
- [docs/features/composer/mention-grammar.md](./mention-grammar.md) — the five-sigil composer grammar that `$` belongs to.

## Notes & gotchas

- **No double-expansion.** Feature files are emitted as plain text (`- src/foo.ts`), never `@[file:…]` tokens. The expanded note is **not** re-parsed for any mention sigil — this is the design-doc §4 invariant that prevents indirect prompt-injection via a description / path. Keep it that way.
- **Unknown / deleted features are silent no-ops.** A `$[feature:gone]` token whose resolver returns `null` produces no system note and is left verbatim in the persisted message — mirroring `@[file:…]` for a missing file. The whole expansion pass is `try/catch`-wrapped and never 500s the chat turn.
- **`originPath` is the rename anchor.** Rescans match existing rows by `originPath` **first**, name second. A user-renamed `user`-sourced feature stays linked to its source dir (no duplicate row under the original slug). Legacy rows get `originPath` backfilled on first scan.
- **Source-flip is value-aware (audit defect D4).** Only a name/description edit that *changes the value* flips `agent` → `user`. A no-op PATCH (re-asserting the current value) does **not** flip — otherwise the row would be silently muted from future rescans. File-only PATCHes also keep `source='agent'`. The UI uses `GET .../[featureId]` (not a no-op PATCH) to fetch the file list.
- **`addFiles` does not verify the path exists on disk** (audit defect C8). A pinned path that's a typo (or a not-yet-created file) becomes a ghost entry in the system note; the LLM gets ENOENT on read — discoverable feedback, not silent corruption. No security impact: the path passed `RELPATH_RE` + `validatePath`-equivalent validation, and FS access happens through the agent's separately-authorized tool calls.
- **Scan-vs-autocomplete filter parity.** The scanner and `@`-autocomplete both go through `listFilteredChildren`/`realpathInsideRoot` in `src/runtime/fs/scan-fs.ts` (which uses **realpath** for symlink-escape confinement). Note the asymmetry elsewhere: the built-in file-tool path containment (`src/runtime/tools/validate.ts` `validatePath`) is **lexical** (no realpath) — the Feature Index FS surfaces use the stricter realpath check.
- **Scan never deletes stale rows.** Features that vanish from the FS between scans are kept (the dir may be temporarily moved); cleanup is an explicit user `DELETE`. Matches the design's "rescans never clobber user edits" intent.
- **`replaceAgentFiles` never touches user pins.** It deletes/reinserts only `feature_files` rows with `source='scan'`, and drops any scan relpath that collides with a user pin (the composite PK would otherwise abort the insert) — the user's pin wins.
- **Scan is synchronous + project-path-gated.** `POST .../scan` is sub-second (no LLM); it returns 400 if the project has no `path` configured. If scans ever become slow, the design defers async/streaming progress to a follow-up.
