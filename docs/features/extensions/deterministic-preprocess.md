# Deterministic Extension Pre-processing

> _When a user message carries attachments and a wired extension declares a `preprocessors` entry, the host runs the declared tool deterministically — no LLM decision — on each matching attachment BEFORE the assistant turn. The result persists as a `preprocess-result` message row (a tool card in the transcript) and grounds the LLM's reply via a system note. Generic surface: any extension can declare preprocessors; `graded-card-scanner`'s `identify_slab` is the first consumer._

## Intent

Some attachment workloads should never depend on the model choosing to call a tool: a slab photo attached to "what is this worth?" must ALWAYS be decoded, looked up, and charted — deterministically, before the reply streams. Attachment handles (`ez-attachment://<id>`) already resolve to `data:<mime>;base64,` URIs at tool dispatch; the only missing piece was a deterministic trigger. This surface adds that trigger with zero new permission axes and the existing tool-dispatch path end to end.

## Manifest surface

Optional top-level field, schemaVersion 2 AND 3:

```ts
preprocessors: [
  {
    tool: "identify_slab",              // MUST name a tool in this manifest's tools[]
    accepts: ["image/png", "image/jpeg"], // exact MIMEs or `type/*` globs; non-empty
    description: "Identify a graded-card slab photo.", // optional
  },
],
```

Validated at admit time by `validatePreprocessorsArray` (`src/extensions/manifest.ts`): a `tool` not declared in `tools[]` or a malformed `accepts` entry is a manifest error. `migrateManifestV2ToV3` passes the field through untouched. **No new permission axis** — the referenced tool runs under the extension's existing granted permissions and the `PermissionEngine` still gates inside `executeToolCall`.

## How it works

Runner: `src/runtime/stream-chat/preprocess.ts`; wiring: `src/runtime/stream-chat/setup-tools.ts` (2c block).

1. **Trigger** — in the executor's stream-chat setup, immediately AFTER `wireMentionedExtensions(...)`, so a same-message `![ext:…]` mention + attachment triggers in one turn. Runs to completion BEFORE the prompt is finalized (setupTools resolves before `buildPromptInput`).
2. **Matching** — for each extension wired to the conversation that declares preprocessors × each attachment on THIS user message whose MIME matches `accepts`. One invocation per (extension, preprocessor, attachment). Deterministic order: extensions by name asc, attachments by created order. Caps: max **4** invocations per turn (extras dropped, logged once); attachments over **8 MB** are skipped (logged once).
3. **Dispatch** — the host invokes the tool with input `{ attachment: "ez-attachment://<id>", filename, mimeType }` through the SAME per-turn `ToolExecutor` LLM tool calls use: the args resolver substitutes the handle for a data URI, `setCurrentUserId(<conversation owner>)` provides the acting user (same semantics as `/api/tool-invoke`), and the extension's `resources.callTimeoutMs` bounds the call. Because dispatch shares `executeToolCall`, each preprocess invocation also **consumes the turn's tool-call budget** (`MAX_TOOL_CALLS_PER_TURN`, default 100) — up to the 4-invocation cap per turn.
4. **Persistence** — one synthetic `messages` row per invocation, `role: "preprocess-result"`, `excluded: false`, `content` = JSON `{ extensionName, toolName, cardType?, ok, output }`. Rows CHAIN into the branch (user → preprocess-result… → assistant) so the transcript path renders them; the assistant turn re-parents onto the last row (`ctx.lastSavedMessageId` / `ctx.turnParentMessageId`). `messages.role` is free-form text — no migration.
5. **LLM grounding** — for the CURRENT turn only, each successful result appends a system note: `[Deterministic preprocess <ext>:<tool> on <filename>]\n<output truncated to 4 KB>`. Failures produce NO note — the ok:false card carries the error. History replay is blocked at the source: `load-history.ts` strips `role === "preprocess-result"` exactly like `ez-action-result`.
6. **Failure isolation** — a throwing/timeout preprocessor (or a failed row persist) never blocks or fails the turn: the ok:false card persists and the turn proceeds.

## Rendering

- `ChatMessage.svelte` branches on `role === "preprocess-result"`: the row parses via `preprocess-result-logic.ts` into a synthetic `ToolCallState` and routes through `ToolCardRouter` by `cardType`. Unknown/absent cardType → `DefaultCard`; `ok:false` synthesizes status `error` with no cardType, so DefaultCard renders the honest error state; malformed rows fall back to a minimal "Preprocess result unreadable." pill.
- `cardType: "grade-delta-chart"` → `GradeDeltaCard.svelte`: grader badge + cert + identity title, an inline-SVG grouped bar chart (one group per grading company, one bar per adjacent-grade step, height = |pct|, `PSA 9→10 +1063.3%` labels), and a price-per-grade table. Companies with fewer than two priced grades are omitted from the chart but always listed in the table; missing prices render "N/A" (never $0).

## First consumer: graded-card-scanner `identify_slab`

Declared with `accepts: ["image/png","image/jpeg"]` and `cardType: "grade-delta-chart"`. Pipeline (`docs/extensions/examples/graded-card-scanner/lib/identify.ts`):

- **Decode** (`lib/decode.ts`) — host-side zxing (`@zxing/library` MultiFormatReader + HybridBinarizer over pngjs / jpeg-js pixels), walking the phone app's proven band-ladder + quiet-zone tile-grid geometry (`app/lib/decode-plan.js`, shared). Formats: ITF (PSA front label), QR (modern slab backs), Code 128.
- **Classify** (`lib/classify.ts`) — `psacard.com/cert/<n>` URL or bare 5-10 digits ⇒ PSA; `cgccards.com`/`cgccomics.com` cert URL ⇒ CGC; `beckett.com` ⇒ BGS; `gosgc.com`/`sgccard.com` ⇒ SGC; else `grader: "unknown"` with honest nulls.
- **Identity** — PSA via the official API (token optional → nulls); CGC via the public cert page (`lib/sources/cgc.ts`, fixtures-first defensive parse); BGS/SGC are decode-only in v1 (cert + grader, identity nulls, stamped `decode-only`).
- **Prices** — `lib/sources/pricecharting.ts#parseCompanyPrices` reads ALL per-company graded columns from the product page's full price-guide table; ONE page fetch serves both the summary map and the company map. Missing = null, never a guess.
- **Deltas** (`lib/deltas.ts`) — per company, `% = (higher − lower) / lower × 100` between each adjacent PRICED grade pair, rounded to 1 decimal.

## Out of scope (v1)

OCR identity for BGS/SGC; re-running preprocess on message edit/regenerate (the regenerate path carries no staged attachments, so the runner naturally skips); a UI toggle to disable a preprocessor; non-image consumers (the mechanism supports any MIME — only the scanner ships one).

## Key files

| Concern | Path |
| --- | --- |
| Manifest types (host + SDK) | `src/extensions/types.ts`, `packages/@ezcorp/sdk/src/types.ts` |
| Manifest validation | `src/extensions/manifest.ts#validatePreprocessorsArray` |
| Runner (matcher + executor) | `src/runtime/stream-chat/preprocess.ts` |
| Wiring + system notes | `src/runtime/stream-chat/setup-tools.ts` |
| LLM-context strip | `src/runtime/stream-chat/load-history.ts` |
| Row render branch | `web/src/lib/components/ChatMessage.svelte`, `web/src/lib/components/preprocess-result-logic.ts` |
| Chart card | `web/src/lib/components/tool-cards/GradeDeltaCard.svelte`, `grade-delta-logic.ts` |
| Consumer | `docs/extensions/examples/graded-card-scanner/` (`identify_slab`) |
| E2E | `web/e2e/preprocess-grade-delta.spec.ts` (@evidence) |
