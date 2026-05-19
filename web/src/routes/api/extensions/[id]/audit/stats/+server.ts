import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { requireAuth, requireRole } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { statsForExtension } from "$server/db/queries/audit-merge";
import { getExtension } from "$server/db/queries/extensions";
import { errorJson } from "$lib/server/http-errors";

/**
 * GET /api/extensions/[id]/audit/stats?range=24h
 *
 * Phase 52.2 stats strip aggregate. Returns `{totalCalls, totalCostUsd,
 * successRate, denialCount}` for the requested rolling window.
 *
 * Range parsing:
 *   - "24h" (default) → 24 hours
 *   - "7d"            → 7 days
 *   - "30d"           → 30 days
 *   - any other value → 24h (silent fallback)
 *
 * Cost is an estimate — provider pricing tables drift, the page renders
 * an "approximate; provider billing may differ" disclaimer beneath the
 * strip. (Open question resolution per Phase 52 spec.)
 */
export const GET: RequestHandler = async ({ params, locals, url }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  requireRole(locals, "admin");

  const ext = await getExtension(params.id);
  if (!ext) return errorJson(404, "Not found");

  const rangeStr = url.searchParams.get("range") ?? "24h";
  const rangeMs = parseRange(rangeStr);

  const stats = await statsForExtension(params.id, rangeMs);
  return json(stats);
};

const RANGE_MS = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
} as const;

function parseRange(raw: string): number {
  if (raw in RANGE_MS) return RANGE_MS[raw as keyof typeof RANGE_MS];
  return RANGE_MS["24h"];
}
