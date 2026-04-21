/**
 * Permission middleware for built-in tools.
 *
 * Controls which tool categories auto-approve vs require user confirmation,
 * with per-project settings storage and an async approval gate mechanism.
 */

import { getSetting } from "../../db/queries/settings";

// ── Types ───────────────────────────────────────────────────────────

export type ToolCategory = "read" | "write" | "execute";
export type PermissionMode = "ask" | "auto-edit" | "yolo";

const VALID_MODES = new Set<PermissionMode>(["ask", "auto-edit", "yolo"]);

// ── Permission Matrix ───────────────────────────────────────────────

const AUTO_APPROVE: Record<PermissionMode, Set<ToolCategory>> = {
  ask: new Set(["read"]),
  "auto-edit": new Set(["read", "write"]),
  yolo: new Set(["read", "write", "execute"]),
};

/**
 * Returns true if the given tool category requires user approval under the given mode.
 */
export function needsApproval(category: ToolCategory, mode: PermissionMode): boolean {
  return !AUTO_APPROVE[mode].has(category);
}

// ── Permission Mode Lookup ──────────────────────────────────────────

/**
 * Get the permission mode for a project.
 * Uses sessionOverride if provided, otherwise looks up stored setting, defaults to "ask".
 */
export async function getPermissionMode(
  projectId: string,
  sessionOverride?: PermissionMode,
): Promise<PermissionMode> {
  if (sessionOverride) return sessionOverride;

  const stored = await getSetting(`project:${projectId}:tool_permission_mode`);
  if (typeof stored === "string" && VALID_MODES.has(stored as PermissionMode)) {
    return stored as PermissionMode;
  }
  return "ask";
}

// ── Permission Gate ─────────────────────────────────────────────────

interface PendingApproval {
  resolve: () => void;
  reject: (err: Error) => void;
  // sec-H2: conversation this gate belongs to, so the HTTP handler that
  // resolves it can verify the caller owns the conversation before acting.
  conversationId?: string;
}

const pendingApprovals = new Map<string, PendingApproval>();

/**
 * Create a permission gate that blocks until the user approves or denies.
 * Returns a promise that resolves on approval or rejects on denial.
 *
 * `conversationId` (optional) is stored alongside the gate so the route
 * handler can look up the conversation owner for a sec-H2 ownership check
 * before calling `resolvePermission`. Callers in the executor pass it.
 */
export function createPermissionGate(
  toolCallId: string,
  conversationId?: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    pendingApprovals.set(toolCallId, { resolve, reject, conversationId });
  });
}

/**
 * Returns the conversationId associated with a pending gate, or undefined
 * if no gate is pending (or the gate was created without one).
 * Used by the POST /api/tool-calls/:id/permission handler to authorize the
 * caller against the gate's owning conversation (sec-H2).
 */
export function getPendingApprovalConversation(
  toolCallId: string,
): string | undefined {
  return pendingApprovals.get(toolCallId)?.conversationId;
}

/**
 * Resolve a pending permission gate.
 * If approved=true, the gate promise resolves. If false, it rejects with "Permission denied".
 * No-op if the toolCallId is not pending.
 */
export function resolvePermission(toolCallId: string, approved: boolean): void {
  const pending = pendingApprovals.get(toolCallId);
  if (!pending) return;

  pendingApprovals.delete(toolCallId);
  if (approved) {
    pending.resolve();
  } else {
    pending.reject(new Error("Permission denied"));
  }
}

/**
 * Check if a toolCallId has a pending approval gate.
 */
export function getPendingApproval(toolCallId: string): boolean {
  return pendingApprovals.has(toolCallId);
}
