import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { requireAuth, requireRole } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { listGlobalAudit } from "$server/db/queries/audit-global";

/**
 * GET /api/audit
 *
 * Phase 52.4 — admin-only global audit feed. Cross-extension cursor-
 * paginated read over `sdk_capability_calls` + governance rows.
 *
 * Auth: admin only — same gate as `/api/audit-log`. Mirrors the role
 * guard so an API-key with the `admin` scope can drive analytics
 * tooling without a session cookie.
 *
 * Query params:
 *   ?extensionId=…
 *   ?capability=llm|memory|lessons|schedule|events
 *   ?action=ext:permission-granted   (legacy or typed string)
 *   ?onBehalfOf=<userId>
 *   ?denialOnly=true
 *   ?search=<substring>              (resourceId / errorMessage / model)
 *   ?cursor=<base64>
 *   ?limit=<n>                       (clamp [1,200])
 */
export const GET: RequestHandler = async ({ url, locals }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  requireRole(locals, "admin");

  const KNOWN_CAPS = new Set(["llm", "memory", "lessons", "schedule", "events"]);
  const cap = url.searchParams.get("capability");
  const capability = cap && KNOWN_CAPS.has(cap)
    ? (cap as "llm" | "memory" | "lessons" | "schedule" | "events")
    : undefined;
  const extensionId = url.searchParams.get("extensionId") ?? undefined;
  const action = url.searchParams.get("action") ?? undefined;
  const onBehalfOf = url.searchParams.get("onBehalfOf") ?? undefined;
  const denialOnly = url.searchParams.get("denialOnly") === "true";
  const search = url.searchParams.get("search") ?? undefined;
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit ? parseInt(rawLimit, 10) : undefined;

  const { entries, nextCursor } = await listGlobalAudit({
    extensionId,
    capability,
    action,
    onBehalfOf,
    denialOnly,
    search,
    cursor,
    limit,
  });

  return json({ entries, nextCursor });
};
