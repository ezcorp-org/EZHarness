/**
 * LEVEL 2 builder — one turn's internals.
 *
 * Pure: no DB, no IO, no clock. It receives the WHOLE conversation's rows
 * and slices the turn itself, because "which rows belong to this turn" is
 * logic worth testing, not a query detail — and because the slice needs
 * the rows OUTSIDE the turn to know where the turn ends.
 *
 * ## What a turn is
 *
 * The user prompt plus every descendant of it through `parentMessageId`,
 * stopping at the next `user` row (which starts the NEXT turn). Non-user,
 * non-assistant rows (`extension`, `preprocess-result`,
 * `capability-event`, `ez-action-result`) are turn MEMBERS — they bound the
 * window and can anchor a spawn — but they do not become nodes.
 *
 * ## Reconstruction order
 *
 * Per assistant message: `thinking` (at most one — `messages.thinkingContent`
 * is a single concatenated blob, block interleaving is not persisted), then
 * the tool calls in `createdAt` order, then the assistant text.
 *
 * DELIBERATE DIVERGENCE, flagged rather than hidden: the transcript's
 * `buildHistoricalBlocks` (`web/src/lib/content-blocks.ts`) reconstructs
 * thinking → TEXT → tools. That order exists so the transcript can print
 * the prose above the tool cards; it is not a claim about execution order,
 * and it cannot be used here because the wire contract makes `assistant`
 * the level-2 TERMINAL node. This builder keeps the shared half (thinking
 * first, tool calls in `createdAt` order) and puts the assistant text last,
 * where the graph needs it.
 *
 * ## Branches inside a turn
 *
 * An A-B retry re-runs the SAME user row (`/messages/:mid/retry` creates
 * no duplicate user message), so one turn can own two SIBLING assistant
 * messages. Each assistant group is therefore linked to whatever node its
 * message's parent resolves to, not to "the previous group" — siblings
 * fan out from the prompt as `branch` edges instead of being chained into
 * a false sequence.
 */

import { truncateLabel } from "./labels";
import { byCreatedAtThenId, toMs } from "./order";
import type { ChatGraph, GraphEdge, GraphNode, GraphNodeStatus } from "./types";

export interface TurnDagMessage {
  id: string;
  role: string;
  content: string;
  thinkingContent: string | null;
  parentMessageId: string | null;
  createdAt: string;
}

export interface TurnDagToolCall {
  id: string;
  /** The assistant message this call was anchored to at turn end. */
  messageId: string | null;
  toolName: string;
  extensionId: string;
  status: GraphNodeStatus;
  /** `0` means UNKNOWN, never "instant" — see the duration rules below. */
  durationMs: number;
  createdAt: string;
}

export interface TurnDagSubConversation {
  id: string;
  agentName: string | null;
  parentMessageId: string | null;
}

export interface TurnDagObservabilityEvent {
  id: string;
  eventType: string;
  messageId: string | null;
  data: Record<string, unknown>;
  durationMs: number | null;
  createdAt: string;
}

export interface TurnDagInput {
  conversationId: string;
  /** The turn's user `messages.id`. */
  turnMessageId: string;
  /** EVERY message of the conversation — the builder slices the turn. */
  messages: TurnDagMessage[];
  toolCalls: TurnDagToolCall[];
  subConversations: TurnDagSubConversation[];
  observability: TurnDagObservabilityEvent[];
}

const UNNAMED_AGENT = "sub-agent";
/** Fallback when a `run_error` row carries no readable message. */
const UNKNOWN_ERROR = "Run failed";

/** Observability event types that carry a real per-tool-call duration. */
const TOOL_EVENT_TYPES = new Set(["tool_call", "tool_error"]);

/**
 * A duration is only reported when it is CONFIDENTLY known. Both sources
 * encode "unknown" as a falsy value — built-in tools persist
 * `tool_calls.duration_ms = 0` unconditionally
 * (`src/runtime/stream-chat/subscribe-bridge.ts`), and an observability row
 * may carry `null` — and the contract is explicit that the UI must render an
 * em dash rather than "0ms". One predicate, applied to both.
 */
function knownDuration(ms: number | null | undefined): number | undefined {
  return ms ? ms : undefined;
}

/**
 * The positional observability match, exactly as specified at the bottom of
 * `types.ts`: bucket both lists by `toolName`, preserve order within each
 * bucket, zip by index. Positional, not authoritative — correct whenever
 * the two sources agree on per-name call order within the turn, and
 * degrading to "unknown" rather than to a wrong number when they don't.
 *
 * Both inputs MUST already be sorted `createdAt` ASC then `id` ASC.
 */
function matchObservabilityDurations(
  calls: TurnDagToolCall[],
  events: TurnDagObservabilityEvent[],
): Map<string, number> {
  const eventsByName = new Map<string, TurnDagObservabilityEvent[]>();
  for (const ev of events) {
    const name = ev.data["toolName"];
    if (typeof name !== "string") continue;
    const bucket = eventsByName.get(name);
    if (bucket) bucket.push(ev);
    else eventsByName.set(name, [ev]);
  }

  const matched = new Map<string, number>();
  const seenPerName = new Map<string, number>();
  for (const call of calls) {
    const index = seenPerName.get(call.toolName) ?? 0;
    seenPerName.set(call.toolName, index + 1);
    const duration = knownDuration(eventsByName.get(call.toolName)?.[index]?.durationMs);
    if (duration !== undefined) matched.set(call.id, duration);
  }
  return matched;
}

export function buildTurnDag(input: TurnDagInput): ChatGraph | null {
  const messageById = new Map(input.messages.map((m) => [m.id, m]));
  const prompt = messageById.get(input.turnMessageId);
  // A turn id that is unknown, or that names a non-user row, is not a turn
  // — the route maps `null` to 404 so a foreign id cannot be probed.
  if (!prompt || prompt.role !== "user") return null;

  // ── Slice the turn ───────────────────────────────────────────────
  const childrenByParent = new Map<string, TurnDagMessage[]>();
  for (const m of [...input.messages].sort(byCreatedAtThenId)) {
    if (m.parentMessageId === null) continue;
    const bucket = childrenByParent.get(m.parentMessageId);
    if (bucket) bucket.push(m);
    else childrenByParent.set(m.parentMessageId, [m]);
  }

  const turnIds = new Set<string>([prompt.id]);
  const assistants: TurnDagMessage[] = [];
  const queue: TurnDagMessage[] = [prompt];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const child of childrenByParent.get(cur.id) ?? []) {
      // The next user row starts the next turn; `turnIds` also guards a
      // corrupt parent cycle from looping forever.
      if (child.role === "user" || turnIds.has(child.id)) continue;
      turnIds.add(child.id);
      if (child.role === "assistant") assistants.push(child);
      queue.push(child);
    }
  }
  assistants.sort(byCreatedAtThenId);

  // ── The turn's [start, end) window ───────────────────────────────
  // End at the FIRST row after the prompt that is not part of this turn —
  // for an A-B retry that is the sibling branch, which is exactly where
  // this turn's observability trail stops being attributable to it. No
  // such row ⇒ the turn is the tail of the conversation and the window is
  // open-ended.
  const startMs = toMs(prompt.createdAt);
  let endMs = Number.POSITIVE_INFINITY;
  for (const m of input.messages) {
    if (turnIds.has(m.id)) continue;
    const ms = toMs(m.createdAt);
    if (ms > startMs && ms < endMs) endMs = ms;
  }
  const inWindow = (iso: string): boolean => {
    const ms = toMs(iso);
    return ms >= startMs && ms < endMs;
  };

  // ── Tool calls + their durations ─────────────────────────────────
  const turnCalls = input.toolCalls
    .filter((tc) => tc.messageId !== null && turnIds.has(tc.messageId))
    .sort(byCreatedAtThenId);
  const windowToolEvents = input.observability
    .filter((ev) => TOOL_EVENT_TYPES.has(ev.eventType) && inWindow(ev.createdAt))
    .sort(byCreatedAtThenId);
  const obsDurations = matchObservabilityDurations(turnCalls, windowToolEvents);

  const callsByMessage = new Map<string, TurnDagToolCall[]>();
  for (const tc of turnCalls) {
    const bucket = callsByMessage.get(tc.messageId!);
    if (bucket) bucket.push(tc);
    else callsByMessage.set(tc.messageId!, [tc]);
  }

  // `turn_summary` rows DO carry `messageId`, so the assistant node's
  // duration is a keyed join, not the positional fallback the tool nodes need.
  const turnDurationByMessage = new Map<string, number>();
  for (const ev of input.observability) {
    if (ev.eventType !== "turn_summary" || ev.messageId === null) continue;
    const duration = knownDuration(ev.durationMs);
    if (duration !== undefined) turnDurationByMessage.set(ev.messageId, duration);
  }

  // ── Nodes + sequence edges ───────────────────────────────────────
  const nodes: GraphNode[] = [
    {
      ...truncateLabel(prompt.content),
      id: prompt.id,
      kind: "prompt",
      status: "success",
      createdAt: prompt.createdAt,
      // NOT drillable: on level 2 the prompt IS the root — there is
      // nowhere deeper to go.
    },
  ];
  const edges: GraphEdge[] = [];
  /** Node ids in reconstruction order — the axis error nodes attach to. */
  const chain: GraphNode[] = [nodes[0]!];
  const assistantIds = new Set(assistants.map((a) => a.id));

  /**
   * The node an assistant group hangs off: the nearest ancestor that is
   * either the prompt or another assistant message, skipping the synthetic
   * rows in between. Every turn message descends from the prompt, so the
   * walk terminates there.
   */
  const anchorOf = (message: TurnDagMessage): string => {
    let cur = message.parentMessageId;
    const seen = new Set<string>();
    while (cur !== null && !seen.has(cur) && cur !== prompt.id && !assistantIds.has(cur)) {
      seen.add(cur);
      cur = messageById.get(cur)?.parentMessageId ?? null;
    }
    return cur ?? prompt.id;
  };

  const anchors = new Map<string, string>();
  const anchorFanout = new Map<string, number>();
  for (const assistant of assistants) {
    const anchor = anchorOf(assistant);
    anchors.set(assistant.id, anchor);
    anchorFanout.set(anchor, (anchorFanout.get(anchor) ?? 0) + 1);
  }

  for (const assistant of assistants) {
    const group: GraphNode[] = [];
    const thinking = assistant.thinkingContent?.trim();
    if (thinking) {
      group.push({
        ...truncateLabel(thinking),
        id: `thinking:${assistant.id}`,
        kind: "thinking",
        status: "success",
        // The blob is persisted on the assistant row and carries no
        // timestamp of its own; the row's is the only truthful one.
        createdAt: assistant.createdAt,
      });
    }
    for (const call of callsByMessage.get(assistant.id) ?? []) {
      const duration = knownDuration(call.durationMs) ?? obsDurations.get(call.id);
      group.push({
        ...truncateLabel(call.toolName),
        id: call.id,
        kind: "tool",
        status: call.status,
        createdAt: call.createdAt,
        extensionId: call.extensionId,
        ...(duration !== undefined ? { durationMs: duration } : {}),
      });
    }
    const turnDuration = turnDurationByMessage.get(assistant.id);
    group.push({
      ...truncateLabel(assistant.content),
      id: assistant.id,
      kind: "assistant",
      status: "success",
      createdAt: assistant.createdAt,
      ...(turnDuration !== undefined ? { durationMs: turnDuration } : {}),
    });

    const anchor = anchors.get(assistant.id)!;
    edges.push({
      from: anchor,
      to: group[0]!.id,
      // Sibling assistant messages under one anchor are an A-B retry —
      // the same fork semantics level 1 renders.
      kind: anchorFanout.get(anchor)! > 1 ? "branch" : "sequence",
    });
    for (let i = 1; i < group.length; i++) {
      edges.push({ from: group[i - 1]!.id, to: group[i]!.id, kind: "sequence" });
    }
    nodes.push(...group);
    chain.push(...group);
  }

  // ── Sub-agent spawns ─────────────────────────────────────────────
  const nodeIds = new Set(nodes.map((n) => n.id));
  const failedSubConversations = new Set<string>();
  for (const ev of input.observability) {
    if (ev.eventType !== "agent_error") continue;
    const id = ev.data["subConversationId"];
    if (typeof id === "string") failedSubConversations.add(id);
  }

  for (const sub of input.subConversations) {
    if (sub.parentMessageId === null || !turnIds.has(sub.parentMessageId)) continue;
    const spawner = messageById.get(sub.parentMessageId)!;
    nodes.push({
      ...truncateLabel(sub.agentName ?? UNNAMED_AGENT),
      id: sub.id,
      kind: "subagent",
      status: failedSubConversations.has(sub.id) ? "error" : "success",
      createdAt: spawner.createdAt,
      drillable: true,
      subConversationId: sub.id,
    });
    // A spawn anchored to a synthetic row (which never became a node)
    // falls back to the prompt so the edge still lands somewhere real.
    edges.push({
      from: nodeIds.has(sub.parentMessageId) ? sub.parentMessageId : prompt.id,
      to: sub.id,
      kind: "spawn",
    });
  }

  // ── Run errors ───────────────────────────────────────────────────
  // `run_error` rows carry no `messageId` (see `src/observability/collector.ts`),
  // so they attach to the LAST node of the reconstruction chain that had
  // already happened when the error was written — which is the prompt
  // itself for a run that died before producing anything.
  for (const ev of input.observability) {
    if (ev.eventType !== "run_error" || !inWindow(ev.createdAt)) continue;
    const errMs = toMs(ev.createdAt);
    let from = prompt.id;
    for (const node of chain) {
      if (toMs(node.createdAt) <= errMs) from = node.id;
    }
    const message = ev.data["error"];
    nodes.push({
      ...truncateLabel(typeof message === "string" && message.length > 0 ? message : UNKNOWN_ERROR),
      id: `error:${ev.id}`,
      kind: "error",
      status: "error",
      createdAt: ev.createdAt,
    });
    edges.push({ from, to: `error:${ev.id}`, kind: "sequence" });
  }

  return {
    level: 2,
    rootId: prompt.id,
    conversationId: input.conversationId,
    nodes,
    edges,
  };
}
