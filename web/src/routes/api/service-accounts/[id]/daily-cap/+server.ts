/**
 * PATCH /api/service-accounts/:id/daily-cap — the D10 remedy, made reachable.
 *
 * ## The deny message that named an action nobody could take
 *
 * Rung D10 (`src/extensions/workflows-handler.ts:1609-1619`) refuses a
 * delegated fire once the OWNING service account has spent
 * `max_tokens_per_day` across every delegation it owns, and the rung's own
 * docblock is explicit that the three token bounds have three different
 * remedies: "wait for tomorrow / raise the delegation's cap / raise the
 * ACCOUNT's cap, which is an admin action on a different object". The first
 * two exist. The third did not: `POST /api/service-accounts` wrote the value
 * once at mint time and no route could ever move it, so an account that hit
 * its day was stuck at that number forever and the only workaround was to
 * delete the account — which `DELETE` correctly refuses while it owns live
 * delegations. This is the same shape phase 8a closed one level down for
 * `max_tokens_per_run`; this closes it for the account.
 *
 * ## Its OWN route, not a third arm on `PATCH /api/service-accounts/:id`
 *
 * That route's body is `.strict()` with `enabled` REQUIRED, and its whole
 * subject is the enable/disable lifecycle — it audits `service-account:enabled`
 * or `service-account:disabled` on every call. Folding a budget change into it
 * would mean either making `enabled` optional (so an empty body becomes a
 * valid "update", and the audit action becomes a guess) or a union body whose
 * two arms audit different things through one handler. A cap change is a
 * different act with a different reason and a different audit row, so it gets
 * a different URL. `.strict()` on both keeps each refusal specific.
 *
 * ## Admin, and SESSION-ONLY
 *
 * `requireAdminSession` — the same pair the mint uses, for the same reason.
 * This number decides how much unattended LLM spend a whole family of jobs may
 * make in a day; a leaked API key of any scope must not be able to raise it,
 * and no key of any scope can reach this route. Session-only is also why the
 * registry entry carries NO `scope`: `scope` renders as
 * `security: [{ bearerAuth: [scope] }]` (`src/openapi.ts:41`), i.e. "call this
 * with a key holding that scope", and publishing that for a route no key can
 * reach would be a documented lie about a security boundary. Same precedent as
 * `POST /api/workflows/approvals/:id` (`src/api-registry.ts:310-316`).
 *
 * ## It raises OR lowers
 *
 * Named for the remedy it exists to serve, but nothing here is one-way.
 * Tightening a standing budget must never be harder than widening it — the
 * identical rule the delegation ceiling's e2e pins ("a limit can be LOWERED,
 * not only raised"). A cap BELOW today's spend is legal and takes effect at the
 * next fire, because D10 compares the day's total against whatever the column
 * says at dispatch.
 *
 * ## What it does not touch
 *
 * `enabled`, `disabled_reason`, `scopes`, `created_by_user_id` — see
 * {@link setServiceAccountDailyTokenCap}. A disabled account's cap IS
 * writable (an admin fixing the budget before switching it back on is the
 * ordinary sequence) but writing it does not switch it back on.
 */
import { json } from "@sveltejs/kit";
import { z } from "zod";
import type { RequestHandler } from "./$types";
import { errorJson } from "$lib/server/http-errors";
import { validationError } from "$lib/server/security/validation";
import { requireAdminSession } from "$server/auth/middleware";
import {
  setServiceAccountDailyTokenCap,
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

/**
 * One field, `.strict()`, positive integer — matching the mint's schema
 * exactly.
 *
 * RULING 3 is why there is no cents field here either: the token cap is the
 * ENFORCED bound and cost is advisory, because an OAuth-subscription model
 * reports a null price and would spend without bound under a cost cap
 * (`src/db/schema.ts:548-551`). `maxCostCentsPerDay` is REFUSED by `.strict()`
 * rather than ignored, so a caller cannot come away believing it set a cap.
 *
 * Zero is refused, and deliberately not treated as "pause this account": D10
 * fires at `spentToday >= cap`, so a cap of 0 denies every fire with a message
 * about a spent budget when the truth is that the account was switched off.
 * `PATCH /api/service-accounts/:id` with `enabled: false` is how you say that,
 * and it records a reason.
 */
const bodySchema = z.object({ maxTokensPerDay: z.number().int().positive() }).strict();

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const admin = requireAdminSession(locals as ServiceAccountLocals);
  if (admin instanceof Response) return admin;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return validationError(parsed.error);

  const row = await setServiceAccountDailyTokenCap(
    params.id as string,
    parsed.data.maxTokensPerDay,
  );
  if (!row) return errorJson(404, "Service account not found");

  // The BEFORE value is not carried: the write returns only the new row, and
  // reading the old one first would be a second round-trip for a number the
  // previous audit row already holds. `audit_log` is append-only, so the
  // history is the sequence.
  await insertAuditEntry(admin.id, SERVICE_ACCOUNT_AUDIT_ACTIONS.DAILY_CAP_CHANGED, row.id, {
    name: row.name,
    maxTokensPerDay: row.maxTokensPerDay,
  });

  return json({ account: toServiceAccountView(row) });
};
