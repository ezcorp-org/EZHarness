import { json } from "@sveltejs/kit";
import { z } from "zod";
import { getExtension } from "$server/db/queries/extensions";
import { requireAuth } from "$server/auth/middleware";
import {
  clearUserSettings,
  getUserSettings,
  setUserSettings,
} from "$server/db/queries/extension-settings";
import { errorJson } from "$lib/server/http-errors";
import type { ExtensionManifestV2 } from "$server/extensions/types";
import type { RequestHandler } from "./$types";

const userPutSchema = z.object({
  values: z.unknown(),
}).passthrough();

export const PUT: RequestHandler = async ({ request, params, locals }) => {
  const user = requireAuth(locals);

  const ext = await getExtension(params.id);
  if (!ext) return errorJson(404, "Not found");

  const manifest = ext.manifest as ExtensionManifestV2 | null;
  if (!manifest?.settings) {
    return errorJson(409, "Extension has no settings schema");
  }

  const parsed = userPutSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return errorJson(400, "values required");
  const { values } = parsed.data;
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    return errorJson(400, "values required");
  }

  await setUserSettings(user.id, params.id, values as Record<string, unknown>);
  const after = await getUserSettings(user.id, params.id);

  return json({ ok: true, userValues: after });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const user = requireAuth(locals);

  const ext = await getExtension(params.id);
  if (!ext) return errorJson(404, "Not found");

  await clearUserSettings(user.id, params.id);
  return json({ ok: true });
};
