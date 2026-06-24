# Mention Grammar (5 sigils)

> _The chat composer's structured-mention system: five sigils (`! @ / $ %`) each open an autocomplete popover, insert an atomic `<sigil>[kind:name]` token onto the wire, render it as a compact chip, and resolve/expand server-side at prompt-build time — all driven by one pure-logic module and one search endpoint._

## Intent

Mentions let a user reference EZCorp entities inline while typing — agents, extensions, teams, runtime actions, project files/dirs, slash commands, Feature-Index buckets, and Lessons-Keeper lessons — without leaving the composer. Each reference is persisted as a stable structured token (`![agent:Code Assistant]`, `@[file:src/app.ts]`, …) so the raw message stays faithful, while the LLM sees a resolved / expanded variant produced server-side. The grammar is deliberately one shared pure module (`mention-logic.ts`) plus one routing endpoint (`/api/mentions/search`) so trigger detection, tokenization, display projection, and server expansion can never drift apart.

## How it works

### The five sigils

`web/src/lib/mention-logic.ts` is the single source of truth. `MENTION_REGEX` is a five-alternative regex; each sigil maps to one or more kinds:

| Sigil | Kind(s) | Token | Resolved from |
|---|---|---|---|
| `!` | `agent`, `ext`, `team`, **`EZ`** | `![kind:name]` | DB (`agentConfigs`, `extensions`) + executor's in-memory agent map + EZ-action registry |
| `@` | `file`, `dir` | `@[kind:relpath]` | Active project's filesystem (symlink-escape filtered) |
| `/` | `cmd` | `/[cmd:name]` | Command registry (`.claude`/`.codex`/`agents` dirs + `user_commands` DB) |
| `$` | `feature` | `$[feature:name]` | DB (`features` table, scoped to the active project) |
| `%` | `lesson` | `%[lesson:slug]` | DB (`lessons` table, scoped to user + project, visibility-filtered) |

`EZ` (uppercase) is a fourth kind nested under the `!` sigil. It is distinct from `agent`/`ext`/`team` because the LLM **never sees** `![EZ:…]` tokens — they are stripped pre-prompt server-side and invoke a code-defined runtime action instead.

### Client lifecycle (typing → chip)

1. **Trigger detection.** On every keystroke, `ChatInput.svelte`'s `handleInput` calls `detectMentionTrigger(displayValue, caret)`. Five end-anchored regexes (`BANG_TRIGGER_RE`, `AT_TRIGGER_RE`, `SLASH_TRIGGER_RE`, `DOLLAR_TRIGGER_RE`, `PERCENT_TRIGGER_RE`) match the "user is mid-typing a sigil" sequence at a word boundary. Because all five anchor to end-of-input, only the rightmost word-boundary sigil can match. The `$` and `%` triggers require the first tail char to be a letter/underscore/hyphen, dodging `$5.00`, `${var}`, `%20`, `5 % 2` false positives.
2. **Search.** The detected `{query, type, sigil}` debounces (200 ms) into `searchMentions(query, type, projectId)` (`web/src/lib/api.ts`), hitting `GET /api/mentions/search?type=…`. Results populate `MentionPopover.svelte`.
3. **Popover.** `MentionPopover.svelte` groups results by kind into labeled sections (Slash commands, Features, Lessons, EZ actions, Teams, Agents, Extensions, Folders, Files) and flattens them into one keyboard-navigable list. For `@` descent, a synthetic `dir-target` ("Use this folder as path") entry leads the list when the query ends with `/`.
4. **Insertion.** On select, `handleMentionSelect` maps the API kind (`extension`/`command`) back to the wire kind (`ext`/`cmd`) and calls `insertMentionToken`, which replaces the trigger span with the atomic `<sigil>[kind:name]` token + trailing space. Folders **descend** instead (`descendIntoFolder` rewrites the query to `@<path>/` and re-fires the search). The built-in `/goal` entry is special: it carries `insertText: "/goal "` and is inserted as **literal text** via `insertCommandLiteral` (a `/[cmd:goal]` token would never match the server's `isGoalCommand` interceptor).

### Compact-display decoupling

The textarea text is **not** the wire text. `ChatInput.svelte` keeps two strings:

- `value` — the **wire** string holding full `![kind:name]` tokens; the single source of truth for submit, parsing, and overlay segments.
- `displayValue` — a **compact projection** (`!Code Assistant`, `@app.ts`, `$feature`, …) that the transparent textarea actually lays out, so chips sit tight against their label instead of leaving a gap the width of the hidden `[kind:` … `]` characters.

`web/src/lib/mention-display.ts` translates between the two: `toDisplay(wire)` produces the display string plus a per-mention `DisplaySpan` map; `displayPosToWire` / `wirePosToDisplay` map caret offsets across spans; `applyDisplayEdit(oldWire, newDisplay)` projects a textarea edit back onto the wire (returning `null` when an edit cut **into** a token's interior, which the caller treats as "reject / resync"). Tokens are **atomic** — Backspace/Delete inside a chip deletes the whole wire token. A mirrored overlay paints `MentionChip` chips over the transparent textarea using `getSegments(value)`.

### Server resolution & expansion

`src/runtime/mention-wiring.ts` is the pure (DB-free, resolver-injected) server module. Each sigil has its own pass, wired into the prompt build in `src/runtime/stream-chat/build-prompt.ts` (and `setup-tools.ts` for tool wiring). All passes parse the **original** persisted message — expansion is **literal** (rendered bodies are never re-parsed for further sigils, blocking indirect prompt injection):

- **`![EZ:…]` strip** (`stripEzActionTokens`) runs first, removing action tokens from the LLM-facing text; the action list is dispatched separately. An action-only message short-circuits the LLM.
- **`/[cmd:…]` expansion** (`applyCommandExpansion` → `expandCommandMentions`) replaces each command token with its resolved body, substituting `$ARGUMENTS` / `$1..$N` from inter-token text. Unknown commands stay literal with an advisory system note.
- **`@[file|dir:…]` resolution** (`resolveFileMentions` + `formatFileMentionSystemNotes`) resolves paths against the project root, rejecting absolute paths, `..` traversal (via `validatePath`), and symlink-escape (via `realpathInsideRoot`). Emits a plain-text system note per reference (lazy injection — **no file content is embedded**).
- **`$[feature:…]` expansion** (`applyFeatureExpansion`, resolver = `getFeature`) emits one system-note block per resolved feature: its description + plain-text file paths.
- **`%[lesson:…]` expansion** (`applyLessonExpansion`, resolver = `getLessonBySlug`) emits one block per resolved lesson (title + body), capped at 5 expansions / 8 KiB joined per turn; `onFired` bumps `firedCount` / `lastFiredAt`.
- **`![agent|ext|team:…]` wiring** (`resolveMentionedAgents`, `resolveMentionedTeams`, `wireMentionedExtensions` in `setup-tools.ts`) resolves agent/team configs and wires referenced extensions' tools into the conversation.

For feature/lesson/file passes, the user-visible message text is **never modified** — the raw token survives in the persisted message while the LLM sees an additional system note. This mirrors how a deleted `@[file:…]` is a silent no-op.

## Usage

### Composing

Type a sigil in the chat composer (`web/src/routes/(app)/project/[id]/chat/[convId]/+page.svelte`, via `ChatInput.svelte`):

- `!` → agents / extensions / teams / EZ actions. `!agent:`, `!ext:`, `!team:`, `!ez:` (case-insensitive) filter to one kind; bare `!` shows all.
- `@` → project files & folders. Typing `/` in the query descends one folder level; the "Use this folder as path" entry commits a `@[dir:…]`.
- `/` → slash commands (filesystem + DB) plus the built-in `/goal` autopilot.
- `$` → Feature-Index buckets for the active project.
- `%` → Lessons-Keeper lessons for the active user + project.

### Search API

`GET /api/mentions/search` (scope `read`, auth required) routes entirely on `type=`:

| `type=` | Returns | Notes |
|---|---|---|
| `cmd` | slash commands + injected `/goal` | `projectId` optional (falls back to home + DB commands); `/goal` gated on `EZCORP_GOAL_ENABLED` |
| `EZ` | EZ actions from the in-memory registry | global, code-defined; leaks only `name` + `description` |
| `feature` | Feature-Index entries | `projectId` **required** (else `[]`) |
| `lesson` | lesson excerpts (≤60 chars) | `projectId` **required**; visibility precedence enforced in `searchLessons` |
| `tool` | one extension's tools (`?extension=<name>`) | for `!ext:<name>/` tool autocomplete |
| `path` | files + dirs (root + one level, or descent) | `projectId` **required**; symlink-escape filtered |
| _(none)_ | teams → agents → extensions → built-in tool categories → EZ actions | the bare-`!` fallback |

All branches cap at `MAX_RESULTS = 10`. Query params: `q`, `type`, `projectId`, plus `extension` (for `type=tool`).

### Read-only rendering

`web/src/lib/components/MentionText.svelte` renders persisted message text with `getSegments` → `MentionChip`, so tokens display as chips in chat history (not raw wire text).

### Env vars

- `EZCORP_GOAL_ENABLED` (default on) — gates whether the `/goal` entry appears in `type=cmd` results (mirrors the messages-route interceptor).
- `EZCORP_SCAN_GLOBAL_COMMANDS` (default on) — gates global slash-command discovery (consumed in the command registry, not this endpoint directly).

## Key files

- `web/src/lib/mention-logic.ts` — pure trigger detection (`detectMentionTrigger`), `MENTION_REGEX`, `parseMentions`, `getSegments`, `insertMentionToken`, `insertCommandLiteral`, `descendIntoFolder`, `formatPathDisplay`, `STRUCTURED_NAME_CHAR_CLASS`, `LITERAL_COMMAND_NAMES`.
- `web/src/lib/mention-display.ts` — compact-display decoupling: `toDisplay`, `displayTokenText`, `applyDisplayEdit`, `displayPosToWire`, `wirePosToDisplay`.
- `web/src/routes/api/mentions/search/+server.ts` — single GET endpoint; routes on `type=`; fuzzy-ranks; caps at 10.
- `web/src/lib/components/MentionPopover.svelte` — grouped autocomplete listbox, keyboard nav, `dir-target` synthetic entry, `insertText` handling.
- `web/src/lib/components/ChatInput.svelte` — composer: wire/display sync (`setWire`), atomic chip delete, overlay chip rendering, mention search wiring.
- `web/src/lib/components/MentionChip.svelte` — the visible chip pill rendered over the transparent textarea and in history.
- `web/src/lib/components/MentionText.svelte` — read-only segment renderer for persisted messages.
- `src/runtime/mention-wiring.ts` — server expansion/resolution: `stripEzActionTokens`, `applyCommandExpansion`, `applyFeatureExpansion`, `applyLessonExpansion`, `resolveFileMentions`, `formatFileMentionSystemNotes`, `resolveMentionedAgents`, `resolveMentionedTeams`, `wireMentionedExtensions`; `FEATURE_TOKEN_RE`, `EZ_ACTION_TOKEN_RE`, `LESSON_TOKEN_RE`.
- `src/runtime/stream-chat/build-prompt.ts` — wires the EZ-strip / command / file / feature / lesson passes into the prompt, injecting DB-backed resolvers (`getFeature`, `getLessonBySlug`).
- `src/runtime/stream-chat/setup-tools.ts` — wires `wireMentionedExtensions` + agent/team resolution into the tool surface.
- `src/runtime/fs/scan-fs.ts` — shared `EXCLUDED_DIR_NAMES`, `realpathInsideRoot`, `listFilteredChildren` used by both the `@`-autocomplete and the file-mention resolver.
- `web/src/lib/api.ts` — `searchMentions` client wrapper.
- `web/src/lib/fuzzy-match.ts` — `fuzzyScore` / `bestFuzzyScore` ranking used by the search endpoint.
- `web/src/lib/command-source-label.ts` — renders command-source badges in the popover.

## Features it touches

- [[slash-commands]] — the `/` sigil; `applyCommandExpansion` renders command bodies with `$ARGUMENTS`/`$N` substitution. The built-in `/goal` is inserted as literal text.
- [[feature-index]] — the `$` sigil; `applyFeatureExpansion` emits a feature's description + file paths as a system note.
- [[lessons]] — the `%` sigil; `applyLessonExpansion` injects lesson bodies (capped per turn) and bumps fired counts.
- [[ez-concierge-and-actions]] — the `![EZ:…]` kind; tokens are stripped pre-prompt and dispatch runtime actions.
- [[agents]] — `![agent:…]` resolves agent configs; an `@agent` mention spawns a sub-conversation.
- [[teams]] — `![team:…]` resolves a team config and its members.
- [[builtin-file-tools]] — `@[file|dir:…]` resolution shares `validatePath` (lexical) with the built-in file tools; the autocomplete uses realpath (`realpathInsideRoot`).
- [[attachments]] — `!ext:NAME` mentions in the draft widen the attachment accept-list via the pending-extension capability fetch.
- [[goal-autopilot]] — the `/goal` literal-command entry feeds the inline `/goal` interceptor in the messages route.
- [[conversations]] — mentions are parsed from the **literal** typed text in the send pipeline; never re-parsed from expanded text.
- [[streaming-runtime]] — all expansion passes run inside `build-prompt.ts` on the way to `streamChat`.
- [[projects]] — `@`/`$`/`%` searches are scoped to the active project (`projectId` required).
- [[api-security]] — `/api/mentions/search` is gated by `requireScope("read")` + `requireAuth`.

## Related docs

- [slash-commands](../../slash-commands.md) — full spec for the `/` sigil, command discovery, and expansion.
- [feature-index design](../../plans/2026-05-01-feature-index-design.md) — the `$` sigil's Feature-Index design.
- (No standalone Lessons-Keeper or display-decoupling doc yet — this file is the primary reference for the `%` sigil and the compact-display layer.)

## Notes & gotchas

- **`$` / `%` digit-leading slugs won't trigger incrementally.** `DOLLAR_TRIGGER_RE` / `PERCENT_TRIGGER_RE` require the first tail char to be a letter/underscore/hyphen (to reject `$5.00`, `%20`). A feature/lesson whose name starts with a digit can only be reached by typing the bare sigil (empty query → full list) or inserting via UI.
- **`/goal` is literal, not a token.** It is inserted as raw `/goal ` text (via `insertText` + `insertCommandLiteral`), because the server-side `isGoalCommand` interceptor matches on the raw message body. A `/[cmd:goal]` token would never fire it. `getSegments` still renders it as a command pill via `LITERAL_COMMAND_NAMES`.
- **Expansion is strictly literal.** Command/feature/lesson bodies and `$ARGUMENTS` are **not** re-parsed for further mention sigils — this blocks indirect prompt injection (e.g. a command body containing `![ext:evil]` stays inert).
- **Path containment is asymmetric.** The `@`-autocomplete and `resolveFileMentions` both use **realpath** (`realpathInsideRoot`) to filter symlink-escape. But the built-in file tools' `validatePath` (`src/runtime/tools/validate.ts`) is **lexical** (no realpath) — a symlink whose real target escapes the root passes the lexical check at the tool layer even though the mention resolver would have refused it. Mind this gap when reasoning about file-reference safety end-to-end.
- **`type=path` / `feature` / `lesson` need `projectId`.** Without it the endpoint returns `[]` and the popover shows "No matches found" — `ChatInput` must pass `projectId` (from `page.params.id`) or `@`/`$`/`%` appear silently broken.
- **The `EZ` kind leaks only name + description.** The search endpoint and `listEzActions` deliberately surface only `{name, description, kind:"EZ"}`; the action handler stays inside the registry (defense-in-depth).
- **`applyDisplayEdit` returns `null` on a partial token cut.** A textarea edit/selection that lands **inside** a chip's compact label can't be safely projected onto the wire — `handleInput` restores the canonical display and bails. This is why deletions of chips must go through the atomic Backspace/Delete handler, not free-form text editing.
- **The display pad is cosmetic.** `displayTokenText` appends a 4-space `DISPLAY_TOKEN_PAD` so the chip pill (rounded border + padding) clears the next character — display-only, never written to the wire token.
- **Lesson expansion caps fail closed.** A paste-bomb of `%[lesson:…]` tokens resolves at most `MAX_LESSON_EXPANSIONS_PER_TURN` (5) lookups and emits at most `MAX_LESSON_EXPANDED_CHARS` (8 KiB) — excess tokens drop silently rather than DoS the context window.
