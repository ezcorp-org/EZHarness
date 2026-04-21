import { json } from "@sveltejs/kit";
import * as settingQueries from "$server/db/queries/settings";
import { requireRole } from "$server/auth/middleware";
import { isSensitiveSettingKey } from "../deny-list";
import type { RequestHandler } from "./$types";

function denyIfSensitive(key: string): Response | null {
  if (isSensitiveSettingKey(key)) {
    return json(
      { error: "This setting key is managed internally and cannot be accessed via the settings API" },
      { status: 403 },
    );
  }
  return null;
}

export const GET: RequestHandler = async ({ params, locals }) => {
  requireRole(locals, "admin");
  const denied = denyIfSensitive(params.key);
  if (denied) return denied;
  const value = await settingQueries.getSetting(params.key);
  if (value === undefined) return json({ error: "Not found" }, { status: 404 });
  return json({ value });
};

export const PUT: RequestHandler = async ({ request, params, locals }) => {
  requireRole(locals, "admin");
  const denied = denyIfSensitive(params.key);
  if (denied) return denied;
  const body = (await request.json()) as { value: unknown };
  if (body.value === undefined) {
    return json({ error: "value required" }, { status: 400 });
  }
  await settingQueries.upsertSetting(params.key, body.value);
  return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  requireRole(locals, "admin");
  const denied = denyIfSensitive(params.key);
  if (denied) return denied;
  const deleted = await settingQueries.deleteSetting(params.key);
  if (!deleted) return json({ error: "Not found" }, { status: 404 });
  return json({ ok: true });
};
