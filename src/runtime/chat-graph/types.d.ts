/**
 * Chat DAG graph — the frozen wire contract.
 *
 * Single source of truth for both the builders (`src/runtime/chat-graph/*`)
 * and the browser renderer (`web/src/lib/graph/*`, which imports these
 * type-only via the `$server` alias — see `web/svelte.config.js`).
 *
 * TYPES ONLY — and this file is a `.d.ts` so the compiler enforces that rather
 * than trusting a comment. It is imported by client-side Svelte components,
 * where a `$server` *value* import would drag backend code into the browser
 * bundle; a declaration file cannot hold a runtime value, so that can't happen
 * by accident. Runtime constants belong next to their consumer.
 *
 * The `.d.ts` extension is also what tells the coverage gate the truth about
 * this file: `NON_SOURCE_GLOBS` in `scripts/coverage-config.ts` classifies any
 * declaration file as a type-only declaration rather than gateable product
 * code, so the new-file gate correctly stops demanding line coverage for a
 * module that compiles to nothing. Every importer uses an extensionless or
 * `.js`-suffixed specifier, both of which resolve to this file under
 * `moduleResolution: "bundler"`.
 *
 * Two levels, both served by `GET /api/conversations/:id/graph`:
 *   - level 1 (no `?turn=`)  — the conversation map: one node per user prompt,
 *     plus branch forks and sub-agent spawns.
 *   - level 2 (`?turn=<messageId>`) — one turn's internals: thinking, tool
 *     calls, sub-agent spawns, the assistant reply.
 */

/**
 * `prompt`    — a user message. The ONLY drill-in target on level 1.
 * `assistant` — an assistant reply (level 2 terminal node).
 * `thinking`  — reasoning for one assistant message. At most ONE per assistant
 *               message: `messages.thinkingContent` is a single concatenated
 *               blob and block interleaving is not persisted. Do not attempt
 *               to split it into multiple nodes.
 * `tool`      — one `tool_calls` row.
 * `subagent`  — a spawned sub-conversation. Drillable on both levels.
 * `error`     — a run-level failure (`observability_events.run_error`).
 */
export type GraphNodeKind = "prompt" | "assistant" | "thinking" | "tool" | "subagent" | "error";

export type GraphNodeStatus = "success" | "error" | "running" | "interrupted";

/**
 * Edge kinds carry rendering meaning, not just topology:
 *   `sequence` — ordinary next-step flow (solid).
 *   `spawn`    — parent turn → sub-agent conversation (dashed).
 *   `branch`   — a fork introduced by rewind / A-B retry (solid, but the
 *                subtree it leads to may be `excluded`).
 */
export type GraphEdgeKind = "sequence" | "spawn" | "branch";

export interface GraphNode {
  /**
   * Stable identity, unique within one `ChatGraph`:
   *   prompt/assistant → `messages.id`
   *   thinking         → `thinking:<messageId>`
   *   tool             → `tool_calls.id`
   *   subagent         → `conversations.id` of the child
   *   error            → `error:<observabilityEventId>`
   */
  id: string;
  kind: GraphNodeKind;
  /** Display label. Already truncated by the builder — see `LABEL_MAX`. */
  label: string;
  /** Full untruncated text for the tooltip / detail pane. Omitted when equal to `label`. */
  fullLabel?: string;
  status: GraphNodeStatus;
  /** ISO-8601. The ordering axis for every builder. */
  createdAt: string;
  /**
   * Wall-clock duration, milliseconds.
   *
   * ABSENT means "not known", and the UI MUST render an em dash, never "0ms".
   * Built-in tools persist `tool_calls.duration_ms = 0` unconditionally
   * (`src/runtime/stream-chat/subscribe-bridge.ts`), so a 0 in that column is
   * indistinguishable from a genuinely instant call. The builder therefore
   * treats `tool_calls.durationMs === 0` as unknown and only fills this field
   * from a confidently matched `observability_events` row (see
   * `matchObservabilityDurations` below) or from a non-zero column value.
   */
  durationMs?: number;
  /** True when the message is dropped from LLM context (rewound-away branch). Rendered greyed. */
  excluded?: boolean;
  /** True when clicking navigates deeper. Level-1 prompts and every `subagent` node. */
  drillable?: boolean;
  /** For `subagent` nodes: the child conversation to drill into. */
  subConversationId?: string;
  /** For `tool` nodes: which extension owns it (`"builtin"` for host tools). */
  extensionId?: string;
  /** Free-form extras for the detail pane. Never load-bearing for layout. */
  meta?: Record<string, unknown>;
}

export interface GraphEdge {
  /** `GraphNode.id` of the source. */
  from: string;
  /** `GraphNode.id` of the target. */
  to: string;
  kind: GraphEdgeKind;
}

export interface ChatGraph {
  level: 1 | 2;
  /** Level 1: the conversation id. Level 2: the turn's user `messages.id`. Null for an empty conversation. */
  rootId: string | null;
  conversationId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /**
   * True when the session-history producer flag is off, so branch topology
   * could not be read and the graph degraded to a flat chain built from
   * `messages.parentMessageId` alone. The UI shows a quiet notice; it is NOT
   * an error state.
   */
  degraded?: boolean;
}

/**
 * Labels are truncated by the builders to a fixed budget (see `LABEL_MAX` in
 * `src/runtime/chat-graph/labels.ts`) so the payload stays small; when a label
 * is truncated the builder sets `fullLabel` to the original. The renderer
 * receives labels already truncated and must not re-truncate.
 */

/**
 * ===== Observability duration matching (binding rule for the level-2 builder) =====
 *
 * `observability_events` rows of type `tool_call` / `tool_error` carry a REAL
 * `durationMs`, but they do NOT carry a `toolCallId` or a `messageId` — they
 * are only conversation-scoped and time-ordered (see
 * `src/observability/collector.ts`). So they cannot be joined to `tool_calls`
 * rows by key. The builder MUST use this deterministic positional rule:
 *
 *   1. Take the turn's `tool_calls` rows, ordered by `createdAt` ASC, then by
 *      `id` ASC to break same-millisecond ties.
 *   2. Take the conversation's `tool_call` + `tool_error` observability rows
 *      whose `createdAt` falls within the turn's HALF-OPEN [start, end)
 *      window, same ordering. `end` is the first row that is not a member of
 *      the turn, and it belongs to the NEXT turn — so it is excluded.
 *   3. Bucket BOTH lists by `toolName`, preserving order within each bucket.
 *   4. Zip each bucket by index. A tool call at index `i` of bucket `foo`
 *      adopts the `durationMs` of the observability row at index `i` of
 *      bucket `foo`.
 *   5. No counterpart at that index ⇒ leave `durationMs` ABSENT.
 *
 * This is positional, not authoritative. It is correct whenever the two
 * sources agree on per-name call order within a turn, which is the normal
 * case, and it degrades to "unknown" rather than to a wrong number.
 * Do not "improve" it into a fuzzy nearest-timestamp match — that trades a
 * testable rule for an untestable one.
 */
