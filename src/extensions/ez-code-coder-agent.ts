/**
 * The default coding agent that ships with the bundled `ez-code`
 * extension so its `dispatch_run` tool works OUT OF THE BOX.
 *
 * Background — the spawn path resolves agents purely from the
 * `agent_configs` DB table:
 *
 *   dispatch_run → SDK spawnAssignment({ agentName | agentConfigId })
 *     → host `ezcorp/spawn-assignment` RPC (spawn-assignment-handler.ts)
 *     → resolveAgentConfigForUser(ctx.userId, idOrName)
 *     → listAgentConfigs(userId)   // agent_configs rows, user-scoped
 *
 * A manifest `agent:` block does NOT make an agent spawnable by name —
 * it only feeds the marketplace listing path (see `seed-marketplace.ts`,
 * which builds a `manifest.agent` for the listing but ALSO calls
 * `createAgentConfig` to get the spawnable row). Without a row, a fresh
 * install dispatches to a non-existent "coder" and the handler returns
 * `Agent not found: coder`.
 *
 * Fix: ensure a single well-known SYSTEM agent_config row
 * (`userId: null`, name `ez-code coder`) exists. The companion change in
 * `resolveAgentConfigForUser` falls back to this system row by name when
 * the per-user lookup misses, so EVERY user's `dispatch_run` resolves it
 * (a per-user row would be invisible to other users).
 *
 * The agent itself is a plain LLM coding persona — file-edit + shell
 * ability comes from the host agent runtime on the active project (the
 * same surface any dispatched run gets), NOT from the agent config. The
 * prompt is what makes it a capable coder; we mirror how the seeded
 * "Full-Stack Dev Team" / "Code Reviewer" rows are shaped
 * (`capabilities: ["llm"]`, `CURRENT_MODEL_SENTINEL` so it inherits the
 * dispatching conversation's model/provider).
 */

import {
  getAgentConfigByName,
  createAgentConfig,
  type DbAgentConfig,
} from "../db/queries/agent-configs";
import { CURRENT_MODEL_SENTINEL } from "../types";
import { logger } from "../logger";

const log = logger.child("ez-code-coder");

/**
 * Canonical name of the bundled coder agent_config row. This is the
 * name `dispatch_run` defaults to and the fallback target in
 * `resolveAgentConfigForUser`. Lowercase, whitespace-trimmed comparison
 * is done by the resolver, so the stored name can be human-friendly.
 */
export const EZ_CODE_CODER_AGENT_NAME = "ez-code coder";

/**
 * Friendly aliases the ez-code extension accepts for the default coder
 * (case-insensitive). `dispatch_run` maps any of these onto
 * `EZ_CODE_CODER_AGENT_NAME` before spawning, so a bare `"coder"` from
 * the LLM resolves the bundled agent.
 */
export const EZ_CODE_CODER_ALIASES: ReadonlySet<string> = new Set([
  "coder",
  "ez-code coder",
  "ez-code",
]);

/** Whether `name` (case-insensitive, trimmed) is a coder alias. */
export function isEzCodeCoderAlias(name: string): boolean {
  return EZ_CODE_CODER_ALIASES.has(name.trim().toLowerCase());
}

const CODER_PROMPT = [
  "You are ez-code coder, an autonomous senior software engineer working",
  "directly on the active EZCorp project's repository. You can read and",
  "edit files and run shell/git commands in the project workspace.",
  "",
  "Operating principles:",
  "- Make the smallest change that fully solves the task; match the",
  "  surrounding code style and conventions.",
  "- Before editing, read the relevant files to understand context. After",
  "  editing, verify your work (run the build/tests when available).",
  "- Find root causes — no temporary hacks, no leaving the tree broken.",
  "- When the task is ambiguous, state your assumption and proceed rather",
  "  than stalling; ask only when genuinely blocked.",
  "- Summarize what you changed (files + rationale) when you finish so a",
  "  reviewer can open a PR from your work.",
].join("\n");

const CODER_DESCRIPTION =
  "Default ez-code coding agent — edits files and runs shell/git on the " +
  "active project to implement a task end-to-end.";

/**
 * Idempotently ensure the bundled coder agent_config row exists as a
 * SYSTEM agent (`userId: null`). Looks up by the canonical name first;
 * creates it only when absent. Returns the row (existing or freshly
 * created).
 *
 * Wired into the ez-code branch of `ensureBundledExtensions()` so it
 * runs on every boot after the extension row is present — matching the
 * other bundled wiring-migration hooks. Safe to call repeatedly: a
 * second call no-ops on the name match.
 */
export async function ensureEzCodeCoderAgent(): Promise<DbAgentConfig> {
  const existing = await getAgentConfigByName(EZ_CODE_CODER_AGENT_NAME);
  if (existing) return existing;

  const created = await createAgentConfig({
    name: EZ_CODE_CODER_AGENT_NAME,
    description: CODER_DESCRIPTION,
    prompt: CODER_PROMPT,
    category: "Development",
    capabilities: ["llm"],
    // Inherit the dispatching conversation's model/provider — the seeded
    // teams use the same sentinel so a run uses whatever the user has
    // configured rather than pinning a provider the user may not have.
    provider: CURRENT_MODEL_SENTINEL,
    model: CURRENT_MODEL_SENTINEL,
    // SYSTEM agent — owned by no user so the resolver's name-fallback can
    // serve it to every user's dispatch_run.
    userId: undefined,
  });
  log.info("Created bundled ez-code coder agent", {
    name: EZ_CODE_CODER_AGENT_NAME,
    id: created.id,
  });
  return created;
}
