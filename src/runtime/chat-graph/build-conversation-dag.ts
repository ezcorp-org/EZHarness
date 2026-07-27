/**
 * LEVEL 1 builder — the conversation map.
 *
 * Pure: no DB, no IO, no clock. `load.ts` owns every read and hands the
 * rows in; this module is a total function from rows to `ChatGraph` so the
 * whole branch/spawn algebra is unit-testable without a database.
 *
 * THREE sources are merged (plan §2b — an explicit product decision, not
 * an optimisation to collapse later):
 *
 *   1. `treeNodes` — the session tree (`computeSessionTree` shape) is the
 *      TOPOLOGY authority: it is what makes a rewind / A-B retry render as
 *      a real fork instead of a straight line. In degraded mode `load.ts`
 *      synthesizes the same shape from `messages.parentMessageId`, so this
 *      builder has exactly ONE code path either way.
 *   2. `messages` — the SUBSTANCE authority: prompt text for labels.
 *   3. `subConversations` — sub-agent spawns, hung off the turn whose
 *      message spawned them (`conversations.parentMessageId`).
 *
 * WHAT IS AND ISN'T A NODE: only `role === "user"` messages become nodes.
 * Assistant messages (and the synthetic roles — `extension`,
 * `preprocess-result`, `capability-event`, …) are NOT level-1 nodes; they
 * collapse into the edge between consecutive prompts. That collapse is
 * topology-preserving, not lossy: a prompt's parent is its NEAREST PROMPT
 * ANCESTOR through the tree, so two assistant siblings that each continue
 * into further prompts still yield two edges out of the shared parent —
 * a real fork — rather than being flattened into a chain.
 */

import { truncateLabel } from "./labels";
import { byCreatedAtThenId, toMs } from "./order";
import type { ChatGraph, GraphEdge, GraphNode, TurnStats } from "./types";

/** A session-tree node — the `computeSessionTree` (`SessionTreeNode`) shape. */
export interface ConversationTreeNode {
  id: string;
  parentId: string | null;
  role: string;
  /** Live exclude flag; excluded rows stay in the graph, greyed. */
  excluded: boolean;
  createdAt: string;
}

/** The substance half of a prompt node, joined to the tree by id. */
export interface ConversationDagMessage {
  id: string;
  role: string;
  content: string;
}

/** A spawned sub-conversation (`getMessagesWithToolCalls().subConversations`). */
export interface ConversationDagSubConversation {
  id: string;
  agentName: string | null;
  /** The message in the PARENT conversation that spawned this agent. */
  parentMessageId: string | null;
}

/**
 * Per-assistant-message activity, used to roll each turn's stats up onto its
 * prompt node. Supplied by `load.ts` from the same read that fetches the
 * messages — no extra query.
 */
export interface ConversationDagActivity {
  messageId: string;
  toolCalls: number;
  hasThinking: boolean;
}

export interface ConversationDagInput {
  conversationId: string;
  treeNodes: ConversationTreeNode[];
  messages: ConversationDagMessage[];
  subConversations: ConversationDagSubConversation[];
  /** Optional: absent means the roll-up is simply omitted, never zeroed. */
  activity?: ConversationDagActivity[];
  /** Set by `load.ts` when the topology is the flat `parentMessageId` chain. */
  degraded?: boolean;
}

/** Label for a sub-agent whose agent config was deleted or never named. */
const UNNAMED_AGENT = "sub-agent";

export function buildConversationDag(input: ConversationDagInput): ChatGraph {
  const messageById = new Map(input.messages.map((m) => [m.id, m]));
  const treeById = new Map(input.treeNodes.map((n) => [n.id, n]));
  const ordered = [...input.treeNodes].sort(byCreatedAtThenId);

  // Role comes from the LIVE message row when we have it (the session tree
  // snapshots role at append time and is not reconciled on same-id updates
  // — see the session-sync header), falling back to the tree's copy for a
  // node whose row didn't come back in the same read.
  const roleOf = (id: string): string | undefined => messageById.get(id)?.role ?? treeById.get(id)?.role;

  const activityById = new Map((input.activity ?? []).map((a) => [a.messageId, a]));
  const childrenByParent = new Map<string, ConversationTreeNode[]>();
  for (const n of ordered) {
    if (n.parentId === null) continue;
    const bucket = childrenByParent.get(n.parentId);
    if (bucket) bucket.push(n);
    else childrenByParent.set(n.parentId, [n]);
  }

  /**
   * Members of one turn: everything reachable below the prompt WITHOUT
   * crossing into the next user row. Mirrors the level-2 builder's slicing so
   * the counts shown here always match what drilling in renders. `seen` also
   * bounds a corrupt parent cycle.
   */
  function turnMembers(promptId: string): ConversationTreeNode[] {
    const members: ConversationTreeNode[] = [];
    const seen = new Set<string>([promptId]);
    const queue = [promptId];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const child of childrenByParent.get(cur) ?? []) {
        if (seen.has(child.id) || roleOf(child.id) === "user") continue;
        seen.add(child.id);
        members.push(child);
        queue.push(child.id);
      }
    }
    return members;
  }

  const subsByParent = new Map<string, number>();
  for (const sub of input.subConversations) {
    if (sub.parentMessageId === null) continue;
    subsByParent.set(sub.parentMessageId, (subsByParent.get(sub.parentMessageId) ?? 0) + 1);
  }

  const nodes: GraphNode[] = [];
  const promptIds = new Set<string>();
  for (const n of ordered) {
    if (roleOf(n.id) !== "user") continue;
    promptIds.add(n.id);
    const members = turnMembers(n.id);
    const assistants = members.filter((m) => roleOf(m.id) === "assistant");
    const stats: TurnStats = {
      replies: assistants.length,
      toolCalls: members.reduce((sum, m) => sum + (activityById.get(m.id)?.toolCalls ?? 0), 0),
      subAgents: members.reduce((sum, m) => sum + (subsByParent.get(m.id) ?? 0), 0) +
        (subsByParent.get(n.id) ?? 0),
      thinking: members.filter((m) => activityById.get(m.id)?.hasThinking === true).length,
    };
    // Elapsed SPAN of the turn, not a sum of tool durations. Omitted when the
    // turn has no members, or when the clock did not advance — a zero here
    // would read as "instant" when it really means "unknown".
    const lastAt = members.reduce((max, m) => Math.max(max, toMs(m.createdAt)), Number.NEGATIVE_INFINITY);
    const span = lastAt - toMs(n.createdAt);
    nodes.push({
      ...truncateLabel(messageById.get(n.id)?.content ?? ""),
      id: n.id,
      kind: "prompt",
      status: "success",
      createdAt: n.createdAt,
      // Drilling a prompt into its turn is the headline interaction, so
      // EVERY prompt node is drillable — no conditional.
      drillable: true,
      ...(Number.isFinite(span) && span > 0 ? { durationMs: span } : {}),
      stats,
      ...(n.excluded ? { excluded: true } : {}),
    });
  }

  /**
   * Nearest prompt at-or-above `id`, walking the tree's parent pointers.
   * Only ids that are actual prompt NODES are returned, so an edge can
   * never dangle. `seen` bounds a corrupt parent cycle.
   */
  const nearestPrompt = (id: string | null): string | null => {
    let cur = id;
    const seen = new Set<string>();
    while (cur !== null && !seen.has(cur)) {
      if (promptIds.has(cur)) return cur;
      seen.add(cur);
      cur = treeById.get(cur)?.parentId ?? null;
    }
    return null;
  };

  // Two passes so an edge knows whether its PARENT forked before it is
  // emitted: every edge out of a multi-child prompt is a `branch` (both
  // legs — the surviving one and the rewound-away one), a lone child is
  // ordinary `sequence` flow.
  const parentOf = new Map<string, string>();
  const childCount = new Map<string, number>();
  for (const id of promptIds) {
    const parent = nearestPrompt(treeById.get(id)?.parentId ?? null);
    if (parent === null) continue; // a root prompt has no incoming edge
    parentOf.set(id, parent);
    childCount.set(parent, (childCount.get(parent) ?? 0) + 1);
  }

  const edges: GraphEdge[] = [];
  for (const id of promptIds) {
    const parent = parentOf.get(id);
    if (parent === undefined) continue;
    edges.push({ from: parent, to: id, kind: childCount.get(parent)! > 1 ? "branch" : "sequence" });
  }

  for (const sub of input.subConversations) {
    if (sub.parentMessageId === null) continue;
    const owner = nearestPrompt(sub.parentMessageId);
    // A spawn we cannot attribute to a turn is dropped rather than floated
    // as an orphan node: the graph is a reading aid, and a node with no
    // edge reads as a bug.
    if (owner === null) continue;
    nodes.push({
      ...truncateLabel(sub.agentName ?? UNNAMED_AGENT),
      id: sub.id,
      kind: "subagent",
      status: "success",
      // The spawning message's timestamp — a `SubConversationSummary`
      // carries none, and the spawn POINT is the right ordering axis here
      // anyway (the child's own history is a level of its own).
      createdAt: treeById.get(sub.parentMessageId)!.createdAt,
      drillable: true,
      subConversationId: sub.id,
    });
    edges.push({ from: owner, to: sub.id, kind: "spawn" });
  }

  return {
    level: 1,
    rootId: nodes.length > 0 ? input.conversationId : null,
    conversationId: input.conversationId,
    nodes,
    edges,
    ...(input.degraded ? { degraded: true } : {}),
  };
}
