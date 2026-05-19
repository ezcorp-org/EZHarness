import { eq, and } from "drizzle-orm";
import { getDb } from "../connection";
import { extensionSettingsUser, extensions } from "../schema";
import type {
  SettingsSchema,
  ExtensionManifestV2,
} from "../../extensions/types";
import { isValidForField } from "../../extensions/manifest";

/** Pure: pulls each field's `default` from the manifest schema. */
export function getDeclaredDefaults(
  schema: SettingsSchema | undefined,
): Record<string, unknown> {
  if (!schema) return {};
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema)) {
    if (field.default !== undefined) out[key] = field.default;
  }
  return out;
}

/** Pure: clamps a values blob against the schema. Drops unknown keys and
 *  invalid values. Never throws. The per-value validity rules live in
 *  `isValidForField` (src/extensions/manifest.ts) — the same predicate
 *  the admit-time validator uses for default checks. */
export function clampSettings(
  schema: SettingsSchema | undefined,
  values: unknown,
): Record<string, unknown> {
  if (!schema) return {};
  if (!values || typeof values !== "object" || Array.isArray(values)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(values as Record<string, unknown>)) {
    const field = schema[key];
    if (!field) continue;
    if (isValidForField(field, raw)) out[key] = raw;
  }
  return out;
}

async function getManifestSettings(
  extensionId: string,
): Promise<SettingsSchema | undefined> {
  const db = getDb();
  const rows = await db
    .select({ manifest: extensions.manifest })
    .from(extensions)
    .where(eq(extensions.id, extensionId));
  const manifest = rows[0]?.manifest as ExtensionManifestV2 | undefined;
  return manifest?.settings;
}

export async function getUserSettings(
  userId: string,
  extensionId: string,
): Promise<Record<string, unknown>> {
  const db = getDb();
  const rows = await db
    .select({ values: extensionSettingsUser.values })
    .from(extensionSettingsUser)
    .where(
      and(
        eq(extensionSettingsUser.userId, userId),
        eq(extensionSettingsUser.extensionId, extensionId),
      ),
    );
  return rows[0]?.values ?? {};
}

export async function setUserSettings(
  userId: string,
  extensionId: string,
  values: Record<string, unknown>,
): Promise<void> {
  const schema = await getManifestSettings(extensionId);
  const clean = clampSettings(schema, values);
  const db = getDb();
  const now = new Date();
  await db
    .insert(extensionSettingsUser)
    .values({
      userId,
      extensionId,
      values: clean,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [extensionSettingsUser.userId, extensionSettingsUser.extensionId],
      set: { values: clean, updatedAt: now },
    });
}

export async function clearUserSettings(
  userId: string,
  extensionId: string,
): Promise<void> {
  const db = getDb();
  await db
    .delete(extensionSettingsUser)
    .where(
      and(
        eq(extensionSettingsUser.userId, userId),
        eq(extensionSettingsUser.extensionId, extensionId),
      ),
    );
}

/** Resolves the effective settings for a (user, extension) pair.
 *  Merge order: declared defaults < user override. Unknown keys are
 *  clamped against the manifest schema. When the manifest has no
 *  `settings` block, returns `{}`. A `null` userId returns just the
 *  declared defaults (used by tool-call paths that have no user).
 *
 *  `schema`, when supplied, skips the per-call manifest DB lookup. The
 *  tool-executor already holds the manifest in-memory via the registry,
 *  so passing it here turns the per-tool-call path into a single
 *  `extension_settings_user` query (down from two). HTTP API callers
 *  that don't already have the schema in hand omit the arg and pay the
 *  extra DB round-trip — option A in the perf brief, chosen because it
 *  keeps the single-function surface. */
export async function resolveExtensionSettings(
  extensionId: string,
  userId: string | null,
  schema?: SettingsSchema,
): Promise<Record<string, unknown>> {
  const effectiveSchema = schema ?? await getManifestSettings(extensionId);
  if (!effectiveSchema) return {};
  const declared = getDeclaredDefaults(effectiveSchema);
  if (userId === null) return declared;
  const user = clampSettings(
    effectiveSchema,
    await getUserSettings(userId, extensionId),
  );
  return { ...declared, ...user };
}
