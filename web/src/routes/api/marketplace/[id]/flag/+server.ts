import { json } from "@sveltejs/kit";
import { z } from "zod";
import { requireAuth } from "$server/auth/middleware";
import { createFlag, countPendingFlagsByUser } from "$server/db/queries/marketplace-ratings";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

const VALID_CATEGORIES = ["spam", "malicious", "misleading", "inappropriate", "other"] as const;
type FlagCategory = (typeof VALID_CATEGORIES)[number];

// Boundary validation. The handler reads `reason` (required, non-empty
// after trim) and `category` (optional; falls back to "other" if not in
// the allowlist). Schema accepts `category` as any string so the
// post-parse fallback to "other" still runs for unknown values — that
// preserves the existing "be permissive" behaviour. Required-reason
// 400 message is preserved exactly.
const flagPostSchema = z.object({
  reason: z.string().trim().min(1, "reason is required and must be a non-empty string"),
  category: z.string().optional(),
}).passthrough();

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const scopeErr = requireScope(locals, "extensions");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const parsed = flagPostSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return errorJson(400, "reason is required and must be a non-empty string");
  }
  const { reason, category } = parsed.data;

  // Rate limiting: max 5 flags per user per hour
  const recentCount = await countPendingFlagsByUser(user.id);
  if (recentCount >= 5) {
    return errorJson(429, "Rate limit exceeded: max 5 flags per hour");
  }

  const validCategory: FlagCategory = category && VALID_CATEGORIES.includes(category as FlagCategory)
    ? (category as FlagCategory)
    : "other";

  await createFlag(params.id, user.id, reason.trim(), validCategory);
  await insertAuditEntry(user.id, "marketplace:flag", params.id, { reason: reason.trim(), category: validCategory });

  return json({ ok: true });
};
