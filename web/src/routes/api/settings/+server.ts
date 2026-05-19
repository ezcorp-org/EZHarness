import { json } from "@sveltejs/kit";
import * as settingQueries from "$server/db/queries/settings";
import { requireRole } from "$server/auth/middleware";
import { isSensitiveSettingKey } from "./deny-list";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals }) => {
  requireRole(locals, "admin");
  const all = await settingQueries.getAllSettings();
  // Scrub sensitive keys even from admin list views. They must be managed via
  // dedicated endpoints (e.g. instance:jwtSecret via src/auth/jwt.ts).
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(all)) {
    if (!isSensitiveSettingKey(k)) filtered[k] = v;
  }
  return json(filtered);
};
