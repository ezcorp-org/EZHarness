/**
 * Route handlers for tool permission management.
 *
 * POST /api/tool-calls/:id/permission  - Approve/deny a pending tool call
 * GET  /api/projects/:id/tool-permission-mode  - Get project permission mode
 * PUT  /api/projects/:id/tool-permission-mode  - Set project permission mode
 */

import { resolvePermission, getPendingApprovalConversation } from "../runtime/tools/permissions";
import type { PermissionMode } from "../runtime/tools/permissions";
import { getSetting, upsertSetting } from "../db/queries/settings";
import { getConversation } from "../db/queries/conversations";
import type { AuthUser } from "../auth/types";

const VALID_MODES = new Set<PermissionMode>(["ask", "auto-edit", "yolo"]);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * POST /api/tool-calls/:id/permission
 * Body: { approved: boolean }
 *
 * sec-H2: Any authenticated caller could previously approve or deny a
 * pending tool-call permission gate belonging to any other user — the
 * handler validated the JSON body but never checked ownership. Combined
 * with the agent-run flow this let a low-privileged user approve an
 * admin's pending "shell" tool execution. We now look up the gate's
 * owning conversation and reject with 403 unless the caller owns it
 * (or is an instance admin).
 */
export async function handleToolPermission(
  req: Request,
  toolCallId: string,
  user: AuthUser,
): Promise<Response> {
  let body: { approved?: boolean };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (typeof body.approved !== "boolean") {
    return json({ error: "approved (boolean) is required" }, 400);
  }

  // sec-H2: only enforce ownership when a gate is actually pending. If no
  // gate is registered for this toolCallId `resolvePermission` is a no-op,
  // and returning 200 here preserves the pre-fix "unknown id → no-op" shape
  // that callers rely on (e.g. page refresh racing gate resolution).
  const pendingConvId = getPendingApprovalConversation(toolCallId);
  if (pendingConvId) {
    const conv = await getConversation(pendingConvId);
    // Fail-closed: if we can't load the conversation, refuse. Matches the
    // sec-H3 fail-closed shape on null/unowned rows.
    if (!conv || (conv.userId !== user.id && user.role !== "admin")) {
      return json({ error: "Forbidden" }, 403);
    }
  }

  resolvePermission(toolCallId, body.approved);
  return json({ ok: true });
}

/**
 * GET /api/projects/:id/tool-permission-mode
 */
export async function handleGetPermissionMode(_req: Request, projectId: string): Promise<Response> {
  const stored = await getSetting(`project:${projectId}:tool_permission_mode`);
  const mode = typeof stored === "string" && VALID_MODES.has(stored as PermissionMode)
    ? stored
    : "ask";
  return json({ mode });
}

/**
 * PUT /api/projects/:id/tool-permission-mode
 * Body: { mode: PermissionMode }
 */
export async function handleSetPermissionMode(
  req: Request,
  projectId: string,
  options?: { onModeChange?: (mode: string, conversationId?: string) => void },
): Promise<Response> {
  let body: { mode?: string; conversationId?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.mode || !VALID_MODES.has(body.mode as PermissionMode)) {
    return json({ error: `mode must be one of: ${[...VALID_MODES].join(", ")}` }, 400);
  }

  await upsertSetting(`project:${projectId}:tool_permission_mode`, body.mode);
  options?.onModeChange?.(body.mode, body.conversationId);
  return json({ ok: true });
}
