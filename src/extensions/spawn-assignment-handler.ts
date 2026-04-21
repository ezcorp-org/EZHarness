/**
 * Handles `ezcorp/spawn-assignment` reverse RPC (Phase 2d).
 *
 * Lets an extension ask the host to start a sub-agent run against a
 * caller-chosen agent config with a caller-supplied task body. The
 * host creates (or reuses) a sub-conversation parented on the
 * extension's current conversation, calls the same `startAssignment()`
 * primitive the bundled task-tracking tools use, and returns
 * `{ subConversationId, agentRunId, taskId, assignmentId }`
 * **immediately** — non-blocking. The extension tracks completion via
 * the Phase 2c `agent:complete` subscription.
 *
 * Enforcement ladder (strict order):
 *   1. Kill-switch (`EZCORP_DISABLE_CAPABILITY_TOOLS=1`)
 *   2. `granted.spawnAgents` present + `maxPerHour > 0`
 *   3. Parent conversationId bound (not "unknown")
 *   4. Parent projectId bound (sub-conv creation needs it)
 *   5. Extension wired to the parent conversation
 *   6. Instantaneous rate limit (50 ops/sec)
 *   7. Spawn-depth ≤ MAX_SPAWN_DEPTH
 *   8. Payload version + required fields
 *   9. Hourly / concurrent quota
 *  10. Agent resolution
 *  11. Dispatch — reserve → startAssignment → swap reservation to real
 *      agentRunId → copy parent's extension wiring → persist child depth
 *
 * Every rejection writes an `ext:spawn-quota-exceeded` audit row with a
 * typed `reason`.
 */

import type {
  JsonRpcRequest,
  JsonRpcResponse,
  ExtensionPermissions,
} from "./types";
import type { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import type { AgentExecutor } from "../runtime/executor";
import type { SpawnQuota } from "./spawn-quota";
import {
  getConversationExtensionIds,
  copyConversationExtensions,
} from "../db/queries/conversation-extensions";
import { setConversationSpawnDepth } from "../db/queries/conversations";
import { createRateLimiter } from "./rate-limit";
import { capabilityToolsDisabled } from "./capability-flags";
import { insertAuditEntry } from "../db/queries/audit-log";
import { EXT_AUDIT_ACTIONS } from "./audit-actions";
import { resolveAgentConfigForUser } from "./agent-configs-handler";
import { startAssignment } from "../runtime/start-assignment";
import type { TaskAssignment, TaskSnapshot, TrackedTask } from "../runtime/task-tracking-host";

const MAX_OPS_PER_SECOND = 50;
const consumeTokens = createRateLimiter(MAX_OPS_PER_SECOND);

/** Hard ceiling on the number of extension-initiated spawns from the root.
 *  Mirrors `MAX_CALL_DEPTH` from `tool-executor.ts` — same numeric cap,
 *  tracked separately so a 10-deep invoke chain inside a single spawn is
 *  still allowed. */
export const MAX_SPAWN_DEPTH = 10;

export interface SpawnAssignmentContext {
  /** The parent conversation — always forced from `currentConversationId`. */
  conversationId: string;
  /** Acting user; `"unknown"` short-circuits to -32602 before any DB work. */
  userId: string;
  /** Parent conversation's projectId; null → -32602. */
  projectId: string | null;
  grantedPermissions: ExtensionPermissions;
  executor: AgentExecutor;
  bus: EventBus<AgentEvents>;
  quota: SpawnQuota;
  /** Parent conversation's model (fallback for CURRENT_MODEL_SENTINEL). */
  parentModel?: string;
  /** Parent conversation's provider (fallback for CURRENT_MODEL_SENTINEL). */
  parentProvider?: string;
  /** Current spawn depth — 0 for a top-level conversation. */
  spawnDepth: number;
}

type DenyReason =
  | "permission-missing"
  | "not-wired"
  | "rate-limited"
  | "depth-exceeded"
  | "hourly-exceeded"
  | "concurrent-exceeded";

function rpcError(id: number | string, code: number, message: string, data?: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

function rpcResult(id: number | string, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

async function auditReject(
  extensionId: string,
  userId: string | null,
  reason: DenyReason,
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    await insertAuditEntry(
      userId,
      EXT_AUDIT_ACTIONS.SPAWN_QUOTA_EXCEEDED,
      extensionId,
      {
        permission: "spawnAgents",
        oldValue: undefined,
        newValue: undefined,
        actor: "system",
        reason,
        ...(extra ?? {}),
      },
    );
  } catch {
    // Audit failure must never break the response path.
  }
}

// ── Main handler ───────────────────────────────────────────────────

export async function handleSpawnAssignmentRpc(
  extensionId: string,
  req: JsonRpcRequest,
  ctx: SpawnAssignmentContext,
): Promise<JsonRpcResponse> {
  const params = (req.params ?? {}) as Record<string, unknown>;
  const auditUser = ctx.userId && ctx.userId !== "unknown" ? ctx.userId : null;

  // 1. Kill-switch.
  if (capabilityToolsDisabled()) {
    await auditReject(extensionId, auditUser, "permission-missing");
    return rpcError(req.id, -32001, "spawnAgents permission not granted");
  }

  // 2. Permission check — structural (spawnAgents is an object, not a bool).
  const granted = ctx.grantedPermissions.spawnAgents;
  if (!granted || typeof granted.maxPerHour !== "number" || granted.maxPerHour <= 0) {
    await auditReject(extensionId, auditUser, "permission-missing");
    return rpcError(req.id, -32001, "spawnAgents permission not granted");
  }

  // 3. Parent conversation bound.
  if (!ctx.conversationId || ctx.conversationId === "unknown") {
    return rpcError(req.id, -32602, "Conversation scope unavailable in this context");
  }
  // 4. Parent project bound.
  if (!ctx.projectId) {
    return rpcError(req.id, -32602, "Project scope unavailable (parent has no projectId)");
  }

  // 5. Wiring gate — extension must be wired to the parent.
  const wired = await getConversationExtensionIds(ctx.conversationId);
  if (!wired.includes(extensionId)) {
    await auditReject(extensionId, auditUser, "not-wired", { conversationId: ctx.conversationId });
    return rpcError(req.id, -32001, "Extension not wired to this conversation");
  }

  // 6. Instantaneous rate limit.
  if (!consumeTokens(extensionId, 1)) {
    await auditReject(extensionId, auditUser, "rate-limited");
    return rpcError(req.id, -32029, "Rate limited");
  }

  // 7. Spawn depth.
  if (ctx.spawnDepth >= MAX_SPAWN_DEPTH) {
    await auditReject(extensionId, auditUser, "depth-exceeded", { spawnDepth: ctx.spawnDepth });
    return rpcError(req.id, -32000, "Spawn depth limit exceeded");
  }

  // 8. Payload version + required fields.
  if (params.v !== 1) {
    return rpcError(req.id, -32602, "Missing or invalid 'v' (expected 1)");
  }
  const taskBody = typeof params.task === "string" ? params.task : "";
  if (!taskBody.trim()) {
    return rpcError(req.id, -32602, "'task' must be a non-empty string");
  }
  const agentConfigId = typeof params.agentConfigId === "string" ? params.agentConfigId : undefined;
  const agentName = typeof params.agentName === "string" ? params.agentName : undefined;
  const idOrName = agentConfigId ?? agentName;
  if (!idOrName) {
    return rpcError(req.id, -32602, "One of 'agentConfigId' or 'agentName' is required");
  }
  const title = typeof params.title === "string" && params.title.trim() ? params.title.trim() : undefined;
  const callerTaskId = typeof params.taskId === "string" && params.taskId.trim() ? params.taskId : undefined;
  const callerAssignmentId = typeof params.assignmentId === "string" && params.assignmentId.trim() ? params.assignmentId : undefined;

  // 9. Hourly + concurrent quota.
  const cfg = {
    maxPerHour: granted.maxPerHour,
    maxConcurrent: granted.maxConcurrent ?? 3,
  };
  const quotaCheck = ctx.quota.check(extensionId, cfg);
  if (!quotaCheck.ok) {
    await auditReject(extensionId, auditUser, quotaCheck.reason!, quotaCheck.details);
    return rpcError(
      req.id,
      -32000,
      quotaCheck.reason === "hourly-exceeded"
        ? "Spawn quota exceeded"
        : "Concurrent spawn cap reached",
      { reason: quotaCheck.reason, ...quotaCheck.details },
    );
  }

  // 10. Agent resolution.
  const agentConfig = await resolveAgentConfigForUser(ctx.userId, idOrName);
  if (!agentConfig) {
    return rpcError(req.id, -32602, `Agent not found: ${idOrName}`);
  }

  // 11. Build synthetic task + assignment shells. startAssignment mutates
  // `assignment` in place to set status/startedAt/subConvId/agentRunId;
  // we return the post-mutation view. The snapshot exists so the
  // sub-run's plan-context prompt has something to read — a minimal
  // one-task snapshot carries no parent tasks (Phase 3's task-tracking
  // extension will pass the real snapshot).
  const taskId = callerTaskId ?? crypto.randomUUID();
  const assignmentId = callerAssignmentId ?? crypto.randomUUID();
  const refsMembers = (agentConfig.references as { members?: unknown[] } | null)?.members;
  const assignment: TaskAssignment = {
    id: assignmentId,
    agentConfigId: agentConfig.id,
    agentName: agentConfig.name,
    isTeam: Array.isArray(refsMembers) && refsMembers.length > 0,
    status: "assigned",
    assignedAt: new Date().toISOString(),
  };
  const task: TrackedTask = {
    id: taskId,
    title: title ?? agentConfig.name,
    description: taskBody,
    status: "active",
    assignments: [assignment],
    subtasks: [],
    priority: 0,
    createdAt: new Date().toISOString(),
  };
  const snapshot: TaskSnapshot = {
    conversationId: ctx.conversationId,
    tasks: [task],
    activeTaskId: taskId,
  };

  // Reserve speculatively on assignmentId — we don't have agentRunId yet.
  // Swap after startAssignment returns; release on failure.
  ctx.quota.reserve(extensionId, assignmentId);
  try {
    const { subConversationId, agentRunId } = await startAssignment({
      executor: ctx.executor,
      bus: ctx.bus,
      conversationId: ctx.conversationId,
      taskId,
      assignment,
      task,
      snapshot,
      projectId: ctx.projectId,
      agentConfig: {
        id: agentConfig.id,
        name: agentConfig.name,
        prompt: agentConfig.prompt,
        model: agentConfig.model,
        provider: agentConfig.provider,
      },
      ...(ctx.parentModel !== undefined ? { parentModel: ctx.parentModel } : {}),
      ...(ctx.parentProvider !== undefined ? { parentProvider: ctx.parentProvider } : {}),
    });

    // Re-key the reservation to the real agentRunId so the bus
    // subscription releases it on run termination.
    ctx.quota.swapReservation(extensionId, assignmentId, agentRunId);

    // Inherit parent's extension wiring into the sub-conversation so the
    // spawning extension (and its wired siblings) can observe the child.
    await copyConversationExtensions(ctx.conversationId, subConversationId);

    // Persist spawn depth on the child for recursive-spawn enforcement.
    await setConversationSpawnDepth(subConversationId, ctx.spawnDepth + 1);

    return rpcResult(req.id, {
      v: 1,
      subConversationId,
      agentRunId,
      taskId,
      assignmentId,
    });
  } catch (err) {
    ctx.quota.release(assignmentId);
    const msg = err instanceof Error ? err.message : String(err);
    return rpcError(req.id, -32603, `Spawn failed: ${msg}`);
  }
}
