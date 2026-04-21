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
import {
  listAgentConfigs,
  type DbAgentConfig,
} from "../db/queries/agent-configs";
import { createRateLimiter } from "./rate-limit";
import { capabilityToolsDisabled } from "./capability-flags";

const MAX_OPS_PER_SECOND = 50;
const consumeTokens = createRateLimiter(MAX_OPS_PER_SECOND);

export interface AgentConfigsContext {
  userId: string;
  grantedPermissions: ExtensionPermissions;
}

export interface AgentConfigSummary {
  id: string;
  name: string;
  description: string;
  isTeam: boolean;
  ownerUserId: string | null;
}

function rpcError(id: number | string, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function rpcResult(id: number | string, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
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
  const configs = await listAgentConfigs(userId);
  const needle = idOrName.trim().toLowerCase();
  return (
    configs.find(
      (c) => c.id === idOrName || c.name.trim().toLowerCase() === needle,
    ) ?? null
  );
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

  // Permission check.
  if (ctx.grantedPermissions.agentConfig !== "read") {
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
