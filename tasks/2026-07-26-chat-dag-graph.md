# Chat DAG Graph — plan

Two-level interactive DAG for a conversation, opened from the chat header top-right.

- **Level 1 (Conversation map):** one node per user prompt. Edges = session-tree
  parent/child. Branches (rewind / A-B retry) fan out. Sub-agent spawns hang off
  the turn that spawned them.
- **Level 2 (Turn trace):** click a prompt node → DAG of that turn's internals —
  thinking, each tool call, each sub-agent spawn, the final assistant text.

---

## 1. Ground truth from the codebase (drives every decision below)

| Finding | Consequence |
|---|---|
| **No chat-header extension point exists.** Manifest surfaces are only: `panel` (bottom), `tools[].cardType` (inline/dock card), `messageToolbar[]`, `pages[]` (Hub), `settings`. Top-right cluster is first-party, prop-driven — `web/src/lib/components/chat/ChatHeader.svelte:172-336`. | A "top-right extension" needs a **new host surface built from scratch**. |
| **Extensions cannot ship custom rendering.** Hub page vocabulary (`src/extensions/page-schema.ts`) is a fixed node list — no HTML/SVG/canvas escape hatch. `cardType` → component is a hard-coded switch (`web/src/lib/components/tool-cards/utils.ts:25-64`). | The graph renderer **must** be host Svelte source either way. An extension could at most supply data. |
| **Chat graph decision (2026-07-26).** This chat feature uses the existing SVG approach (`tool-cards/price-chart-logic.ts`). | Keep the chat layout in a small pure-TS module. The factory console has a separate [Svelte Flow and ELK decision](../docs/decisions/2026-09-12-factory-editor-graph-library.md); this chat decision does not restrict it. |
| `GET /api/conversations/:id/tree` returns `{currentLeaf, nodes:[{id,parentId,role,excluded,createdAt}]}`. | **Level 1 is ~free.** |
| `GET /api/conversations/:id/messages?withToolCalls=true` returns `{messages, subConversations, orphanedToolCalls, subConversationToolCalls}`. | Level 2 has a data source today. |
| `observability_events` rows (`tool_call`, `tool_error`, `agent_call`, `turn_summary`) carry real `durationMs`; `tool_calls.durationMs` is **hardcoded 0** for built-in tools (`src/runtime/stream-chat/subscribe-bridge.ts:363`). | Level 2 timing must read **observability_events**, not `tool_calls`. Log the built-in-duration bug separately; do not fix it inside this feature. |
| `messages.thinkingContent` is **one concatenated blob** per message; block interleaving is not persisted (`web/src/lib/content-blocks.ts:92-117`). | Level 2 gets **one** thinking node per assistant message, ordered by the same heuristic `buildHistoricalBlocks` already uses. Do not invent finer ordering. |
| `invoke_agent` writes **no** `tool_calls` row — it emits `agent:spawn`/`agent:complete` and an `agent_call` obs row; the child is a sub-conversation linked by `conversations.parentMessageId`. | Sub-agent nodes come from `subConversations` + `agent_call` obs rows, not from tool calls. |
| `WaterfallTimeline.svelte` + `ObservabilityPanel.svelte` already normalize tool calls / obs events into a per-turn model. | **DRY: extract, don't duplicate.** The graph builder consumes a shared normalizer. |
| `DockHost.svelte` owns `position:fixed; right:0; z-index:50`, force-collapses the sidebar, and the app layout reserves `padding-right` for it (`(app)/+layout.svelte:434-443,506`). | A second right-side overlay **will fight the dock**. Must coordinate — see §3. |
| Binding invariant: never mutate `parentMessageId`. | Graph is strictly **read-only**. No rewind/edit actions in v1. |

---

## 2. Packaging — DECIDED: first-party host feature

**Build it first-party, in the host, as a chat-header panel.** Reasons:

1. The graph renderer has to be host Svelte no matter what — extensions have no
   rendering escape hatch. Packaging it as an extension buys zero isolation and
   costs a whole new manifest surface + render path + permission story.
2. The data is core-owned (session tree, obs events, sub-conversations). Routing
   it out to a sandboxed subprocess and back is pure overhead.
3. An extension subprocess **cannot read message history** at all (only
   `append-message` writes). It would have to fetch `/api/*` from an iframe with
   the user's cookie — the documented non-boundary.

Rejected alternative (for the record): a real extension would additionally need
(a) a new generic host surface `manifest.chatHeader[]` and (b) a `graph` node
type in the Hub page vocabulary — ~2.5× the work, plus permanently-owned host
schema, for no isolation benefit.

### 2b. Level 1 scope — DECIDED

Level 1 contains **all three**:

1. **Prompt nodes** are the primary node type and the drill-in target. Every
   prompt node is clickable → Level 2. This is the headline interaction; it must
   be obvious (pointer cursor, hover affordance, focus ring, `aria-label`
   naming the action) and covered by its own e2e assertion.
2. **Rewind / A-B-retry branches** render as real DAG forks; the rewound-away
   path is greyed (`excluded: true`), the live path is emphasized.
3. **Sub-agent spawns** hang off the turn that spawned them, and are themselves
   drillable into that sub-conversation's own graph.

Consequence for Agent A: the Level 1 builder must merge **three** sources —
`/tree` (branch topology), `messages` (prompt text for labels), and
`subConversations` (spawn edges) — not just `/tree`.

---

## 3. UI placement

Add a **10th button** to the `ChatHeader` top-right cluster, adjacent to the
existing observability button (`ChatHeader.svelte:296-308`) — same family of
"inspect this conversation" affordances.

Panel surface: **`SwipeDrawer side="right"`, modelled exactly on
`ObservabilityPanel.svelte`.**

Corrects an earlier draft of this plan, which said to add a first-party slot to
`DockHost`. That was wrong. `DockHost` is hard-wired to tool calls — its slot is
`{toolCallId}`, its content is `inlineToolStore.getById(...)` adapted to
`ToolCallState` and rendered through `ToolCardRouter`. Hosting a non-tool panel
there means turning the slot into a discriminated union and touching shipping
extension-canvas code for zero benefit.

`ObservabilityPanel` is the exact precedent: same trigger location (a button in
the header top-right cluster), same lifecycle (`open` + `onclose` state owned by
the chat page), and it **already coexists with `DockHost`**. `SwipeDrawer`
(`web/src/lib/components/SwipeDrawer.svelte`) supplies focus trap, topmost-only
Esc handling via a drawer registry, swipe-to-dismiss, backdrop, and z-index
layering. Reuse it; do not hand-roll a fixed overlay and do not touch `DockHost`.

Mount point: `web/src/routes/(app)/project/[id]/chat/[convId]/+page.svelte`,
next to the existing `<ObservabilityPanel>` (~line 366), with `graphOpen` state
threaded to `ChatHeader` the same way `obsOpen` is.

Interaction: Level 1 → click node → Level 2 (same panel, breadcrumb back).
Node click on Level 1 also scrolls the thread to that message. Pan/zoom via
SVG viewBox. Keyboard: arrow-key node traversal, Enter to drill in, Esc to
close/back.

---

## 4. Deliverables

**Backend**
- `src/runtime/chat-graph/build-conversation-dag.ts` — pure. tree nodes +
  sub-conversations → `{nodes, edges}` for Level 1.
- `src/runtime/chat-graph/build-turn-dag.ts` — pure. one turn's messages +
  tool_calls + observability_events + sub-conversations → Level 2 `{nodes, edges}`.
- `src/runtime/chat-graph/types.ts` — the wire contract (frozen first, §6).
- `web/src/routes/api/conversations/[id]/graph/+server.ts` — `GET`, owner-gated
  404-fail-closed (copy the ladder from `.../audit/+server.ts`), `?turn=<messageId>`
  selects Level 2. **Register in `src/api-registry.ts`, scope `read`.**

**Frontend**
- `web/src/lib/graph/layout.ts` — pure layered DAG layout (rank by depth, order
  by `createdAt`, x/y assignment, SVG edge paths). No new dependency.
- `web/src/lib/components/chat/ChatGraphPanel.svelte` — panel shell, level
  switching, breadcrumb, loading/empty/error states.
- `web/src/lib/components/chat/GraphCanvas.svelte` — SVG renderer, pan/zoom,
  node/edge components, a11y.
- `ChatHeader.svelte` — the button (`data-testid="chat-graph-btn"`).
- `DockHost.svelte` / `stores.svelte.ts` — first-party dock slot.

**Shared / DRY**
- Extract the tool-call + obs-event normalizer currently duplicated in
  `WaterfallTimeline.svelte` (`computeBarsFromToolCalls` / `computeBarsFromEvents`)
  into a shared module the graph builder and the waterfall both consume.

**Tests (feature contract, binding)**
- 100% on every new source file + a key per file in `scripts/coverage-thresholds.json`.
- Vitest component tests: `ChatGraphPanel.component.test.ts`, `GraphCanvas.component.test.ts`.
- Bun unit tests for both builders + the layout module + the shared normalizer.
- `web/e2e/chat-graph.spec.ts` — mock tier: open panel, assert Level 1 prompt
  nodes, **click a prompt node → assert Level 2 renders that turn's** tool /
  thinking / sub-agent nodes, breadcrumb back, close. Separate assertions that
  a forked branch renders two paths with the excluded one greyed, and that a
  sub-agent node is present and drillable.
- `web/e2e/chat-graph-evidence.spec.ts` — title ends `@evidence`, calls
  `captureEvidence(page, testInfo, label)`; **register in `web/e2e/evidence-covers.json`**
  mapping to the new `.svelte` files + `ChatHeader.svelte`.
- Branch fixture: seed a rewind/A-B-retry conversation so Level 1 actually forks
  (reuse `web/e2e/fixtures/db-seed.ts`, see `chat-branch-fork.spec.ts`).

---

## 5. Sub-agent team

Binding: every agent runs in its **own git worktree** off `feat/chat-dag-graph`
(`git worktree add ../ez-corp-ai-<slug> -b <branch>`), and `tasks/` is gitignored
— copy this doc into each worktree.

| Agent | Owns | Depends on | Parallel? |
|---|---|---|---|
| **A — Data/API** | `src/runtime/chat-graph/**`, the `/graph` route, api-registry entry, backend tests | §6 contract | wave 1 |
| **B — Layout** | `web/src/lib/graph/layout.ts` + tests. Pure TS, zero imports from the app | §6 contract | wave 1 |
| **C — Normalizer/DRY** | extract shared tool-call/obs normalizer out of `WaterfallTimeline`, keep waterfall green | §6 contract | wave 1 |
| **D — UI** | `ChatGraphPanel`, `GraphCanvas`, header button, dock slot, component tests | A (mock the route), B (real module) | wave 2 |
| **E — SDET** | e2e specs, `@evidence` spec, `evidence-covers.json`, fixtures, coverage-threshold keys | D | wave 3 |
| **F — Reviewer** | `typecheck && lint && test && test:coverage`, pixel review of the panel light+dark, DRY audit vs `WaterfallTimeline`/`ObservabilityPanel`, dock-conflict check | all | wave 4 |

Wave 1 is a true 3-way parallel fan-out — all three are pure modules behind a
frozen contract. Wave 2 starts as soon as B lands; A is stubbable with a fixture
JSON. Do not let D start before the contract is frozen.

## 6. Freeze first (before any agent spawns)

```ts
type GraphNodeKind =
  | "prompt" | "assistant" | "thinking" | "tool" | "subagent" | "error";

interface GraphNode {
  id: string;              // messageId | toolCallId | subConversationId
  kind: GraphNodeKind;
  label: string;           // truncated prompt / tool name / agent name
  status: "success" | "error" | "running" | "interrupted";
  createdAt: string;
  durationMs?: number;     // obs-derived; absent when unknown — never fake 0
  excluded?: boolean;      // greyed (rewound-away branch)
  drillable?: boolean;     // Level 1 prompt nodes, and subagent nodes
  meta?: Record<string, unknown>;
}
interface GraphEdge { from: string; to: string; kind: "sequence" | "spawn" | "branch"; }
interface ChatGraph { level: 1 | 2; rootId: string | null; nodes: GraphNode[]; edges: GraphEdge[]; }
```

Rules: `durationMs` is **omitted** when the source is a built-in `tool_calls`
row (which stores 0) and no obs row exists — the UI renders "—", never "0ms".

---

## 7. Explicitly out of scope for v1

- Live streaming updates (Level 1 refetches on `conversation:tree-changed`;
  Level 2 refetches on `run:complete`). No incremental SSE graph patching.
- Any write action from the graph (no rewind, no branch switch, no delete).
- Cross-conversation / whole-project graph.
- Fixing `tool_calls.durationMs = 0` for built-in tools — separate PR.
- Persisting content-block order — separate, larger change.

---

## 8. Review — what shipped

Built by a 6-agent team, each in its own git worktree off `feat/chat-dag-graph`,
behind a type contract frozen and committed before any agent spawned (zero
interface drift resulted).

| Wave | Agent | Landed |
|---|---|---|
| 1 | A — Data/API | `labels.ts`, `order.ts`, `build-conversation-dag.ts`, `build-turn-dag.ts`, `load.ts`, `GET /api/conversations/[id]/graph`, api-registry entry |
| 1 | B — Layout | `web/src/lib/graph/layout.ts` — pure Sugiyama-lite layered layout, zero deps |
| 1 | C — DRY | extracted `web/src/lib/timeline-normalize.ts` out of `WaterfallTimeline.svelte` |
| 2 | D — UI | `ChatGraphPanel.svelte`, `GraphCanvas.svelte`, `panel-logic.ts`, `canvas-view.ts`, header button, page wiring |
| 3 | E — SDET | `chat-graph.spec.ts`, `chat-graph-evidence.spec.ts`, fixtures, both manifest registrations |
| 4 | F — Review | 2 real bug fixes, 1 test hardening, 1 spec correction |

### Decisions that changed during the build

- **`SwipeDrawer`, not `DockHost`.** See §3. `DockHost` is hard-wired to tool
  calls; `ObservabilityPanel` was the right precedent.
- **`detectCycle` was NOT reused.** `src/runtime/graph-cycle.ts` returns a cycle
  path; the layout engine needs cycle-breaking fused into Kahn ranking. Different
  job — reuse would have been wrong.
- **The duration rule's window is half-open `[start, end)`**, and an A-B retry
  does *not* close it (retry adds no user row, so both legs are one turn). The
  original spec text in §6 said `[start, end]` and the builder comment claimed
  retry closed the window; both were corrected by review. Comments only.

### Bugs review caught (all fixed)

1. **Keyboard tab stop lost on level switch** (`GraphCanvas.svelte`) — `activeId`
   honoured a stale `focusedId` after drilling in, so NO node got `tabindex="0"`
   and the graph left the tab order entirely. A keyboard user could not reach the
   headline "click a prompt" interaction.
2. **Corrupt duration spoken as an em dash** (`canvas-view.ts`) — `nodeAriaLabel`
   gated on `durationMs !== undefined`, so negative/NaN/Infinity was formatted to
   `—` and pushed into the accessible name. Now gates on the formatted value.
3. **`format-duration.ts` at 32%** — not a review find but a coverage-gate find.
   `canvas-view.ts` is its first plain-TS importer, which pulled a previously
   unmeasured shared util into the gate. Fixed by testing it to 100%, not by
   dropping the reuse.

### Verification

- typecheck ✓ · biome on all new files ✓ · production `bun run build` ✓
- backend pool: 14,307 pass / 963 files ✓
- web bun pool: 4,291 pass / 225 files ✓
- vitest: 4,593 pass / 427 files ✓
- e2e `chat-graph`: 18 passed ✓ · `@evidence`: 4 passed ✓
- meta-tests: e2e-lanes, visual-evidence-covers/gate, route-contract ✓
- coverage: at **exact parity with a clean `main` baseline**. Both fail locally
  on the same 9 `web/src/lib/server/security/*` files, which are covered
  97.8–100% by their own `scripts/security-coverage.sh` CI leg (not run by the
  local `test:coverage`). Nothing in this branch is below threshold.

### Known flake (pre-existing, not introduced here)

`src/__tests__/agent-input-form.test.ts` → "web build > svelte app builds
successfully" spawns a full SvelteKit build inside the parallel test pool. It
failed once at 32.6s against a 180s timeout (non-zero exit under memory
pressure, not a timeout) and passed on re-run and in isolation; `bun run build`
succeeds directly. **The test is `test.skip`-ed when `CI` is set**, so it never
runs in PR CI. Worth converting to a proper resource-guarded job — filed as
follow-up, not fixed here to keep this diff scoped.
