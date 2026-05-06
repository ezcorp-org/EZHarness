import { json } from "@sveltejs/kit";
import { z } from "zod";
import { getExtension } from "$server/db/queries/extensions";
import { requireRole } from "$server/auth/middleware";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { EXT_AUDIT_ACTIONS } from "$server/extensions/audit-actions";
import {
  getGlobalSettings,
  setGlobalSettings,
} from "$server/db/queries/extension-settings";
import { errorJson } from "$lib/server/http-errors";
import type { ExtensionManifestV2 } from "$server/extensions/types";
import type { RequestHandler } from "./$types";

const globalPutSchema = z.object({
  values: z.unknown(),
}).passthrough();

export const PUT: RequestHandler = async ({ request, params, locals }) => {
  const admin = requireRole(locals, "admin");

  const ext = await getExtension(params.id);
  if (!ext) return errorJson(404, "Not found");

  const manifest = ext.manifest as ExtensionManifestV2 | null;
  if (!manifest?.settings) {
    return errorJson(409, "Extension has no settings schema");
  }

  const parsed = globalPutSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return errorJson(400, "values required");
  const { values } = parsed.data;
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    return errorJson(400, "values required");
  }

  const before = await getGlobalSettings(params.id);
  await setGlobalSettings(params.id, values as Record<string, unknown>, admin.id);
  const after = await getGlobalSettings(params.id);

  try {
    await insertAuditEntry(admin.id, EXT_AUDIT_ACTIONS.SETTINGS_GLOBAL_UPDATED, params.id, {
      actor: admin.id,
      before,
      after,
      submitted: values,
    });
  } catch { /* swallow */ }

  return json({ ok: true, globalValues: after });
};
