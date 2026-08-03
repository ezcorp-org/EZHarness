import { json } from "@sveltejs/kit";
import * as settingQueries from "$server/db/queries/settings";
import { requireAdmin } from "$lib/server/security/api-keys";
import { isSensitiveSettingKey } from "./deny-list";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals }) => {
  // requireAdmin RETURNS the 403 Response; requireRole THREW one, which
  // SvelteKit surfaces as a 500 from a route handler. Role-only, so the
  // route's "no API-key scope gate" contract is unchanged.
  const adminErr = requireAdmin(locals);
  if (adminErr) return adminErr;
  const all = await settingQueries.getAllSettings();
  // Scrub sensitive keys even from admin list views. They must be managed via
  // dedicated endpoints (e.g. instance:jwtSecret via src/auth/jwt.ts).
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(all)) {
    if (!isSensitiveSettingKey(k)) filtered[k] = v;
  }
  return json(filtered);
};
