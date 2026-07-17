/**
 * POST /api/extensions/:name/webhooks/:slug/rotate
 *
 * Mint (rotate) a webhook hook's per-hook secret and return the plaintext
 * ONCE (Loops EZ Mode Phase 4) — reusing the shown-once secrets UX. Rotation
 * invalidates the previous token immediately.
 *
 * SECURITY / AUTHZ:
 *   - Admin-gated (`checkRole(locals, "admin")` — role for cookie sessions,
 *     scope for API-key principals). Webhook-secret rotation is the same trust
 *     class as writing an extension secret.
 *   - Only a slug with a live (enabled) registry row can be rotated — a missing
 *     hook returns an opaque 404 (never an existence oracle).
 *   - The plaintext is returned ONCE in the response body and is NEVER logged;
 *     the audit row carries `{slug}` only.
 */
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { errorJson } from "$lib/server/http-errors";
import { checkRole } from "$server/auth/middleware";
import { getEnabledWebhook } from "$server/extensions/webhook-store";
import { mintWebhookSecret } from "$server/extensions/webhook-secret";
import { WEBHOOK_SLUG_RE } from "$server/extensions/manifest";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { EXT_AUDIT_ACTIONS } from "$server/extensions/audit-actions";

export const POST: RequestHandler = async ({ params, locals }) => {
  const gate = checkRole(locals, "admin");
  if (gate instanceof Response) return gate;

  const name = params.name;
  const slug = params.slug;

  // Opaque 404 for a malformed or unknown/disabled hook (never an oracle).
  if (!WEBHOOK_SLUG_RE.test(slug)) return errorJson(404, "Not found");
  const hook = await getEnabledWebhook(name, slug);
  if (!hook) return errorJson(404, "Not found");

  const secret = await mintWebhookSecret(name, slug, gate.id);
  await insertAuditEntry(gate.id, EXT_AUDIT_ACTIONS.SDK_WEBHOOK_SECRET_ROTATED, name, {
    slug,
  }).catch(() => {});

  // Shown once — the caller must store it now; it is unreadable afterward.
  return json({ slug, secret });
};
