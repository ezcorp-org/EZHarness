/**
 * Phase 48 Wave 2 — Ez concierge tool barrel + registration.
 *
 * Exports:
 *   - One factory per tool (5 server-side + 2 client-side stubs).
 *   - `getEzToolDefs(ctx)` — returns the full BuiltinToolDef[] for an Ez
 *     turn. Called from setup-tools when the Ez mode is active.
 *   - `getEzToolMetadata()` — schema-only listing for `/api/tools` and
 *     similar discovery surfaces. The metadata is independent of any
 *     per-turn context (no userId/conversationId/bus wiring needed).
 *   - `EZ_TOOL_NAMES` — the exact set of names that the seeded Ez mode's
 *     `allowed_tools` array references. Useful for tests and migration
 *     consistency checks.
 *
 * The Ez tools are intentionally NOT loaded into `getBuiltinToolDefs()`
 * (the project-tool path) because they don't need a project root and
 * carry per-user context that would leak across project switches if
 * cached. Wave 2 ships the factory + metadata; Wave 3 wires the
 * runtime hook in setup-tools.ts.
 */
import type { BuiltinToolDef } from "../types";
import type { EventBus } from "../../events";
import type { AgentEvents } from "../../../types";
import type { BuiltInToolMeta } from "../builtin-registry";
import { createProposeCreateProjectTool } from "./propose-create-project";
import { createProposeCreateAgentTool } from "./propose-create-agent";
import { createProposeInstallExtensionTool } from "./propose-install-extension";
import { createSummarizeConversationTool, type SummarizeContext } from "./summarize-conversation";
import { createFindAgentsTool } from "./find-agents";
import { createFillFormTool } from "./fill-form";
import { createNavigateToTool } from "./navigate-to";

export {
  createProposeCreateProjectTool,
  createProposeCreateAgentTool,
  createProposeInstallExtensionTool,
  createSummarizeConversationTool,
  createFindAgentsTool,
  createFillFormTool,
  createNavigateToTool,
};
export { EZ_CLIENT_TOOL_DEFERRED_MARKER } from "./fill-form";
export { isValidInAppPath } from "./navigate-to";

/** Exact set of tool names seeded into the Ez mode's allowlist. */
export const EZ_TOOL_NAMES = [
  "propose_create_project",
  "propose_create_agent",
  "propose_install_extension",
  "summarize_conversation",
  "find_agents",
  "fill_form",
  "navigate_to",
] as const;

export type EzToolName = (typeof EZ_TOOL_NAMES)[number];

export interface EzToolFactoryContext {
  /** Acting user id — owns drafts, scopes agent search. */
  userId: string;
  /** Conversation id — required for client-side tool event routing. */
  conversationId: string;
  /** Runtime bus for emitting `ez:client-tool` events. */
  bus?: EventBus<AgentEvents>;
  /** Optional summarizer override for tests. */
  summarize?: SummarizeContext["summarize"];
  /** Phase 48 fix: per-turn provider/model picked by the user.
   *  Forwarded into the summarize_conversation tool so it uses the
   *  SAME model as the surrounding Ez conversation, instead of
   *  always resolving to the default tier (which is Anthropic-first
   *  and breaks when the user picked OpenAI). */
  provider?: string | null;
  model?: string | null;
  /** Phase 48 defense-in-depth: default conversation id for the
   *  `summarize_conversation` tool. Wired from the page-context block's
   *  `route.conversationId` so the LLM's "summarize this" turn works
   *  even when it fails to extract the id from JSON-in-system-prompt.
   *  Distinct from `conversationId` (which is the Ez-mode chat id used
   *  for client-tool event routing) — `defaultConversationId` is the
   *  conversation the user is currently *viewing*, which may or may
   *  not be the same as the Ez conversation they're chatting in. */
  defaultConversationId?: string;
}

/**
 * Build the full set of Ez tool defs for a single Ez-mode turn. The
 * caller is responsible for filtering against the active mode's
 * allowedTools — but in practice the seeded Ez mode allows all seven,
 * so this is a 1:1 list. Order matches EZ_TOOL_NAMES.
 */
export function getEzToolDefs(ctx: EzToolFactoryContext): BuiltinToolDef[] {
  const userCtx = { userId: ctx.userId };
  const clientCtx = { conversationId: ctx.conversationId, bus: ctx.bus };
  return [
    createProposeCreateProjectTool(userCtx),
    createProposeCreateAgentTool(userCtx),
    createProposeInstallExtensionTool(userCtx),
    createSummarizeConversationTool({
      summarize: ctx.summarize,
      provider: ctx.provider,
      model: ctx.model,
      defaultConversationId: ctx.defaultConversationId,
    }),
    createFindAgentsTool(userCtx),
    createFillFormTool(clientCtx),
    createNavigateToTool(clientCtx),
  ];
}

/**
 * Schema-only metadata for the `/api/tools` listing endpoint. No
 * per-user state — the listing surface only needs the static fields.
 * The execute handler is omitted because callers of this metadata path
 * never run the tool (they list, not invoke).
 */
export function getEzToolMetadata(): BuiltInToolMeta[] {
  // Use a sentinel context so we can pull description + parameters off
  // each factory output. The execute body is never called from this path.
  const sentinelUser = { userId: "" };
  const sentinelClient = { conversationId: "", bus: undefined };
  const defs: BuiltinToolDef[] = [
    createProposeCreateProjectTool(sentinelUser),
    createProposeCreateAgentTool(sentinelUser),
    createProposeInstallExtensionTool(sentinelUser),
    createSummarizeConversationTool({}),
    createFindAgentsTool(sentinelUser),
    createFillFormTool(sentinelClient),
    createNavigateToTool(sentinelClient),
  ];
  return defs.map((d) => ({
    name: d.name,
    description: d.description,
    category: "ez",
    inputSchema: (d.parameters as unknown) as Record<string, unknown>,
    mentionable: false,
  }));
}

/**
 * Convenience helper for tests / static checks: returns true iff the
 * named tool is one of the seven Ez tools and is flagged client-side.
 * Server-side tools (propose_*, summarize_conversation, find_agents)
 * return false. Useful for asserting the runtime routes correctly.
 */
export function isEzClientTool(name: string): boolean {
  return name === "fill_form" || name === "navigate_to";
}
