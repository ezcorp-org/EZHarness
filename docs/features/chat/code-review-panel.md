# Code Review Panel

> _The chat's "Files changed" tab: every file a conversation touched, rendered as one GitHub-shaped pull-request review — file tree, sticky diff cards, split/unified, filter, and per-file "Viewed" ticks — in a 75%-width drawer._

## Intent

A long agent turn can edit a dozen files. Reading those edits inline, card by card, is not reviewing them. The code review panel gives the conversation the same surface GitHub gives a pull request: one changeset, one list, a tree to navigate it, and a way to mark off what you have already read.

It deliberately mirrors GitHub's **Files changed** tab — layout, colours, controls and vocabulary — so the muscle memory transfers.

## How it works

### Opening it

The chat header's diff button (`data-testid="diff-panel-btn"`) toggles `diffPanelOpen` on the chat page. The flag is persisted per conversation by `attachPanelPersistence` (`$lib/chat/page-handlers/panel-persistence.svelte.ts`), so a reload reopens the review where you left it. The panel itself is a right-side `SwipeDrawer` at `w-full md:w-[75vw]`.

### One changeset from two sources

Two upstream sources feed the review, and the model merges them into a single ordered file list:

| Source | Extractor | Key |
|---|---|---|
| Completed tool calls (`edit_file` / write-shaped inputs), including sub-agent ones hydrated into the parent | `aggregateToolCallDiffs` (`$lib/diff-aggregator.ts`) | `tool:<path>` |
| Fenced ```` ```diff ```` blocks in settled assistant messages | `extractDiffBlocks` (same module) | `code:<messageId>#<nth-in-message>` |

`buildReviewFiles` (`$lib/diff-review/review-model.ts`) turns both into `ReviewFile[]` — `{ key, path, dirname, basename, status, additions, deletions, diffText, source }`. Several edits to one file inside a single tool group are concatenated into one card.

Two invariants matter here:

- **Message-diff keys are scoped to the owning message**, never the flat index. A new diff arriving in an earlier message must not shift an already-ticked file's identity onto its neighbour.
- **Tree node keys are `dir:<path>` / `file:<file.key>`, never the path.** One conversation can legitimately touch the same file twice; keying the `{#each}` on path raises Svelte's `each_key_duplicate`, which throws and blanks the whole panel.

While a run is streaming, the last message is excluded — a half-written hunk renders as garbage.

### What the panel shows

- **Toolbar** — `Files changed` + count, `+N −M` totals with the five-square diffstat, the `Filter changed files` box, the Split/Unified segmented control, Expand/Collapse all, and `x / y files viewed` with a progress bar. Close sits at the right.
- **File tree** (`ReviewFileTree.svelte`) — recursive, collapsible directories; a file row jumps its card into view and shows `+N −M`, or a green check once viewed. The rail itself collapses.
- **File cards** (`ReviewFileCard.svelte`) — sticky header with the collapse chevron, counts, diffstat bar, monospace path, an `Added`/`Deleted` badge for whole-file changes, copy-path, and the **Viewed** checkbox. Ticking Viewed collapses the body and greys the header, exactly like GitHub.

`diffStatBlocks` reproduces GitHub's five-square rule: changes of five lines or fewer map one square per line and leave the rest grey; anything larger scales proportionally to fill all five.

Every file opens expanded **except** those over `LARGE_DIFF_LINES` (500 changed lines), which open behind GitHub's "Large diffs are not rendered by default." strip. That is a rendering budget as much as a UI choice: each open card parses its diff through diff2html and then walks every line through highlight.js, so a conversation that rewrote a lock file would otherwise block the panel's first paint. A file's open state is `explicitly-expanded ?? !explicitly-collapsed ?? !isLargeDiff`, with both override sets cleared on conversation change.

### Rendering & skin

`renderDiffHtml` (`$lib/diff-review/render-diff.ts`) is the single diff2html entry point — shared with the inline `DiffCard` — and falls back to escaped raw text when diff2html cannot parse the input. `highlightDiff` then applies hljs.

`web/src/lib/github-review.css` repaints the `.d2h-*` surface with Primer's diff tokens, scoped under `.gh-review` so the inline `DiffCard` and chat markdown diffs keep their existing look. Notable corrections it makes to diff2html's defaults:

- line-number cells are forced back to `display: table-cell` (diff2html ships `inline-block`, which leaks the inter-tag whitespace as a ~23px dead gutter);
- `d2h-change` rows lose diff2html's beige — GitHub has no "changed" state, only adds and deletes;
- hunk headers are flattened to plain muted text (the shared hljs pass reads `@@ … @@` as a comment and italicises it).

Dark mode keys off the app's `.dark` class, not `prefers-color-scheme`, so it follows the in-app theme toggle.

### Viewed state

`$lib/diff-review/viewed-files.ts` persists the ticked set **per conversation** under `ezcorp-diff-viewed:<conversationId>` — unlike the split/unified preference (`$lib/diff-view-mode.ts`), which is one global personal habit. Reads are defensive: a missing, corrupt or non-array entry means "nothing viewed", and `viewedCount` ignores stale keys so `3 / 4 files viewed` can never exceed the file count.

## Usage

### UI entry points

- **Chat header → diff button** (`data-testid="diff-panel-btn"`) — toggles the panel on any project chat (`web/src/routes/(app)/project/[id]/chat/[convId]/+page.svelte`). The open/closed flag is persisted per conversation, so a reload reopens the review where you left it.
- **File tree rail** — click a file row to jump its card into view; collapse the rail itself to widen the cards.
- **Split / Unified control** — a global personal preference (`$lib/diff-view-mode.ts`), not per conversation.
- **Viewed checkbox** — per file, persisted **per conversation**.

### REST API

None. The panel is entirely client-side: it derives its changeset from tool calls and assistant messages already loaded into the chat page. No route, no scope, nothing to register in `src/api-registry.ts`.

### Env vars / settings

No env vars and no `settings` KV keys. Two `localStorage` keys back the persisted state:

- `ezcorp-diff-viewed:<conversationId>` — the ticked "Viewed" set for one conversation.
- The split/unified preference key owned by `$lib/diff-view-mode.ts` — one global habit, shared across conversations.

## Key files

| Path | Role |
|---|---|
| `web/src/lib/components/DiffSummaryPanel.svelte` | The panel: toolbar, file tree, card list, empty states |
| `web/src/lib/components/review/ReviewFileCard.svelte` | One GitHub diff card |
| `web/src/lib/components/review/ReviewFileTree.svelte` | Recursive file tree |
| `web/src/lib/components/review/DiffStatBar.svelte` | Five-square diffstat |
| `web/src/lib/diff-review/review-model.ts` | Pure model: merge, counts, status, filter, tree |
| `web/src/lib/diff-review/viewed-files.ts` | Per-conversation Viewed persistence |
| `web/src/lib/diff-review/render-diff.ts` | Shared diff2html render (also used by `DiffCard`) |
| `web/src/lib/github-review.css` | Primer diff skin, scoped to `.gh-review` |
| `web/src/lib/diff-aggregator.ts` | Upstream extractors for both diff sources |
| `web/src/lib/diff-view-mode.ts` | Global split/unified preference |

## Tests

| Path | Covers |
|---|---|
| `web/src/lib/diff-review/*.test.ts` | The model, viewed persistence and the render helper (bun, 100%) |
| `web/src/lib/components/DiffSummaryPanel.component.test.ts` | The panel end-to-end in jsdom (vitest) |
| `web/e2e/diff-panel.spec.ts` | Browser behaviour: geometry, cards, filter, Viewed, split/unified, GitHub tints |
| `web/e2e/diff-panel-subagent.spec.ts` | Sub-agent edits reaching the parent's review |
| `web/e2e/code-review-panel-evidence.spec.ts` | `@evidence` captures (split, unified, mid-review, dark) |

## Features it touches

- [[conversations]] — the changeset is scoped to one conversation; the message tree supplies the settled assistant messages the `diff` blocks come from.
- [[builtin-file-tools]] — `edit_file` / write-shaped tool calls are the primary diff source; their recorded inputs are what `aggregateToolCallDiffs` extracts.
- [[streaming-runtime]] — while a run streams, the last message is excluded from the changeset so a half-written hunk never renders.
- [[teams]] — sub-agent edits hydrated into the parent conversation appear in the parent's review (`diff-panel-subagent.spec.ts` pins this).
- [[runs-lifecycle]] — a run's completed tool calls are what settle into reviewable diffs.
- [[dev-lifecycle-and-gates]] — the panel is a frontend-visual surface, so it carries an `@evidence`-tagged e2e spec per the feature contract.

## Related docs

No standalone spec exists; this file is the primary reference.

## Notes & gotchas

- **Tree node keys are `dir:<path>` / `file:<file.key>`, never the raw path.** One conversation can legitimately touch the same file twice. Keying the `{#each}` on path raises Svelte's `each_key_duplicate`, which **throws and blanks the whole panel** — a total failure, not a cosmetic one.
- **Message-diff keys are scoped to the owning message** (`code:<messageId>#<nth-in-message>`), never a flat index. A new diff arriving in an *earlier* message would otherwise shift an already-ticked file's identity onto its neighbour.
- **`LARGE_DIFF_LINES` (500) is a rendering budget, not just a UI preference.** Each open card parses through diff2html and then walks every line through highlight.js; without the collapse-by-default strip, a conversation that rewrote a lock file would block the panel's first paint.
- **Viewed state is per conversation; split/unified is global.** Deliberately asymmetric — what you have read is conversation-specific, how you like to read it is a personal habit. Don't "fix" one to match the other.
- **Viewed reads are defensive by design.** A missing, corrupt, or non-array `localStorage` entry means "nothing viewed", and `viewedCount` ignores stale keys, so `3 / 4 files viewed` can never exceed the file count.
- **Dark mode keys off the app's `.dark` class, not `prefers-color-scheme`** — it follows the in-app theme toggle, not the OS.
- **The Primer skin is scoped under `.gh-review`.** The inline `DiffCard` and chat-markdown diffs deliberately keep their existing look; widening the selector would repaint surfaces that were never meant to look like a PR.
