/**
 * PATCH / DELETE /api/service-accounts/:id — lifecycle for one account.
 *
 * Same two gates, same order, same reasons as the collection route's WRITE
 * (`../+server.ts`): session-only via the positively-stamped
 * `locals.authMethod` allowlist, then admin role, both RETURNING their denial
 * — as the one shared `requireAdminSession`, so no route file here carries a
 * private copy of the pair that could ship with half of it.
 *
 * PATCH  → flip `enabled`, recording WHY on the way down. Disabling is the
 *          reversible half of removal and is what an admin reaches for when a
 *          job misbehaves; `disabled_reason` (`src/db/schema.ts:554`) exists so
 *          the next person can see it was deliberate.
 * DELETE → REFUSES (409) while live delegations name the account. The FK is
 *          `ON DELETE CASCADE` (`schema.ts:617`), so the database would accept
 *          the delete and silently destroy every authority granted to it. The
 *          schema makes the same argument one level up with `ON DELETE
 *          RESTRICT` on `created_by_user_id` (`schema.ts:528-538`): removing a
 *          principal that still holds authority must be a loud, explicit act.
 *          The refusal names the count so the admin knows what to revoke.
 */
import { json } from "@sveltejs/kit";
import { z } from "zod";
import type { RequestHandler } from "./$types";
import { errorJson } from "$lib/server/http-errors";
import { validationError } from "$lib/server/security/validation";
import { requireAdminSession } from "$server/auth/middleware";
import {
  deleteServiceAccount,
  getServiceAccount,
  setServiceAccountEnabled,
  toServiceAccountView,
  SERVICE_ACCOUNT_AUDIT_ACTIONS,
} from "$server/db/queries/service-accounts";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import type { AuthUser } from "$server/auth/types";

type ServiceAccountLocals = {
  user?: AuthUser;
  apiKeyScopes?: import("$server/auth/api-key").ApiKeyScope[];
  authMethod?: import("$server/auth/middleware").AuthMethod;
};

const patchSchema = z
  .object({
    enabled: z.boolean(),
    disabledReason: z.string().optional(),
  })
  .strict();

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const admin = requireAdminSession(locals as ServiceAccountLocals);
  if (admin instanceof Response) return admin;

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return validationError(parsed.error);

  const row = await setServiceAccountEnabled(
    params.id as string,
    parsed.data.enabled,
    parsed.data.disabledReason,
  );
  if (!row) return errorJson(404, "Service account not found");

  await insertAuditEntry(
    admin.id,
    parsed.data.enabled
      ? SERVICE_ACCOUNT_AUDIT_ACTIONS.ENABLED
      : SERVICE_ACCOUNT_AUDIT_ACTIONS.DISABLED,
    row.id,
    { name: row.name, disabledReason: row.disabledReason },
  );

  return json({ account: toServiceAccountView(row) });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  const admin = requireAdminSession(locals as ServiceAccountLocals);
  if (admin instanceof Response) return admin;

  // Read BEFORE the delete: the audit row must name what was removed, and
  // after a successful delete there is nothing left to read it from.
  const existing = await getServiceAccount(params.id as string);
  const result = await deleteServiceAccount(params.id as string);

  if (!result.ok && result.reason === "not-found") {
    return errorJson(404, "Service account not found");
  }
  if (!result.ok) {
    return errorJson(
      409,
      `Service account still owns ${result.delegationCount} live delegation(s). Revoke them first — deleting it would cascade those authorities away silently.`,
      { delegationCount: result.delegationCount },
    );
  }

  await insertAuditEntry(admin.id, SERVICE_ACCOUNT_AUDIT_ACTIONS.DELETED, params.id as string, {
    name: existing?.name,
    scopes: existing?.scopes,
  });

  return new Response(null, { status: 204 });
};
