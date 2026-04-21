import { json } from "@sveltejs/kit";
import { requireAuth } from "$server/auth/middleware";
import { createFlag, countPendingFlagsByUser } from "$server/db/queries/marketplace-ratings";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";

const VALID_CATEGORIES = ["spam", "malicious", "misleading", "inappropriate", "other"] as const;
type FlagCategory = (typeof VALID_CATEGORIES)[number];

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const scopeErr = requireScope(locals, "extensions");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const body = await request.json();
  const { reason, category } = body as { reason: string; category?: string };

  if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
    return json({ error: "reason is required and must be a non-empty string" }, { status: 400 });
  }

  // Rate limiting: max 5 flags per user per hour
  const recentCount = await countPendingFlagsByUser(user.id);
  if (recentCount >= 5) {
    return json({ error: "Rate limit exceeded: max 5 flags per hour" }, { status: 429 });
  }

  const validCategory: FlagCategory = category && VALID_CATEGORIES.includes(category as FlagCategory)
    ? (category as FlagCategory)
    : "other";

  await createFlag(params.id, user.id, reason.trim(), validCategory);
  await insertAuditEntry(user.id, "marketplace:flag", params.id, { reason: reason.trim(), category: validCategory });

  return json({ ok: true });
};
