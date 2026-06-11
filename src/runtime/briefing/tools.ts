/**
 * Daily Briefing — the briefing agent's internal read tools (spec §5.2).
 *
 * Three host-side tools, wired per-turn from setup-tools.ts for any
 * conversation attached to the system "Daily Briefing" agent config
 * (the scheduled run AND the user's follow-up turns):
 *
 *   - `list_recent_conversations` — thin wrapper over
 *     `listRecentConversationsForUser` (excludes kind='ez',
 *     sub-conversations, test rows, and prior briefings — locked
 *     decision §6.6).
 *   - `get_conversation_summary` — last-N-messages transcript fetch.
 *     "Summary uses the run's own model" (spec): the tool returns the
 *     raw transcript; the briefing run's LLM does the summarizing — no
 *     extra LLM infra.
 *   - `get_task_snapshots` — wrapper over
 *     `getTaskSnapshotForConversation` (task-tracking-host) for a set
 *     of conversations. Degrades to a one-line "unavailable" result
 *     when the task-tracking extension isn't installed (spec §8 —
 *     never errored into the user's face).
 *
 * Security: every conversation read is ownership-gated against the
 * briefing user's id (spec §6.7 — per-user identity end-to-end). A
 * non-owned id returns "not found" (no existence oracle).
 *
 * Wiring mirrors ez-tools-host.ts: pure in-place push onto the
 * per-turn agentTools array, dedup by name, fail-soft at the call
 * site in setup-tools.ts.
 */
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { BuiltinToolDef } from "../tools/types";
import {
  getConversation,
  getMessages,
  listRecentConversationsForUser,
} from "../../db/queries/conversations";
import { logger } from "../../logger";

const log = logger.child("briefing.tools");

export const BRIEFING_TOOL_NAMES = [
  "list_recent_conversations",
  "get_conversation_summary",
  "get_task_snapshots",
] as const;

const DEFAULT_LIST_LIMIT = 10;
const MAX_LIST_LIMIT = 25;
const DEFAULT_SUMMARY_MESSAGES = 20;
const MAX_SUMMARY_MESSAGES = 50;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_TRANSCRIPT_CHARS = 24_000;
const MAX_SNAPSHOT_CONVERSATIONS = 25;

export interface BriefingToolContext {
  /** Owning user — every read is scoped to this id. */
  userId: string;
  /** The briefing conversation the turn runs in (excluded from lists). */
  conversationId: string;
  /** The shared briefing agent's id — prior briefings are filtered by it. */
  briefingAgentConfigId: string | null;
}

function ok(result: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    details: result,
  };
}

function err(text: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${text}` }],
    details: { isError: true },
  };
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : fallback;
  return Math.max(min, Math.min(max, n));
}

export function createListRecentConversationsTool(ctx: BriefingToolContext): BuiltinToolDef {
  return {
    name: "list_recent_conversations",
    label: "list_recent_conversations",
    description:
      "List the user's most recent conversations (all projects, newest first). Excludes prior briefings and system threads. Use the returned ids with get_conversation_summary / get_task_snapshots.",
    category: "read",
    cardType: "default",
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: `How many conversations to return (1-${MAX_LIST_LIMIT}, default ${DEFAULT_LIST_LIMIT}).`,
        },
      },
    }),
    execute: async (_toolCallId, params: unknown) => {
      try {
        const p = (params ?? {}) as Record<string, unknown>;
        const limit = clampInt(p.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
        const rows = await listRecentConversationsForUser(ctx.userId, {
          excludeAgentConfigId: ctx.briefingAgentConfigId,
          excludeConversationId: ctx.conversationId,
          limit,
        });
        return ok({
          count: rows.length,
          conversations: rows.map((c) => ({
            id: c.id,
            title: c.title,
            projectId: c.projectId,
            updatedAt: c.updatedAt instanceof Date ? c.updatedAt.toISOString() : c.updatedAt,
          })),
        });
      } catch (e) {
        return err((e as Error)?.message ?? String(e));
      }
    },
  };
}

export function createGetConversationSummaryTool(ctx: BriefingToolContext): BuiltinToolDef {
  return {
    name: "get_conversation_summary",
    label: "get_conversation_summary",
    description:
      "Fetch the last messages of one of the user's conversations as a transcript so you can summarize what was happening and where it stopped. Only the user's own conversations are readable.",
    category: "read",
    cardType: "default",
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        conversationId: { type: "string", description: "Conversation id from list_recent_conversations." },
        maxMessages: {
          type: "number",
          description: `How many trailing messages to include (1-${MAX_SUMMARY_MESSAGES}, default ${DEFAULT_SUMMARY_MESSAGES}).`,
        },
      },
      required: ["conversationId"],
    }),
    execute: async (_toolCallId, params: unknown) => {
      try {
        const p = (params ?? {}) as Record<string, unknown>;
        const conversationId = typeof p.conversationId === "string" ? p.conversationId : "";
        if (!conversationId) return err("conversationId is required");
        const maxMessages = clampInt(p.maxMessages, DEFAULT_SUMMARY_MESSAGES, 1, MAX_SUMMARY_MESSAGES);

        const conv = await getConversation(conversationId);
        // Ownership gate — a non-owned id is indistinguishable from a
        // missing one (no existence oracle).
        if (!conv || conv.userId !== ctx.userId) return err("conversation not found");

        const all = await getMessages(conversationId);
        const turns = all.filter(
          (m) => (m.role === "user" || m.role === "assistant") && m.content.trim().length > 0,
        );
        const recent = turns.slice(-maxMessages);
        const lines = recent.map((m) => {
          const text = m.content.length > MAX_MESSAGE_CHARS
            ? `${m.content.slice(0, MAX_MESSAGE_CHARS)}…`
            : m.content;
          return `${m.role.toUpperCase()}: ${text}`;
        });
        let transcript = lines.join("\n\n");
        if (transcript.length > MAX_TRANSCRIPT_CHARS) {
          // Keep the END of the conversation — that's where it stopped.
          transcript = `…${transcript.slice(-MAX_TRANSCRIPT_CHARS)}`;
        }
        return ok({
          id: conv.id,
          title: conv.title,
          updatedAt: conv.updatedAt instanceof Date ? conv.updatedAt.toISOString() : conv.updatedAt,
          messageCount: turns.length,
          transcript,
        });
      } catch (e) {
        return err((e as Error)?.message ?? String(e));
      }
    },
  };
}

export function createGetTaskSnapshotsTool(ctx: BriefingToolContext): BuiltinToolDef {
  return {
    name: "get_task_snapshots",
    label: "get_task_snapshots",
    description:
      "Read the tracked-task state for a set of the user's conversations (open/active/completed tasks with titles). Pass conversation ids from list_recent_conversations.",
    category: "read",
    cardType: "default",
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        conversationIds: {
          type: "array",
          items: { type: "string" },
          description: `Conversation ids to inspect (max ${MAX_SNAPSHOT_CONVERSATIONS}).`,
        },
      },
      required: ["conversationIds"],
    }),
    execute: async (_toolCallId, params: unknown) => {
      try {
        const p = (params ?? {}) as Record<string, unknown>;
        const idsRaw = Array.isArray(p.conversationIds) ? p.conversationIds : null;
        if (!idsRaw || idsRaw.length === 0) return err("conversationIds is required");
        const ids = [...new Set(idsRaw.filter((v): v is string => typeof v === "string" && v.length > 0))]
          .slice(0, MAX_SNAPSHOT_CONVERSATIONS);
        if (ids.length === 0) return err("conversationIds is required");

        // Lazy import: the task-tracking host throws when the bundled
        // extension was never installed — degrade to a one-line note
        // instead of erroring the briefing (spec §8).
        let getSnapshot: typeof import("../task-tracking-host").getTaskSnapshotForConversation;
        try {
          ({ getTaskSnapshotForConversation: getSnapshot } = await import("../task-tracking-host"));
        } catch (e) {
          log.warn("task-tracking host unavailable", { error: String(e) });
          return ok({ unavailable: true, note: "Task tracking is unavailable on this host." });
        }

        const snapshots: Array<{
          conversationId: string;
          title: string;
          tasks: Array<{ id: string; title: string; status: string }>;
        }> = [];
        let openCount = 0;
        let activeCount = 0;

        for (const id of ids) {
          const conv = await getConversation(id);
          if (!conv || conv.userId !== ctx.userId) continue; // silent skip — no oracle
          let snap;
          try {
            snap = await getSnapshot(id);
          } catch (e) {
            // Extension not installed / storage unavailable — degrade.
            log.warn("task snapshot read failed", { conversationId: id, error: String(e) });
            return ok({ unavailable: true, note: "Task tracking is unavailable on this host." });
          }
          if (!snap || snap.tasks.length === 0) continue;
          const tasks = snap.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status }));
          openCount += tasks.filter((t) => t.status === "pending").length;
          activeCount += tasks.filter((t) => t.status === "active").length;
          snapshots.push({ conversationId: id, title: conv.title, tasks });
        }

        return ok({
          counts: { open: openCount, active: activeCount },
          conversations: snapshots,
        });
      } catch (e) {
        return err((e as Error)?.message ?? String(e));
      }
    },
  };
}

export interface WireBriefingToolsParams {
  /** Per-turn agentTools array (mutated in place). */
  agentTools: AgentTool[];
  /** Per-turn BuiltinToolDef map so the bridge/permission middleware can
   *  look up category + cardType (mirrors wireEzToolsForTurn). */
  builtinToolDefsMap?: Map<string, BuiltinToolDef>;
  conversationId: string;
  userId: string;
  briefingAgentConfigId: string | null;
}

/**
 * Wire the three briefing read tools into the per-turn agentTools
 * array. Dedup by name (defensive — mirrors ez-tools-host's posture).
 */
export function wireBriefingToolsForTurn(params: WireBriefingToolsParams): void {
  const { agentTools, builtinToolDefsMap, conversationId, userId, briefingAgentConfigId } = params;
  const ctx: BriefingToolContext = { userId, conversationId, briefingAgentConfigId };

  const defs: BuiltinToolDef[] = [
    createListRecentConversationsTool(ctx),
    createGetConversationSummaryTool(ctx),
    createGetTaskSnapshotsTool(ctx),
  ];

  const existingNames = new Set(agentTools.map((t) => t.name));
  let registered = 0;
  for (const def of defs) {
    if (existingNames.has(def.name)) continue;
    builtinToolDefsMap?.set(def.name, def);
    agentTools.push({
      name: def.name,
      label: def.label,
      description: def.description,
      parameters: def.parameters,
      execute: def.execute,
    });
    registered++;
  }

  log.info("briefing tools wired for turn", {
    conversationId,
    userId,
    registered,
    expected: BRIEFING_TOOL_NAMES.length,
  });
}
