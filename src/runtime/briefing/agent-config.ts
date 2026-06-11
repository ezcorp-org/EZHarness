/**
 * Daily Briefing — shared system agent config (spec §4.2).
 *
 * ONE `agent_configs` row serves every user's briefings (not
 * per-user): per-user steering is injected at run time via the
 * conversation's `systemPrompt` (createConversation opts), so the
 * shared row only carries the stable identity + base prompt. Created
 * idempotently at boot from the web layer's `ensureInitialized()`,
 * mirroring `ensureBundledExtensions()`; the run pipeline also calls
 * `ensureBriefingAgentConfig()` defensively per run (cheap once
 * cached).
 *
 * The row's `provider`/`model` default to the CURRENT_MODEL_SENTINEL
 * via `createAgentConfig` — instance default model resolution (locked
 * decision §7.3); per-user overrides ride on the conversation row.
 */
import {
  createAgentConfig,
  getAgentConfigByName,
  type DbAgentConfig,
} from "../../db/queries/agent-configs";

export const BRIEFING_AGENT_NAME = "Daily Briefing";

/** Base prompt for the shared agent row. The conversation-level system
 *  prompt (built per run in run.ts) carries the full section contract +
 *  the user's instructions; this base exists so the agent reads
 *  sensibly anywhere agent configs are listed. */
export const BRIEFING_AGENT_PROMPT = `You are the user's Daily Briefing agent. Each morning you mine the user's own conversations and tasks with your read tools, then deliver a short, actionable briefing as a conversation they can talk back to. Reference conversations by title, never by id. Offer to pick work back up — every line should be actionable.`;

const BRIEFING_AGENT_DESCRIPTION =
  "System agent that composes the scheduled Daily Briefing conversation from the user's recent conversations, memories, and tasks.";

let cachedId: string | undefined;

/**
 * Find-or-create the shared "Daily Briefing" agent config. Idempotent
 * under the `agent_configs.name` UNIQUE constraint; a lost insert race
 * retries the SELECT and surfaces the winner.
 */
export async function ensureBriefingAgentConfig(): Promise<DbAgentConfig> {
  const existing = await getAgentConfigByName(BRIEFING_AGENT_NAME);
  if (existing) {
    cachedId = existing.id;
    return existing;
  }
  try {
    const created = await createAgentConfig({
      name: BRIEFING_AGENT_NAME,
      description: BRIEFING_AGENT_DESCRIPTION,
      prompt: BRIEFING_AGENT_PROMPT,
      capabilities: ["llm"],
      category: "system",
    });
    cachedId = created.id;
    return created;
  } catch (err) {
    // Concurrent boot lost the unique-name race — surface the winner.
    const retry = await getAgentConfigByName(BRIEFING_AGENT_NAME);
    if (retry) {
      cachedId = retry.id;
      return retry;
    }
    throw err;
  }
}

/**
 * Resolve the briefing agent's id WITHOUT creating it (lookup-only —
 * setup-tools calls this on chat turns and must not mint rows there).
 * Cached after the first hit; `null` when the agent was never
 * bootstrapped on this host.
 */
export async function getBriefingAgentConfigId(): Promise<string | null> {
  if (cachedId) return cachedId;
  const row = await getAgentConfigByName(BRIEFING_AGENT_NAME);
  if (row) cachedId = row.id;
  return row?.id ?? null;
}

/** Test-only: clear the cached id so mocks/fresh DBs re-resolve. */
export function _resetBriefingAgentCacheForTests(): void {
  cachedId = undefined;
}
