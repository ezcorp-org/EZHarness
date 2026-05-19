import { json } from "@sveltejs/kit";
import { z } from "zod";
import { getExtension } from "$server/db/queries/extensions";
import { requireAuth } from "$server/auth/middleware";
import {
  clearUserSettings,
  getUserSettings,
  setUserSettings,
} from "$server/db/queries/extension-settings";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { EXT_AUDIT_ACTIONS } from "$server/extensions/audit-actions";
import { errorJson } from "$lib/server/http-errors";
import type { ExtensionManifestV2 } from "$server/extensions/types";
import type { RequestHandler } from "./$types";

const userPutSchema = z.looseObject({
  values: z.unknown(),
});

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

  // Snapshot the prior values for the audit row before we overwrite.
  const before = await getUserSettings(user.id, params.id);

  await setUserSettings(user.id, params.id, values as Record<string, unknown>);
  const after = await getUserSettings(user.id, params.id);

  // Settings can carry user-controlled secrets (e.g. an API key in a
  // text field — there's no `secret:true` flag yet), so we audit the
  // mutation. Mirrors the metadata shape Permissions PUT uses:
  // `permission` is the field-level discriminator (here the literal
  // "settings.user"), `oldValue` / `newValue` are the post-clamp
  // blobs, and `submitted` carries the raw user input for forensics.
  try {
    await insertAuditEntry(user.id, EXT_AUDIT_ACTIONS.SETTINGS_USER_UPDATED, params.id, {
      permission: "settings.user",
      oldValue: before,
      newValue: after,
      actor: user.id,
      reason: "user-update",
      before,
      after,
      submitted: values,
    });
  } catch { /* swallow */ }

  return json({ ok: true, userValues: after });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const user = requireAuth(locals);

  const ext = await getExtension(params.id);
  if (!ext) return errorJson(404, "Not found");

  // Symmetric with PUT: an extension with no `settings` block has no
  // user-values surface — refuse the reset rather than silently no-op.
  const manifest = ext.manifest as ExtensionManifestV2 | null;
  if (!manifest?.settings) {
    return errorJson(409, "Extension has no settings schema");
  }

  // Snapshot pre-delete values so the audit row can capture what was
  // actually wiped (forensic trail).
  const before = await getUserSettings(user.id, params.id);

  await clearUserSettings(user.id, params.id);

  try {
    await insertAuditEntry(user.id, EXT_AUDIT_ACTIONS.SETTINGS_USER_RESET, params.id, {
      permission: "settings.user",
      oldValue: before,
      newValue: {},
      actor: user.id,
      reason: "user-reset",
      before,
    });
  } catch { /* swallow */ }

  return json({ ok: true });
};
