import { json } from "@sveltejs/kit";
import { z } from "zod";
import { getExtension } from "$server/db/queries/extensions";
import { requireAuth } from "$server/auth/middleware";
import {
  clearUserSettings,
  getUserSettings,
  setUserSettings,
} from "$server/db/queries/extension-settings";
import {
  clearSecretSetting,
  probeSecretSettings,
  setSecretSetting,
} from "$server/extensions/secret-settings";
import { isValidForField } from "$server/extensions/manifest";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { EXT_AUDIT_ACTIONS } from "$server/extensions/audit-actions";
import { errorJson } from "$lib/server/http-errors";
import type { ExtensionManifestV2 } from "$server/extensions/types";
import type { RequestHandler } from "./$types";

const userPutSchema = z.looseObject({
  values: z.unknown(),
});

/** One validated mutation against a secret field's storage row. */
interface SecretOp {
  key: string;
  storageKey: string;
  action: "set" | "clear";
  /** Plaintext to encrypt+store — present only for `set`. Never logged,
   *  never echoed, never written to audit metadata. */
  value?: string;
}

export const PUT: RequestHandler = async ({ request, params, locals }) => {
  const user = requireAuth(locals);

  const ext = await getExtension(params.id);
  if (!ext) return errorJson(404, "Not found");

  const manifest = ext.manifest as ExtensionManifestV2 | null;
  if (!manifest?.settings) {
    return errorJson(409, "Extension has no settings schema");
  }
  const schema = manifest.settings;

  const parsed = userPutSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return errorJson(400, "values required");
  const { values } = parsed.data;
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    return errorJson(400, "values required");
  }

  // Partition secret-typed keys out of the blob: their plaintext is
  // encrypted into extension storage (scope "user"), NEVER into the
  // settings JSON (clampSettings drops them as defense in depth).
  // Validate everything BEFORE applying anything, so a 400 never
  // leaves a half-applied save behind.
  const secretOps: SecretOp[] = [];
  const nonSecretValues: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(values as Record<string, unknown>)) {
    const field = schema[key];
    if (field?.type !== "secret") {
      nonSecretValues[key] = raw;
      continue;
    }
    if (typeof raw !== "string") {
      return errorJson(400, `values.${key} must be a string`);
    }
    if (raw === "") {
      // Explicit empty string = clear the stored secret.
      secretOps.push({ key, storageKey: field.storageKey, action: "clear" });
      continue;
    }
    if (!isValidForField(field, raw)) {
      return errorJson(
        400,
        `values.${key} must be a non-empty string of at most 512 characters`,
      );
    }
    secretOps.push({ key, storageKey: field.storageKey, action: "set", value: raw });
  }

  // Snapshot the prior values for the audit row before we overwrite.
  const before = await getUserSettings(user.id, params.id);

  await setUserSettings(user.id, params.id, nonSecretValues);
  for (const op of secretOps) {
    if (op.action === "set") {
      await setSecretSetting(params.id, user.id, op.storageKey, op.value!);
    } else {
      await clearSecretSetting(params.id, user.id, op.storageKey);
    }
  }
  const after = await getUserSettings(user.id, params.id);

  // Settings can carry user-controlled secrets (e.g. an API key in a
  // text field), so we audit the mutation. Mirrors the metadata shape
  // Permissions PUT uses: `permission` is the field-level discriminator
  // (here the literal "settings.user"), `oldValue` / `newValue` are the
  // post-clamp blobs, and `submitted` carries the raw user input for
  // forensics. Secret fields appear NAME-ONLY (`secretsSet` /
  // `secretsCleared`) — their plaintext never reaches the audit log.
  try {
    await insertAuditEntry(user.id, EXT_AUDIT_ACTIONS.SETTINGS_USER_UPDATED, params.id, {
      permission: "settings.user",
      oldValue: before,
      newValue: after,
      actor: user.id,
      reason: "user-update",
      before,
      after,
      submitted: nonSecretValues,
      secretsSet: secretOps.filter((o) => o.action === "set").map((o) => o.key),
      secretsCleared: secretOps.filter((o) => o.action === "clear").map((o) => o.key),
    });
  } catch { /* swallow */ }

  // `secrets` mirrors the GET payload (post-apply existence probes) so the
  // client can refresh its Set/Not-set affordances without a second fetch.
  // No response byte ever carries a secret value.
  const secrets = await probeSecretSettings(params.id, user.id, schema);
  return json({ ok: true, userValues: after, secrets });
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
