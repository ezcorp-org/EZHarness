import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { requireAuth, requireRole } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { globalStats } from "$server/db/queries/audit-global";

/**
 * GET /api/audit/stats?range=24h|7d|30d
 *
 * Phase 52.4 — admin-only headline aggregates for the 24h stats strip
 * on `/audit`. Returns:
 *   - denialCount, totalCalls, totalCostUsd
 *   - top-3 chattiest extensions (by call count)
 *   - top-3 LLM spenders (by cost_usd in the LLM bucket)
 *
 * Range parsing falls back to 24h on unknown values.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  requireRole(locals, "admin");

  const range = url.searchParams.get("range") ?? "24h";
  const ms = parseRange(range);
  const stats = await globalStats(ms);
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
