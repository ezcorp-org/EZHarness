# Attachments

> _Multi-modal file uploads for chat: capability-gated staging, server-side MIME-whitelist + magic-byte validation, on-disk storage under `.ezcorp/attachments/`, and per-model delivery into the LLM (native image, inlined text, PDF text-extract, or opaque `ez-attachment://` handles resolved at tool-call time)._

## Intent

Attachments let a user upload files alongside a chat message — images, text/code, PDFs, and extension-declared types — and have them delivered to the model in whatever shape the selected provider+model can actually consume. The model capability table is the single source of truth: it decides what's accepted, how big, and which **delivery strategy** bridges each kind into pi-ai (which natively carries only text and image parts). Storage, validation, and delivery are deliberately split into small modules under `src/chat/attachments/` so the upload path, the executor turn, and history rehydration all share the same rules. Files persist per-message in the project's `.ezcorp/` tree and are replayed into context across later turns so a chat can keep referring to an image or document it was shown earlier.

## How it works

### 1. Capabilities (the source of truth)

- `src/providers/model-capabilities.ts#getCapabilities(provider, modelId)` builds an `AttachmentCapabilities` from the resolved model: every model accepts inlined **text** (`text-inline`); image-input models add the **image** MIMEs (`native-image`); **PDF** is accepted on every model and always delivered via `pdf-text-extract` (pi-ai has no PDF content type, so extraction is universally safe); **audio** is wired only when an `OVERRIDES` row sets `audioNative` (none ship enabled — `audio-native` is Phase 2).
- `getCapabilitiesWithExtensions(provider, modelId, extensionMimes)` overlays MIMEs contributed by extensions wired to the conversation. Extension MIMEs use the `extension-handle-only` strategy, but **base capabilities win** — an extension declaring `application/pdf` does not downgrade core PDF handling.
- MIME whitelists are static: `IMAGE_MIMES`, `TEXT_MIMES`, `PDF_MIMES`, `AUDIO_MIMES`. Defaults: 20 MB/file, 10 files/message (Anthropic raises per-file to 32 MB).

### 2. Composer staging (client)

- `web/src/lib/components/ChatInput.svelte` holds `stagedFiles: File[]` and renders previews via `StagedAttachmentTray.svelte`.
- `web/src/lib/chat/attachment-client.ts` fetches `/api/models/capabilities` (cached per provider+model+conversation+pending-`!ext:` set) and gates staging client-side with `capabilityAcceptsFile` / `describeRejection`. This is **UX only** — the server re-validates everything.
- Pending `!ext:NAME` mentions in the draft are passed as `?extensions=` so a file for a not-yet-wired extension can be staged on the very first message.

### 3. Send + server validation pipeline

`POST /api/conversations/[id]/messages` (`web/src/routes/api/conversations/[id]/messages/+server.ts`) handles `multipart/form-data` (files under the `files` field; the client builds this in `web/src/lib/api.ts`). When `files.length > 0`:

1. Require `provider` + `model` (400 otherwise) and recompute `getCapabilitiesWithExtensions` server-side, unioning conversation-wired extension MIMEs with MIMEs from `!ext:` mentions parsed from the **literal** content.
2. Reject batches over `maxFilesPerMessage` (400 `TOO_MANY_FILES`).
3. **Pre-validate every file before writing anything** via `src/chat/attachments/validator.ts#validateAttachment` — size check, MIME-whitelist check, then either a `file-type` magic-byte sniff (binary) or a strict UTF-8 decode (text MIMEs, which `file-type` can't sniff). A single bad file rejects the whole batch (413 `TOO_LARGE`, else 400) — **no partial state**.
4. Persist the user message row, then for each file `writeAttachment` to disk and `insertAttachment` a `message_attachments` row. On any failure, best-effort rollback removes the disk files (`deleteForMessage`) and the rows. The `claimedMime` is canonicalized (strip `;charset=…`) before validation and storage.

### 4. Storage layout

`src/chat/attachments/storage.ts` writes under `<projectRoot>/.ezcorp/attachments/<conversationId>/<messageId>/<uuid>.<ext>` (mirroring the extension-data convention). Id segments are sanitized defensively even though they're DB UUIDs. The project root comes from the conversation's project (`project.path`).

### 5. Delivery into the LLM (current turn)

`src/runtime/stream-chat/build-prompt.ts` calls `src/chat/attachments/content-builder.ts#buildUserContent(text, attachments, caps)`, which dispatches per kind on `caps.deliveryFor[kind]`:

- **`native-image`** → base64 `ImageContent` part **plus** a trailing text block listing each image as an opaque `ez-attachment://<id>` handle (raw bytes are *not* duplicated into text). The block tells the model it may pass a handle verbatim to any tool that accepts image URIs.
- **`text-inline`** → UTF-8-decoded body wrapped in `<file name="…" type="…">…</file>`.
- **`pdf-text-extract`** → `src/chat/attachments/pdf-extract.ts#extractPdfText` (pdf-parse / pdfjs-dist, with `DOMMatrix`/`ImageData`/`Path2D` stubs for the headless Bun base) → text in the same `<file>` wrapper. Fails closed on encrypted/malformed PDFs.
- **`extension-handle-only`** → a `<file>` wrapper containing only the handle + MIME; **bytes are not read here** — the extension's own tools fetch them on demand.
- An unaccepted/unclassifiable attachment throws `UnsupportedAttachmentError` (the endpoint should have prevented it).

### 6. Handle resolution at tool-call time

`src/chat/attachments/handle-resolver.ts#buildAttachmentHandleResolver` is installed on each tool executor (`src/runtime/stream-chat/setup-tools.ts`, via `toolExec.setArgsResolver`). Before a tool runs, it recursively walks the call's args (strings, arrays, plain objects) and substitutes every `ez-attachment://<id>` it recognizes with a real `data:<mime>;base64,<bytes>` URI, caching bytes-per-id within the turn. Unknown ids are left verbatim so the tool's own validation surfaces the error (fail-closed). This keeps context tiny: the model cites short handles; bytes only materialize when a tool actually needs them.

### 7. History rehydration (across turns)

`src/chat/attachments/history-rehydrate.ts` + `src/runtime/stream-chat/load-history.ts` replay prior-turn media so the model still "sees" it later:

- **User uploads** — `loadPastAttachments` fetches every earlier user message's attachments; `rehydrateUserMessageContent` re-runs `buildUserContent` on each historical turn. On `UnsupportedAttachmentError` (e.g. the user switched to a text-only model) it falls back to the raw text rather than crashing. All past attachments are threaded into setup-tools so their handles still resolve.
- **Tool-generated images** — `load-history.ts#collectRehydratedImages` walks assistant turns newest→oldest, scanning **both** the assistant text *and* every anchored tool-call output for `![](…)` markdown URLs pointing at `/api/ext-files/<name>/<rest>` (`extractExtFilesUrls`), resolving each through `src/chat/attachments/ext-files-resolver.ts` (allowlist + **realpath** containment) via `statExtFilesImage`/`loadExtFilesImage`, and re-attaching bytes as `ImageContent` on the *next* user message (pi-ai `AssistantMessage` content can't carry images). Bounded by `MAX_REHYDRATED_IMAGES` (5) and `MAX_REHYDRATED_IMAGE_BYTES` (5 MB), deduped across turns by the resolved on-disk path. Best-effort: any URL that fails the checks is silently dropped, the URL text stays in context. (`rehydrateAssistantMessageContent` in `history-rehydrate.ts` is a standalone uncapped helper used by tests; the live budgeted walker is `collectRehydratedImages`.)

### 8. Serving + display

- `GET /api/attachments/[id]` streams the bytes after a fail-closed ownership check (owner or admin; admin cross-user reads are audit-logged). Default `Content-Disposition: inline`; `?download=1` forces a download with the original filename. `Cache-Control: private, …, immutable` (UUID-keyed paths never mutate).
- `web/src/lib/components/MessageAttachments.svelte` renders `AttachmentCard.svelte` per attachment: images open a lightbox, audio gets a player, everything else is an icon + filename + download link.

## Usage

### API routes

| Method & path | Scope | Purpose |
|---|---|---|
| `POST /api/conversations/[id]/messages` (`multipart/form-data`) | `chat` | Send with attachments. Files under the `files` form field; `provider`+`model` required when files present. Validates + persists, returns `userMessage` (with `attachments` summaries) + `runId`. |
| `GET /api/attachments/[id]` | `read` | Stream one attachment's bytes (ownership-gated). `?download=1` forces download. |
| `GET /api/models/capabilities?provider=&model=&conversationId=&extensions=` | `read` | The accepted-MIME list + size/count limits driving the picker. Delivery-strategy enum is **not** leaked to the client. |
| `GET /api/ext-files/[name]/[...path]` | `read` | Serve tool-generated artifacts (allowlisted extensions only); rendered in chat and rehydrated into history. |

### UI entry points

- Compose: stage files in the chat composer (`ChatInput.svelte` → `StagedAttachmentTray.svelte`), gated by `attachment-client.ts`.
- View: `MessageAttachments.svelte` / `AttachmentCard.svelte` under each message; images open the shared lightbox.

### Configuration

- Capabilities/limits are code-defined in `src/providers/model-capabilities.ts` (no env/settings knobs). Per-provider overrides live in the `OVERRIDES` table; the extension MIME overlay comes from `conversation_extensions`.
- `ext-files` rehydration is restricted to `ALLOWED_EXTENSIONS` in `src/chat/attachments/ext-files-resolver.ts` (currently `openai-image-gen-2`).

## Key files

- `src/providers/model-capabilities.ts` — capability table: accepted MIMEs, size/count limits, per-kind delivery strategy, extension MIME overlay.
- `src/chat/attachments/validator.ts` — `validateAttachment`: size + MIME-whitelist + `file-type` magic-byte sniff / UTF-8 decode.
- `src/chat/attachments/storage.ts` — disk layout under `.ezcorp/attachments/<conv>/<msg>/<uuid>.<ext>`; write/read/delete-by-message/delete-by-conversation.
- `src/chat/attachments/content-builder.ts` — `buildUserContent`: per-kind delivery to pi-ai parts; `ez-attachment://` handle scheme + `<file>` wrapper; `UnsupportedAttachmentError`.
- `src/chat/attachments/handle-resolver.ts` — `buildAttachmentHandleResolver`: substitutes `ez-attachment://<id>` → `data:` URI in tool-call args at dispatch.
- `src/chat/attachments/pdf-extract.ts` — `extractPdfText` via pdf-parse with headless-Bun global stubs; fails closed.
- `src/chat/attachments/history-rehydrate.ts` — `loadPastAttachments`, `rehydrateUserMessageContent`, plus the ext-files image helpers the live walker uses (`extractExtFilesUrls`, `statExtFilesImage`, `loadExtFilesImage`). `rehydrateAssistantMessageContent` here is a standalone uncapped helper exercised by tests, not the load-history budget path.
- `src/chat/attachments/ext-files-resolver.ts` — shared allowlist + **realpath** containment for `/api/ext-files/…` (used by the route and the rehydrator).
- `src/db/queries/attachments.ts` — `insertAttachment`, `getAttachment`, `listAttachmentsForMessage(s)`, delete-by-message/conversation.
- `src/db/schema.ts` — `message_attachments` table (dual cascade on message + conversation; `kind` enum; per-message/per-conversation indexes).
- `src/runtime/stream-chat/build-prompt.ts` — lifts current-turn attachments into the prompt's text + image parts.
- `src/runtime/stream-chat/setup-tools.ts` — installs the attachment-handle resolver on each tool executor (current + past attachments).
- `src/runtime/stream-chat/load-history.ts` — rehydrates past-turn user uploads (`rehydrateUserMessageContent`) + tool-generated images (`collectRehydratedImages`, the budgeted/deduped walker scanning assistant text + anchored tool outputs) into history; image budget caps.
- `web/src/routes/api/conversations/[id]/messages/+server.ts` — multipart parse + the validate→persist→rollback attachment pipeline.
- `web/src/routes/api/attachments/[id]/+server.ts` — ownership-gated byte streaming; admin-read audit; `inline`/`download` disposition.
- `web/src/routes/api/models/capabilities/+server.ts` — picker capabilities endpoint (extension MIME union).
- `web/src/routes/api/ext-files/[name]/[...path]/+server.ts` — serve allowlisted extension artifacts.
- `web/src/routes/api/conversations/[id]/+server.ts` — on conversation delete, GCs attachment files from disk (`deleteForConversation`).
- `web/src/lib/chat/attachment-client.ts` — client capability cache + staging gate (`capabilityAcceptsFile`, `describeRejection`).
- `web/src/lib/components/ChatInput.svelte` / `StagedAttachmentTray.svelte` — compose-time staging UI.
- `web/src/lib/components/MessageAttachments.svelte` / `AttachmentCard.svelte` / `attachment-card-logic.ts` — display cards + lightbox/download.

## Features it touches

- [[conversations]] — attachments ride on the `POST /messages` send pipeline; conversation delete GCs their files; rows cascade on conversation/message delete.
- [[streaming-runtime]] — `build-prompt` lifts attachments into the pi-ai prompt and `setup-tools` installs the handle resolver before the turn streams.
- [[providers-and-models]] — the per-model capability table decides what's accepted and how each kind is delivered.
- [[context-compaction]] — handles keep bytes out of context; history rehydration caps replayed images by count + total bytes.
- [[mention-grammar]] — `!ext:` mentions in the draft extend the accepted-MIME set for not-yet-wired extensions.
- [[ez-concierge-and-actions]] — extension tools consume `ez-attachment://` handles the resolver substitutes at dispatch.
- [[builtin-file-tools]] — `ext-files` containment uses realpath, unlike the lexical built-in file-tool path check (asymmetry worth noting).
- [[sandbox-and-isolation]] — extension-handle attachments only materialize bytes inside tool execution, never broadly in context.
- [[api-security]] — every route is `requireScope` + `requireAuth`; attachment serving is fail-closed ownership (owner-or-admin) with admin-read auditing.
- [[projects]] — files live under the active project's `.ezcorp/attachments/` tree; the project path resolves storage.
- [[message-toolbar]] / [[canvas-cards]] — display cards + lightbox surface attachments under each message.

## Related docs

None yet — this is the primary reference. (See [docs/extensions/data-storage.md](../../extensions/data-storage.md) for the `.ezcorp/` storage convention that the attachment layout mirrors, and [docs/context-compaction.md](../../context-compaction.md) for how rehydrated content competes for the input window.)

## Notes & gotchas

- **The picker is advisory; the server is authoritative.** `attachment-client.ts` gating is UX only — every file is re-validated server-side (size, MIME whitelist, magic-byte sniff / UTF-8 decode). Never trust the client accept-list as a security boundary.
- **Claimed MIME is untrusted.** Binary files must pass a `file-type` magic-byte sniff that matches the claimed type (`MIME_MISMATCH` otherwise); text MIMEs (unsniffable) must decode as strict UTF-8 (`NOT_UTF8` otherwise). The canonical sniffed MIME — not the upload's claim — is what gets stored.
- **All-or-nothing batches.** A single rejected file fails the whole send before any disk/DB write; persistence failures trigger best-effort rollback of files + rows. No partial attachment state.
- **PDFs are always text-extracted, even on "PDF-native" providers.** pi-ai has no PDF content type, so PDF is accepted on *every* model unconditionally and delivery is always `pdf-text-extract`. The `pdfNative` flag in the `OVERRIDES` rows is currently inert documentation — nothing reads it; the only override field those rows change is `maxBytesPerFile` (Anthropic → 32 MB). Extraction fails closed on encrypted/malformed PDFs (the turn errors rather than sending garbage).
- **Handles, not bytes, in context.** Images emit a short `ez-attachment://<id>` handle alongside the native image part; extension-handle kinds emit *only* the handle. Bytes materialize lazily in `handle-resolver.ts` at tool dispatch. Unknown handle ids are passed through verbatim (fail-closed at the tool's validation), not silently dropped.
- **Containment asymmetry.** The `ext-files` resolver re-asserts containment on **realpath** (a planted symlink can't escape the extension data root), whereas the built-in file-tool path check (`src/runtime/tools/validate.ts`) is lexical. Don't assume one model of containment applies everywhere.
- **`ext-files` is tightly allowlisted.** Only extensions in `ALLOWED_EXTENSIONS` (today: `openai-image-gen-2`) can serve artifacts or be rehydrated. Adding one exposes that extension's disk state to authenticated users *and* feeds its output bytes into the LLM on every later turn — review its output format first.
- **Rehydration is budgeted and best-effort.** Past tool-generated images are capped at 5 images / 5 MB total across the branch and deduped by resolved on-disk path (`collectRehydratedImages`); user-upload rehydration falls back to raw text if the current model can't accept the kind. Either way a bad/missing file can't crash a turn.
- **Cleanup spans the DB and disk.** DB rows cascade on message/conversation delete, but the on-disk files are GC'd manually — per-message on rollback (`deleteForMessage`) and per-conversation on conversation delete (`deleteForConversation`). A crash between row delete and disk delete can orphan files under `.ezcorp/attachments/`.
- **Admin cross-user reads are logged.** `GET /api/attachments/[id]` records an `attachment:admin_read` audit entry when an admin streams another user's file; owner self-reads and 404s are deliberately unlogged.
