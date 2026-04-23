import { json } from "@sveltejs/kit";
import * as settingQueries from "$server/db/queries/settings";
import { requireRole } from "$server/auth/middleware";
import { isSensitiveSettingKey } from "../deny-list";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

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
  requireRole(locals, "admin");
  const denied = denyIfSensitive(params.key);
  if (denied) return denied;
  const value = await settingQueries.getSetting(params.key);
  if (value === undefined) return errorJson(404, "Not found");
  return json({ value });
};

export const PUT: RequestHandler = async ({ request, params, locals }) => {
  requireRole(locals, "admin");
  const denied = denyIfSensitive(params.key);
  if (denied) return denied;
  const body = (await request.json()) as { value: unknown };
  if (body.value === undefined) {
    return errorJson(400, "value required");
  }
  await settingQueries.upsertSetting(params.key, body.value);
  return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  requireRole(locals, "admin");
  const denied = denyIfSensitive(params.key);
  if (denied) return denied;
  const deleted = await settingQueries.deleteSetting(params.key);
  if (!deleted) return errorJson(404, "Not found");
  return json({ ok: true });
};
