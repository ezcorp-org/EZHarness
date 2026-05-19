/**
 * Route handlers for tool permission management.
 *
 * POST /api/tool-calls/:id/permission  - Approve/deny a pending tool call
 * GET  /api/projects/:id/tool-permission-mode  - Get project permission mode
 * PUT  /api/projects/:id/tool-permission-mode  - Set project permission mode
 */

import {
  resolvePermission,
  getPendingApprovalConversation,
  getPendingExtensionGate,
  DEFAULT_PERMISSION_MODE,
} from "../runtime/tools/permissions";
import type { PermissionMode } from "../runtime/tools/permissions";
import { getSetting, upsertSetting } from "../db/queries/settings";
import { getConversation } from "../db/queries/conversations";
import { parseTtlOverrideMs } from "../extensions/ttl-validate";
import { mapAlwaysAllowCapabilityToExpiryKind } from "../extensions/perm-expiry-sweep";
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
 * Body: { approved: boolean, scope?: "session" | "conversation" | "project" | "forever" }
 *
 * sec-H2: Any authenticated caller could previously approve or deny a
 * pending tool-call permission gate belonging to any other user — the
 * handler validated the JSON body but never checked ownership. Combined
 * with the agent-run flow this let a low-privileged user approve an
 * admin's pending "shell" tool execution. We now look up the gate's
 * owning conversation and reject with 403 unless the caller owns it
 * (or is an instance admin).
 *
 * Phase 6: extension-scoped permission requests carry an additional
 * `scope` field naming the user-chosen always-allow scope (default
 * `session`). Built-in tool gates ignore the field. The scope value is
 * validated against the four spec-locked options.
 */
const VALID_SCOPES = new Set(["session", "conversation", "project", "forever"]);

export async function handleToolPermission(
  req: Request,
  toolCallId: string,
  user: AuthUser,
): Promise<Response> {
  let body: { approved?: boolean; scope?: string; ttlOverrideMs?: unknown };
  try {
    const raw = (await req.json()) as unknown;
    body = (raw && typeof raw === "object" ? raw : {}) as {
      approved?: boolean;
      scope?: string;
      ttlOverrideMs?: unknown;
    };
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (typeof body.approved !== "boolean") {
    return json({ error: "approved (boolean) is required" }, 400);
  }

  // Phase 6: optional `scope` field for extension-scoped gates. Reject
  // unknown values rather than silently downgrading to "session" so a
  // typo in the UI surfaces immediately.
  if (body.scope !== undefined && !VALID_SCOPES.has(body.scope)) {
    return json(
      { error: `scope must be one of: ${[...VALID_SCOPES].join(", ")}` },
      400,
    );
  }

  // Phase 56 — validate ttlOverrideMs via the shared parser (also used
  // by the settings-side /api/extensions/[id]/reapprove endpoint).
  // Pitfall 2: null is the SOLE Never sentinel; 0 / negative / NaN /
  // Infinity all return 400 — a `0`-ms TTL would expire the grant
  // the moment it lands on disk.
  const parsedTtl = parseTtlOverrideMs(body.ttlOverrideMs);
  if (!parsedTtl.ok) {
    return json({ error: parsedTtl.error }, 400);
  }
  const ttlOverrideMs = parsedTtl.value;

  // Phase 4 (capability-expiry) — defense in depth: the modal's "Approve
  // forever (admin only)" button is gated client-side via the `isAdmin`
  // prop on PermissionGate, but a tampered DOM (or a hand-rolled curl)
  // could still post `scope: "forever"` from a non-admin session. Reject
  // here so the always-allow `forever` row never lands without the role
  // check matching the design doc § 3.2 contract.
  //
  // Other scopes (`session`, `conversation`, `project`) remain open to
  // any authenticated caller — they're per-user trust decisions, not
  // policy decisions, and the install-time grant already passed the
  // admin gate. Phase 56: picker `Never` (`ttlOverrideMs: null`) on a
  // non-forever scope is also open — only the scope=forever
  // escalation is admin-gated.
  if (body.approved === true && body.scope === "forever" && user.role !== "admin") {
    return json(
      { error: "scope=forever requires admin role" },
      403,
    );
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

  // Phase 56: sticky last-pick (Never-suppression — Pitfall 3) ─────
  // Persist the picker's per-kind selection BEFORE resolving the gate
  // so a downstream sweep doesn't race the user's next mount. The
  // write is conditional on the picker producing a non-Never positive
  // override; null (Never) and undefined (legacy caller) both SKIP
  // the write so the user's previous sticky value is preserved.
  //
  // The capability kind comes from the live extension-gate registry
  // (`getPendingExtensionGate(toolCallId)`). The gate's `capabilityKind`
  // is `"shell" | "fs.write"` — we map onto the broader
  // `CapabilityExpiryKind` taxonomy via the existing helper so the
  // settings KV namespace (`user:<id>:reapprove:lastTtl:<kind>`) is
  // shared with the settings-side reapprove endpoint.
  //
  // If the gate cannot be found (test stubs, race conditions), fall
  // through to a `"unknown"` suffix — the user's sticky default for
  // an un-typed permission prompt is recoverable; we'd rather record
  // the picker's intent under a sentinel than drop it on the floor.
  if (
    body.approved === true &&
    ttlOverrideMs !== null &&
    ttlOverrideMs !== undefined
  ) {
    let kind: string = "unknown";
    if (typeof getPendingExtensionGate === "function") {
      const gate = getPendingExtensionGate(toolCallId);
      if (gate) {
        const mapped = mapAlwaysAllowCapabilityToExpiryKind(gate.capabilityKind);
        if (mapped) kind = mapped;
      }
    }
    try {
      await upsertSetting(
        `user:${user.id}:reapprove:lastTtl:${kind}`,
        ttlOverrideMs,
      );
    } catch {
      /* swallow — failure to record the sticky default is recoverable;
         the gate still resolves below. */
    }
  }

  // Phase 56: thread the validated ttlOverrideMs into the resolver as
  // an options object. The resolver always receives a 4th-arg
  // `options` (even when omitted by the caller — value is `undefined`
  // inside) so the resolver doesn't have to defend against arity
  // drift.
  resolvePermission(
    toolCallId,
    body.approved,
    body.scope as "session" | "conversation" | "project" | "forever" | undefined,
    { ttlOverrideMs },
  );
  return json({ ok: true });
}

/**
 * GET /api/projects/:id/tool-permission-mode
 */
export async function handleGetPermissionMode(_req: Request, projectId: string): Promise<Response> {
  const stored = await getSetting(`project:${projectId}:tool_permission_mode`);
  const mode = typeof stored === "string" && VALID_MODES.has(stored as PermissionMode)
    ? stored
    : DEFAULT_PERMISSION_MODE;
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
    const raw = (await req.json()) as unknown;
    body = (raw && typeof raw === "object" ? raw : {}) as {
      mode?: string;
      conversationId?: string;
    };
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
