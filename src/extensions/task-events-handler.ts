/**
 * Handles `ezcorp/emit-task-event` reverse RPC (Phase 2b).
 *
 * Lets an extension emit the two task-panel bus events
 * (`task:snapshot`, `task:assignment_update`) from an isolated
 * subprocess. The `conversationId` stamped on the event is ALWAYS the
 * host's `currentConversationId` — any value an extension includes in
 * its params is ignored. This prevents a compromised or buggy
 * extension from targeting another user's conversation.
 *
 * Gated on the `taskEvents: true` permission, the kill-switch,
 * conversation scope availability, and membership in
 * `conversation_extensions`. All rejections write an audit row under
 * `ext:emit-event-rejected` so operators can correlate suspicious
 * emissions with the causing extension.
 */

import type {
  JsonRpcRequest,
  JsonRpcResponse,
  ExtensionPermissions,
} from "./types";
import type { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import { getConversationExtensionIds } from "../db/queries/conversation-extensions";
import { createRateLimiter } from "./rate-limit";
import { capabilityToolsDisabled } from "./capability-flags";
import { insertAuditEntry } from "../db/queries/audit-log";
import { EXT_AUDIT_ACTIONS } from "./audit-actions";

const MAX_OPS_PER_SECOND = 50;
const consumeTokens = createRateLimiter(MAX_OPS_PER_SECOND);

// ── Minimal schema validation (no Zod dep) ─────────────────────────

interface ValidationResult { ok: true; }
interface ValidationFailure { ok: false; errors: string[]; }
type Validation = ValidationResult | ValidationFailure;

const ASSIGNMENT_STATUSES = ["assigned", "running", "completed", "failed"] as const;
const TASK_STATUSES = ["pending", "active", "completed", "failed"] as const;

function isString(v: unknown): v is string { return typeof v === "string"; }
function isNumber(v: unknown): v is number { return typeof v === "number"; }
function isBool(v: unknown): v is boolean { return typeof v === "boolean"; }
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateAssignment(a: unknown, path: string, errors: string[]): void {
  if (!isObj(a)) { errors.push(`${path}: not an object`); return; }
  if (!isString(a.id)) errors.push(`${path}.id: missing or not a string`);
  if (!isString(a.agentConfigId)) errors.push(`${path}.agentConfigId: missing or not a string`);
  if (!isString(a.agentName)) errors.push(`${path}.agentName: missing or not a string`);
  if (!isBool(a.isTeam)) errors.push(`${path}.isTeam: missing or not a boolean`);
  if (!isString(a.status) || !(ASSIGNMENT_STATUSES as readonly string[]).includes(a.status)) {
    errors.push(`${path}.status: must be one of ${ASSIGNMENT_STATUSES.join("|")}`);
  }
  if (!isString(a.assignedAt)) errors.push(`${path}.assignedAt: missing or not a string`);
}

function validateTask(t: unknown, path: string, errors: string[]): void {
  if (!isObj(t)) { errors.push(`${path}: not an object`); return; }
  if (!isString(t.id)) errors.push(`${path}.id: missing or not a string`);
  if (!isString(t.title)) errors.push(`${path}.title: missing or not a string`);
  if (!isString(t.description)) errors.push(`${path}.description: missing or not a string`);
  if (!isString(t.status) || !(TASK_STATUSES as readonly string[]).includes(t.status)) {
    errors.push(`${path}.status: must be one of ${TASK_STATUSES.join("|")}`);
  }
  if (!Array.isArray(t.assignments)) errors.push(`${path}.assignments: missing or not an array`);
  else t.assignments.forEach((a, i) => validateAssignment(a, `${path}.assignments[${i}]`, errors));
  if (!Array.isArray(t.subtasks)) errors.push(`${path}.subtasks: missing or not an array`);
  if (!isString(t.createdAt)) errors.push(`${path}.createdAt: missing or not a string`);
  if (!isNumber(t.priority)) errors.push(`${path}.priority: missing or not a number`);
}

function validateSnapshotPayload(payload: unknown): Validation {
  const errors: string[] = [];
  if (!isObj(payload)) { errors.push("payload: not an object"); return { ok: false, errors }; }
  if (!Array.isArray(payload.tasks)) errors.push("payload.tasks: missing or not an array");
  else payload.tasks.forEach((t, i) => validateTask(t, `payload.tasks[${i}]`, errors));
  if (payload.activeTaskId !== undefined && !isString(payload.activeTaskId)) {
    errors.push("payload.activeTaskId: must be a string when present");
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function validateAssignmentUpdatePayload(payload: unknown): Validation {
  const errors: string[] = [];
  if (!isObj(payload)) { errors.push("payload: not an object"); return { ok: false, errors }; }
  if (!isString(payload.taskId)) errors.push("payload.taskId: missing or not a string");
  validateAssignment(payload.assignment, "payload.assignment", errors);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// ── Types ──────────────────────────────────────────────────────────

export interface TaskEventsContext {
  conversationId: string;
  userId: string;
  grantedPermissions: ExtensionPermissions;
  bus: EventBus<AgentEvents> | undefined;
}

// ── Helpers ────────────────────────────────────────────────────────

function rpcError(id: number | string, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function rpcResult(id: number | string, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

async function auditReject(
  extensionId: string,
  userId: string | null,
  reason: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    await insertAuditEntry(
      userId,
      EXT_AUDIT_ACTIONS.EMIT_EVENT_REJECTED,
      extensionId,
      {
        permission: "taskEvents",
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

export async function handleEmitTaskEventRpc(
  extensionId: string,
  req: JsonRpcRequest,
  ctx: TaskEventsContext,
): Promise<JsonRpcResponse> {
  const params = (req.params ?? {}) as Record<string, unknown>;
  const userIdForAudit = ctx.userId && ctx.userId !== "unknown" ? ctx.userId : null;

  // Kill-switch: capability tier disabled globally.
  if (capabilityToolsDisabled()) {
    await auditReject(extensionId, userIdForAudit, "permission-missing");
    return rpcError(req.id, -32001, "taskEvents permission not granted");
  }

  // 1. Permission check.
  if (ctx.grantedPermissions.taskEvents !== true) {
    await auditReject(extensionId, userIdForAudit, "permission-missing");
    return rpcError(req.id, -32001, "taskEvents permission not granted");
  }

  // 2. Conversation scope: reject when context is unbound.
  if (!ctx.conversationId || ctx.conversationId === "unknown") {
    return rpcError(req.id, -32602, "Conversation scope unavailable in this context");
  }

  // 3. Conversation wiring: extension must be declared on this conversation.
  const wiredIds = await getConversationExtensionIds(ctx.conversationId);
  if (!wiredIds.includes(extensionId)) {
    await auditReject(extensionId, userIdForAudit, "not-wired", { conversationId: ctx.conversationId });
    return rpcError(req.id, -32001, "Extension not wired to this conversation");
  }

  // 4. Rate limit.
  if (!consumeTokens(extensionId, 1)) {
    await auditReject(extensionId, userIdForAudit, "rate-limited");
    return rpcError(req.id, -32029, "Rate limited");
  }

  // 5. Payload validation.
  if (params.v !== 1) {
    await auditReject(extensionId, userIdForAudit, "schema-mismatch", { errors: ["v: expected 1"] });
    return rpcError(req.id, -32602, "Missing or invalid 'v' (expected 1)");
  }

  const type = params.type;
  const payload = params.payload;

  if (type === "snapshot") {
    const validation = validateSnapshotPayload(payload);
    if (!validation.ok) {
      await auditReject(extensionId, userIdForAudit, "schema-mismatch", { errors: validation.errors });
      return rpcError(req.id, -32602, `Invalid snapshot payload: ${validation.errors[0] ?? "unknown error"}`);
    }
    const p = payload as { tasks: AgentEvents["task:snapshot"]["tasks"]; activeTaskId?: string };
    // conversationId is FORCED — never read from params.
    ctx.bus?.emit("task:snapshot", {
      conversationId: ctx.conversationId,
      tasks: p.tasks,
      ...(p.activeTaskId !== undefined ? { activeTaskId: p.activeTaskId } : {}),
    });
    return rpcResult(req.id, { ok: true });
  }

  if (type === "assignment_update") {
    const validation = validateAssignmentUpdatePayload(payload);
    if (!validation.ok) {
      await auditReject(extensionId, userIdForAudit, "schema-mismatch", { errors: validation.errors });
      return rpcError(req.id, -32602, `Invalid assignment_update payload: ${validation.errors[0] ?? "unknown error"}`);
    }
    const p = payload as { taskId: string; assignment: AgentEvents["task:assignment_update"]["assignment"] };
    ctx.bus?.emit("task:assignment_update", {
      conversationId: ctx.conversationId,
      taskId: p.taskId,
      assignment: p.assignment,
    });
    return rpcResult(req.id, { ok: true });
  }

  await auditReject(extensionId, userIdForAudit, "schema-mismatch", { errors: [`type: unknown value ${String(type)}`] });
  return rpcError(req.id, -32602, `Unknown event type: ${String(type)}`);
}
