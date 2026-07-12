/**
 * search_conversation Ez tool (SERVER-SIDE) — find where something was
 * discussed across the user's conversations.
 *
 * A thin wrapper over the shipped, tenant-safe `searchMessages()`
 * (src/db/queries/message-search.ts) run in KEYWORD (lexical FTS) mode:
 * keyword mode never touches the embedder, so it works with zero provider
 * config, and `searchMessages` already fails safe (returns [] on an empty
 * userId or a <2-char query). No new SQL — DRY over the Phase-65 search
 * heart.
 *
 * Tenancy: `scope: "all"` + the acting `userId` (threaded from the Ez turn)
 * means results are strictly the requesting user's conversations across
 * every project — the cross-user leak guard lives inside searchMessages.
 * The EZ conversation is pinned to `projectId: "global"`, so a project
 * scope would be useless here.
 *
 * `conversationId` narrows the hits POST-query (searchMessages has no
 * per-conversation scope and we deliberately add no SQL variant for v1).
 *
 * Determinism for tests: the search call is injected via `search` in the
 * context object (mirroring the summarize_conversation `summarize` seam) so
 * unit tests can stub it without seeding a DB. Production wiring uses the
 * default closure that calls `searchMessages` directly.
 */
import { Type } from "@earendil-works/pi-ai";
import type { BuiltinToolDef } from "../types";
import { searchMessages, type MessageSearchHit } from "../../../db/queries/message-search";

/** Default number of hits returned when the LLM doesn't specify a limit. */
const DEFAULT_LIMIT = 10;
/** Hard cap on hits — keeps the tool text bounded regardless of `limit`. */
const MAX_LIMIT = 20;

/** Params the injectable search seam receives — a focused view of the
 *  searchMessages contract (keyword mode, scope=all are fixed here). */
export interface SearchSeamParams {
  query: string;
  userId: string;
  limit: number;
}

export interface SearchConversationContext {
  /** Acting user id — scopes the search to this user's conversations. */
  userId: string;
  /** Pluggable search — replaced in tests with a deterministic stub.
   *  Receives the query + userId + limit and returns ranked hits. Mirrors
   *  the summarize_conversation `summarize` seam. */
  search?: (params: SearchSeamParams) => Promise<MessageSearchHit[]>;
}

/** Strip the ts_headline `<mark>`/`</mark>` wrappers to plain text so the
 *  snippet reads cleanly in the LLM-facing tool result. */
function stripMarks(s: string): string {
  return s.replace(/<\/?mark>/g, "");
}

/** Render the hits as LLM-friendly text: a numbered list of
 *  role + conversation title + id + timestamp + plain snippet, followed by
 *  a hint that the conversation ids feed summarize_conversation. */
function formatHits(query: string, hits: MessageSearchHit[]): string {
  const lines = hits.map((h, i) => {
    const when = h.createdAt.toISOString();
    const snippet = stripMarks(h.snippet ?? "").trim();
    return `${i + 1}. [${h.role}] "${h.conversationTitle}" (conversationId: ${h.conversationId}, ${when})\n   ${snippet}`;
  });
  const noun = hits.length === 1 ? "message" : "messages";
  return `Found ${hits.length} ${noun} matching "${query}":\n\n${lines.join("\n\n")}\n\nUse summarize_conversation with one of these conversationIds (and an optional question) to dig deeper.`;
}

export function createSearchConversationTool(ctx: SearchConversationContext): BuiltinToolDef {
  // Bind the default keyword-mode search so the execute body's `search(...)`
  // call site doesn't know about searchMessages' wider contract. Test stubs
  // replace this entirely.
  const search: NonNullable<SearchConversationContext["search"]> =
    ctx.search ?? ((p) => searchMessages({ query: p.query, mode: "keyword", queryEmbedding: null, userId: p.userId, scope: "all", limit: p.limit }));
  return {
    name: "search_conversation",
    label: "search_conversation",
    description:
      "Find where something was discussed across the user's conversations. Keyword search over every conversation the user owns; returns matching message snippets with each hit's conversation title, id, role, and timestamp. Feed a returned conversationId into summarize_conversation (optionally with a question) to dig into that conversation. Pass an optional conversationId to narrow to one conversation, and an optional limit (default 10, max 20).",
    category: "ez",
    cardType: "default",
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, description: "What to search for (keyword / phrase)." },
        conversationId: { type: "string", description: "Optional. Narrow results to a single conversation id." },
        limit: { type: "number", description: "Optional. Max hits to return (default 10, max 20)." },
      },
      required: ["query"],
    }),
    execute: async (_toolCallId, params: any) => {
      try {
        const query = typeof params?.query === "string" ? params.query.trim() : "";
        if (!query) {
          return { content: [{ type: "text" as const, text: "Error: query is required" }], details: { isError: true } };
        }
        const conversationId = typeof params?.conversationId === "string" ? params.conversationId.trim() : "";
        const rawLimit =
          typeof params?.limit === "number" && Number.isFinite(params.limit) ? Math.floor(params.limit) : DEFAULT_LIMIT;
        const limit = Math.max(1, Math.min(rawLimit, MAX_LIMIT));

        // When narrowing to one conversation we over-fetch (to the cap) so the
        // post-query filter still has room to fill `limit` from that
        // conversation's hits; otherwise fetch exactly `limit`.
        const fetchLimit = conversationId ? MAX_LIMIT : limit;
        let hits = await search({ query, userId: ctx.userId, limit: fetchLimit });
        if (conversationId) {
          hits = hits.filter((h) => h.conversationId === conversationId).slice(0, limit);
        }

        if (hits.length === 0) {
          const scopeNote = conversationId ? ` in conversation ${conversationId}` : "";
          return {
            content: [{ type: "text" as const, text: `No messages matching "${query}"${scopeNote} were found.` }],
            details: { query, conversationId: conversationId || undefined, count: 0 },
          };
        }

        return {
          content: [{ type: "text" as const, text: formatHits(query, hits) }],
          details: { query, conversationId: conversationId || undefined, count: hits.length },
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], details: { isError: true } };
      }
    },
  };
}
