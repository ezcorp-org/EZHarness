import { json } from "@sveltejs/kit";
import { z } from "zod";
import * as settingQueries from "$server/db/queries/settings";
import { checkRole } from "$server/auth/middleware";
import { isSensitiveSettingKey } from "../deny-list";
import { errorJson } from "$lib/server/http-errors";
import {
  TIER_LADDER_SETTING_KEY,
  validateTierLadder,
} from "$server/runtime/routing/tier-ladder";
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

/**
 * Per-key write-time validation. Settings are deliberately schema-less at the
 * boundary (see the note above), but a key routing READS on every turn is
 * different: a malformed ladder is ignored at read time by design, which would
 * make a typo a silent no-op. So the ladder is validated HERE — the only place
 * that can tell the operator their edit was wrong — and the normalized
 * (trimmed, three-tier) value is what lands in the row.
 *
 * Returns the value to store, or a Response describing the rejection.
 */
function validateForKey(key: string, value: unknown): { value: unknown } | Response {
  if (key !== TIER_LADDER_SETTING_KEY) return { value };
  const result = validateTierLadder(value);
  if (!result.ok) return errorJson(400, `Invalid ${key}: ${result.error}`);
  return { value: result.ladder };
}

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
  const validated = validateForKey(params.key, parsed.data.value);
  if (validated instanceof Response) return validated;
  await settingQueries.upsertSetting(params.key, validated.value);
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
