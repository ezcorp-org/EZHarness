import { json } from "@sveltejs/kit";
import { z } from "zod";
import * as settingQueries from "$server/db/queries/settings";
import { checkRole } from "$server/auth/middleware";
import { isSensitiveSettingKey } from "../deny-list";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

// Boundary validation for setting upsert. `value` is intentionally
// `z.unknown()` because settings are wide-open scalars/objects (theme
// strings, JSON config blobs, etc.). The schema's only job is to
// fence off unknown top-level fields; the inline `value === undefined`
// check below stays so the test-pinned 400 "value required" message
// fires for both missing-key and explicit-undefined bodies.
const upsertSettingSchema = z.object({
  value: z.unknown(),
}).strict();

function denyIfSensitive(key: string): Response | null {
  if (isSensitiveSettingKey(key)) {
    return errorJson(
      403,
      "This setting key is managed internally and cannot be accessed via the settings API",
    );
  }
  return null;
}

export const GET: RequestHandler = async ({ params, locals }) => {
  const admin = checkRole(locals, "admin");
  if (admin instanceof Response) return admin;
  const denied = denyIfSensitive(params.key);
  if (denied) return denied;
  const value = await settingQueries.getSetting(params.key);
  if (value === undefined) return errorJson(404, "Not found");
  return json({ value });
};

export const PUT: RequestHandler = async ({ request, params, locals }) => {
  const admin = checkRole(locals, "admin");
  if (admin instanceof Response) return admin;
  const denied = denyIfSensitive(params.key);
  if (denied) return denied;
  const parsed = upsertSettingSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return errorJson(400, "value required");
  }
  if (parsed.data.value === undefined) {
    return errorJson(400, "value required");
  }
  await settingQueries.upsertSetting(params.key, parsed.data.value);
  return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const admin = checkRole(locals, "admin");
  if (admin instanceof Response) return admin;
  const denied = denyIfSensitive(params.key);
  if (denied) return denied;
  const deleted = await settingQueries.deleteSetting(params.key);
  if (!deleted) return errorJson(404, "Not found");
  return json({ ok: true });
};
