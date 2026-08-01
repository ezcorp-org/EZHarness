/**
 * The instance default for a user who has NO saved model selection —
 * `provider:defaultSelection`, one of `"auto"` (ship default: route the first
 * turn) or `"first"` (the pre-routing behaviour: pin `models[0]`).
 *
 * Why this endpoint exists rather than reading the key through the generic
 * `GET /api/settings/:key`: that route is admin-only, so a non-admin member
 * would never see an operator's `"first"` revert and would keep getting routed
 * turns. The revert knob has to reach EVERY user, so the value is served here
 * under the plain `read` scope. Nothing sensitive is disclosed — the response
 * is one of two literal strings.
 *
 * The value is normalized server-side (`parseDefaultSelection`), so the client
 * always receives a valid mode and an absent/malformed row degrades to
 * `"auto"` instead of failing the composer.
 */
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getSetting } from "$server/db/queries/settings";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import {
  DEFAULT_SELECTION_SETTING_KEY,
  parseDefaultSelection,
} from "$lib/model-selector-logic";

export const GET: RequestHandler = async ({ locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);

  const stored = await getSetting(DEFAULT_SELECTION_SETTING_KEY);
  return json({ value: parseDefaultSelection(stored) });
};
