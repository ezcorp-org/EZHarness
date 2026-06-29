/**
 * Phase 48 — Host-side wiring for the Ez concierge tool family.
 *
 * Mirrors the shape of `ask-user-host.ts` / `orchestration-host.ts`: the
 * `setup-tools.ts` call site is a one-liner gated on `convRecord.kind === 'ez'`.
 * This module is only invoked for Ez-mode turns; regular conversations
 * never see Ez tools at all.
 *
 * Why a dedicated host:
 *   - The seven Ez tools live in `src/runtime/tools/ez/*` as factory
 *     functions taking a per-turn context (`userId`, `conversationId`,
 *     `bus`). Wiring them inline in setup-tools.ts would balloon the
 *     already-dense tool-loading block.
 *   - Two of the seven (`fill_form`, `navigate_to`) are client-side and
 *     suspend on the `ez-client-tool-registry`. Hosting their
 *     registration here keeps the registry coupling local.
 *   - The Ez tools must reach `ctx.agentTools` BEFORE the executor's
 *     allowlist filter runs (executor.ts:432-435) — otherwise the
 *     `mode.allowedTools=[…seven…]` filter sees an empty intersection
 *     and strips everything. Centralizing the wire here makes the
 *     ordering invariant easy to audit.
 *
 * Thread-safety: nothing async-shared. Each call is per-turn and
 * mutates only the supplied `agentTools` array in place.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { EventBus } from "./events";
import type { AgentEvents } from "../types";
import type { BuiltinToolDef } from "./tools/types";
import { getEzToolDefs, EZ_TOOL_NAMES } from "./tools/ez";
import { logger } from "../logger";
const log = logger.child("ez-tools-host");

export interface WireEzToolsForTurnParams {
  /** Per-turn agentTools array (mutated in place — Ez tool defs are pushed). */
  agentTools: AgentTool[];
  /** Per-turn `BuiltinToolDef[]` map keyed by name. Ez defs are recorded here
   *  so subscribeBridge / permission middleware can look up category + cardType
   *  the same way they do for project-rooted built-in tools. */
  builtinToolDefsMap: Map<string, BuiltinToolDef>;
  conversationId: string;
  /** Acting user id — owns drafts, scopes find_agents queries. Required:
   *  the propose_* tools persist `ez_drafts` rows owned by this user; a
   *  missing userId would make the row unattributable and unfetchable
   *  by `getDraft(id, userId)`. */
  userId: string;
  /** Runtime bus for emitting `ez:client-tool` events on fill_form /
   *  navigate_to. May be omitted in tests that don't exercise the
   *  client-side path. */
  bus?: EventBus<AgentEvents>;
  /** Phase 48 fix: provider/model the user picked for THIS Ez turn,
   *  pulled from `streamChat`'s `options.provider` / `options.model`
   *  (with conversation-row fallback). Forwarded into
   *  `summarize_conversation` so the tool uses the same model the
   *  user sees in the chat — previously it always fell back to the
   *  Anthropic-first default tier and threw "no Anthropic credentials"
   *  when the user picked OpenAI. May be null/undefined when the
   *  caller has no per-turn or stored selection (rare; the default
   *  summarizer falls back to default-tier resolution in that case). */
  provider?: string | null;
  model?: string | null;
}

/**
 * Wire the seven Ez tools into the per-turn `agentTools` array.
 *
 * Idempotent guard: if any of the Ez tool names already exists in
 * agentTools (defensive — shouldn't happen given setup-tools' single
 * call site, but a future refactor that double-invokes us shouldn't
 * double-register), the duplicate is skipped. Mirrors ask-user-host's
 * dedup posture.
 *
 * The factory entry point is `getEzToolDefs(ctx)` from `tools/ez/index.ts`.
 * It returns BuiltinToolDef[]; here we wrap each into the AgentTool
 * shape pi-agent-core consumes (carrying through `name`, `label`,
 * `description`, `parameters`, `execute`).
 */
export function wireEzToolsForTurn(params: WireEzToolsForTurnParams): void {
  const { agentTools, builtinToolDefsMap, conversationId, userId, bus, provider, model } = params;

  const existingNames = new Set(agentTools.map((t) => t.name));
  const defs = getEzToolDefs({ userId, conversationId, bus, provider, model });

  let registered = 0;
  for (const def of defs) {
    if (existingNames.has(def.name)) continue;
    builtinToolDefsMap.set(def.name, def);
    agentTools.push({
      name: def.name,
      label: def.label,
      description: def.description,
      parameters: def.parameters,
      execute: def.execute,
    });
    registered++;
  }

  log.info("Ez tools wired for turn", {
    conversationId,
    userId,
    registered,
    expected: EZ_TOOL_NAMES.length,
  });
}
