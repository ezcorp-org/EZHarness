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
 * Identify the coder by a FIXED, well-known agent-config ID — NOT by
 * `userId: null`.
 *
 * The first attempt seeded a `userId: null` "system" row and resolved it
 * by name only when the row was ownerless. That is DEFEATED by the boot
 * migration at `src/db/migrate.ts:~404`:
 *
 *   UPDATE agent_configs SET user_id = (SELECT id FROM users
 *     WHERE role='admin' ORDER BY created_at LIMIT 1) WHERE user_id IS NULL
 *
 * which adopts every ownerless row into the first admin on the next
 * boot — so the coder is no longer ownerless and a `userId === null`
 * guard rejects it.
 *
 * A fixed id is the correct, secure key:
 *   - Unforgeable: the create API assigns RANDOM ids, so a user cannot
 *     mint a row carrying our id. ID wins over a same-named impostor.
 *   - Survives the backfill: the migration only rewrites `user_id`,
 *     never `id`.
 *   - User-agnostic resolution: `getAgentConfig(id)` is `WHERE id = ?`
 *     (NOT user-scoped), so the coder resolves for EVERY user regardless
 *     of which admin ended up owning it.
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
  getAgentConfig,
  createAgentConfig,
  deleteAgentConfigsByNameExceptId,
  type DbAgentConfig,
} from "../db/queries/agent-configs";
import { CURRENT_MODEL_SENTINEL } from "../types";
import { logger } from "../logger";

const log = logger.child("ez-code-coder");

/**
 * Fixed, well-known id of the bundled coder agent_config row. This is
 * the STABLE key the resolver uses (`getAgentConfig(id)`), so the coder
 * is resolvable for every user and survives the ownerless→admin backfill
 * in `migrate.ts`. Hardcoded (never generated) so it's identical across
 * every install. A well-formed UUID (the `id` column is `text`, but
 * mirroring the UUID shape of every other row keeps the DB uniform); the
 * `ec0de…` nibbles spell out its ez-code provenance.
 *
 * SECURITY: `createAgentConfig` assigns RANDOM ids to user-created rows,
 * so a user cannot create a row with this id — the id is unforgeable and
 * always wins over a same-named impostor row.
 */
export const EZ_CODE_CODER_AGENT_ID = "ec0de000-c0de-4a9e-b0de-c0de1ec0de00";

/**
 * Canonical name of the bundled coder agent_config row. Human-friendly;
 * the resolver matches it case-insensitively / whitespace-trimmed. The
 * id (not the name) is the authoritative key — the name is for display +
 * the alias UX.
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
 * Idempotently ensure the bundled coder agent_config row exists at the
 * FIXED id `EZ_CODE_CODER_AGENT_ID`. Returns the row.
 *
 * Steps:
 *   1. Dedupe: delete any OTHER row named `ez-code coder` whose id is not
 *      the fixed id. This cleans up the stale random-id row created by
 *      the earlier (pre-fixed-id) version of this function in dev DBs, so
 *      exactly one canonical coder survives.
 *   2. If the fixed-id row already exists → no-op (return it). The owner
 *      may have been backfilled to admin by `migrate.ts` — harmless,
 *      because resolution is by id, not owner.
 *   3. Otherwise create the row WITH the fixed id.
 *
 * Wired into the ez-code branch of `ensureBundledExtensions()` so it runs
 * on every boot after the extension row is present — matching the other
 * bundled wiring-migration hooks. Safe to call repeatedly.
 */
export async function ensureEzCodeCoderAgent(): Promise<DbAgentConfig> {
  // 1. Dedupe stale same-named rows (different id) from earlier installs.
  try {
    const removed = await deleteAgentConfigsByNameExceptId(
      EZ_CODE_CODER_AGENT_NAME,
      EZ_CODE_CODER_AGENT_ID,
    );
    if (removed > 0) {
      log.info("Removed stale ez-code coder row(s)", {
        name: EZ_CODE_CODER_AGENT_NAME,
        removed,
      });
    }
  } catch (err) {
    // Non-fatal: dedupe is a cleanup, not a correctness requirement —
    // the fixed-id row below is what the resolver targets.
    log.warn("ez-code coder dedupe failed", { error: String(err) });
  }

  // 2. Fixed-id row already present → no-op.
  const existing = await getAgentConfig(EZ_CODE_CODER_AGENT_ID);
  if (existing) return existing;

  // 3. Create at the fixed id. Owner is left to default (null) and may be
  // backfilled to admin by migrate.ts — resolution is by id, so this is
  // harmless.
  const created = await createAgentConfig({
    id: EZ_CODE_CODER_AGENT_ID,
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
  });
  log.info("Created bundled ez-code coder agent", {
    name: EZ_CODE_CODER_AGENT_NAME,
    id: created.id,
  });
  return created;
}
