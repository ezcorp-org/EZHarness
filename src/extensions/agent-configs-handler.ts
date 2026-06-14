/**
 * Handles `ezcorp/agent-configs` reverse RPC requests (Phase 2b).
 *
 * Read-only access to the calling user's agent configs, gated on the
 * `agentConfig: "read"` permission. Return shape is a minimum-information
 * summary — `id`, `name`, `description`, `isTeam`, `ownerUserId` — never
 * the full config. Prompt, references, extensions, temperature, model,
 * and other secret-adjacent fields are intentionally omitted.
 *
 * Scope: results are always filtered to `this.currentUserId` via
 * `listAgentConfigs(userId)`, which returns the user's own configs
 * plus any shared with them (team or direct). Other users' private
 * configs are never disclosed.
 */

import type {
  JsonRpcRequest,
  JsonRpcResponse,
  ExtensionPermissions,
} from "./types";
import type { PermissionEngine } from "./permission-engine";
import {
  listAgentConfigs,
  getAgentConfig,
  type DbAgentConfig,
} from "../db/queries/agent-configs";
import { isEzCodeCoderAlias, EZ_CODE_CODER_AGENT_ID } from "./ez-code-coder-agent";
import { createRateLimiter } from "./rate-limit";
import { capabilityToolsDisabled } from "./capability-flags";
import { rpcError, rpcResult } from "./json-rpc";

const MAX_OPS_PER_SECOND = 50;
const consumeTokens = createRateLimiter(MAX_OPS_PER_SECOND);

export interface AgentConfigsContext {
  userId: string;
  grantedPermissions: ExtensionPermissions;
  /** Phase 6: PDP. Optional for back-compat with pre-PDP unit tests. */
  engine?: PermissionEngine;
  /** Phase 6: conversation scope used by the PDP for always-allow lookup. */
  conversationId?: string;
}

export interface AgentConfigSummary {
  id: string;
  name: string;
  description: string;
  isTeam: boolean;
  ownerUserId: string | null;
}

function toSummary(row: DbAgentConfig): AgentConfigSummary {
  const refs = row.references as { members?: unknown[] } | null | undefined;
  const isTeam = Array.isArray(refs?.members) && refs.members.length > 0;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isTeam,
    ownerUserId: row.userId ?? null,
  };
}

/**
 * Shared agent-config resolver (Phase 2d extraction). Used by both
 * `handleAgentConfigsRpc` and `handleSpawnAssignmentRpc` — one code
 * path, one set of semantics (id-first, name-fallback, case-insensitive,
 * whitespace-trimmed, user-scoped via `listAgentConfigs(userId)`).
 * Returns the FULL DB row, not the minimized summary — callers pick
 * what they need (spawn needs `.prompt`, `.model`, `.provider`;
 * agent-configs RPC reduces to summary).
 */
export async function resolveAgentConfigForUser(
  userId: string,
  idOrName: string,
): Promise<DbAgentConfig | null> {
  // Fast path: an explicit reference to the bundled coder by its FIXED
  // id. `getAgentConfig` is `WHERE id = ?` (NOT user-scoped), so this
  // resolves for every user regardless of which admin owns the row after
  // the migrate.ts backfill. Checked first so `dispatch_run` may pass the
  // id directly as `agentConfigId`.
  if (idOrName === EZ_CODE_CODER_AGENT_ID) {
    return (await getAgentConfig(EZ_CODE_CODER_AGENT_ID)) ?? null;
  }

  const configs = await listAgentConfigs(userId);
  const needle = idOrName.trim().toLowerCase();
  const userScoped = configs.find(
    (c) => c.id === idOrName || c.name.trim().toLowerCase() === needle,
  );
  if (userScoped) return userScoped;

  // Bundled-coder fallback: the ez-code coder lives at a FIXED, unforgeable
  // id (see `ez-code-coder-agent.ts`). It is NOT a user's own/shared row,
  // so it never appears in `listAgentConfigs(userId)` — and a `userId:
  // null` guard is wrong because the boot migration (`migrate.ts:~404`)
  // adopts ownerless rows into the first admin. So for a coder ALIAS
  // (and the canonical name, which `isEzCodeCoderAlias` also matches),
  // resolve the coder BY ITS FIXED ID for ANY user. Gated strictly on the
  // alias set, so only coder aliases reach this branch — it cannot leak
  // another user's config. Note the user-scoped lookup ran FIRST, so a
  // user's OWN row literally named "coder" still wins (id is unique +
  // unforgeable; their row has a different, random id).
  if (isEzCodeCoderAlias(idOrName)) {
    return (await getAgentConfig(EZ_CODE_CODER_AGENT_ID)) ?? null;
  }

  return null;
}

export async function handleAgentConfigsRpc(
  extensionId: string,
  req: JsonRpcRequest,
  ctx: AgentConfigsContext,
): Promise<JsonRpcResponse> {
  const params = (req.params ?? {}) as Record<string, unknown>;

  // Kill-switch: capability tier disabled globally.
  if (capabilityToolsDisabled()) {
    return rpcError(req.id, -32001, "agentConfig permission not granted");
  }

  // Phase 6: PDP is the sole gate. Delegate the permission decision
  // to `engine.authorize` when wired; otherwise fall back to the
  // legacy boolean check for back-compat with pre-PDP unit tests.
  if (ctx.engine) {
    const decision = await ctx.engine.authorize(
      {
        extensionId,
        userId: ctx.userId && ctx.userId !== "unknown" ? ctx.userId : null,
        conversationId:
          ctx.conversationId && ctx.conversationId !== "unknown"
            ? ctx.conversationId
            : null,
        toolName: "ezcorp/agent-configs",
      },
      [{ kind: "ezcorp:agent:config" }],
    );
    if (decision.decision === "deny") {
      return rpcError(req.id, -32001, "agentConfig permission not granted");
    }
  } else if (ctx.grantedPermissions.agentConfig !== "read") {
    return rpcError(req.id, -32001, "agentConfig permission not granted");
  }

  // User scope required — cross-ext and unbound contexts are refused.
  if (!ctx.userId || ctx.userId === "unknown") {
    return rpcError(req.id, -32602, "User scope unavailable in this context");
  }

  // Payload version.
  if (params.v !== 1) {
    return rpcError(req.id, -32602, "Missing or invalid 'v' (expected 1)");
  }

  // Rate limit.
  if (!consumeTokens(extensionId, 1)) {
    return rpcError(req.id, -32029, "Rate limited");
  }

  const action = params.action;
  if (action !== "list" && action !== "resolve") {
    return rpcError(req.id, -32602, `Unknown action: ${String(action)}`);
  }

  const configs = await listAgentConfigs(ctx.userId);

  if (action === "list") {
    return rpcResult(req.id, { v: 1, configs: configs.map(toSummary) });
  }

  // action === "resolve"
  const idOrName = params.idOrName;
  if (typeof idOrName !== "string" || !idOrName.trim()) {
    return rpcError(req.id, -32602, "resolve requires non-empty 'idOrName'");
  }
  // Resolution semantics live in the shared resolveAgentConfigForUser so
  // the `list` cache above and the Phase 2d spawn handler share one
  // definition of "this is the config the caller meant". Here we already
  // have the full list, so we filter it in-place instead of re-calling
  // listAgentConfigs — identical result, one fewer DB round-trip.
  const needle = idOrName.trim().toLowerCase();
  const match = configs.find(
    (c) => c.id === idOrName || c.name.trim().toLowerCase() === needle,
  );
  return rpcResult(req.id, { v: 1, config: match ? toSummary(match) : null });
}
