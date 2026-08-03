/**
 * GET / POST /api/service-accounts — the C3 service-account admin surface.
 *
 * A service account is a NON-HUMAN principal that exists only as a `run_as`
 * target for a delegated workflow. It has no `users` row, no password hash, no
 * session and no API key, so it cannot authenticate at all — compromising the
 * identity yields nothing beyond the jobs already delegated to it.
 *
 * ## SESSION-ONLY, and admin — both axes, from the first commit
 *
 * `requireSessionAuth` (`src/auth/middleware.ts:169`) first, `checkRole` second:
 *
 *   - Session, because minting a principal that other people's jobs will later
 *     run as is a HUMAN decision, not a capability. The discriminator is the
 *     positively-stamped `locals.authMethod === "session"` allowlist, NOT the
 *     negative inference `locals.apiKeyScopes === undefined` — an inference
 *     from an absence silently flips to ALLOW the day a fourth auth method
 *     populates `locals.user` without touching `apiKeyScopes`
 *     (`middleware.ts:140-153`). No key of any scope reaches this route.
 *   - Admin, because the account's scope ceiling is the CREATOR's scope set.
 *
 * Both gates RETURN their denial. Neither throws: SvelteKit does not recognise
 * a thrown `Response` from a `+server.ts` handler and answers 500 instead of
 * the 401/403 that was meant (`middleware.ts:69-96`, and the static scan in
 * `web/src/__tests__/route-contract.test.ts`).
 *
 * ## The reach warning ships on the response
 *
 * Spec §6.5: an admin must be told AT CREATION that a service account can only
 * be delegated `system`-visible workflows — otherwise every user who later
 * picks one for a forked workflow (fork stamps `visibility: "project"`,
 * `web/src/routes/api/workflows/[name]/fork/+server.ts:65`) hits the §6.1
 * consent refusal and files a bug. The creation UI is a later phase, so the
 * warning ships here MACHINE-READABLE — `reach.code`, `reach.runnableVisibilities`
 * and `reach.message`, derived from the live ladder by `serviceAccountReach()`
 * — for that UI to render without re-deriving (or mis-deriving) it.
 *
 * ## Where the rules live
 *
 * Scope clamping and every mint-time invariant live in
 * `src/db/queries/service-accounts.ts`, not here: a second call site (a CLI, a
 * seeder) must not be able to reach the insert without the clamp. This route
 * validates the wire and maps typed refusals to statuses.
 */
import { json } from "@sveltejs/kit";
import { z } from "zod";
import type { RequestHandler } from "./$types";
import { errorJson } from "$lib/server/http-errors";
import { validationError } from "$lib/server/security/validation";
import { requireSessionAuth, checkRole } from "$server/auth/middleware";
import {
  createServiceAccount,
  listServiceAccounts,
  serviceAccountReach,
  toServiceAccountView,
  InvalidServiceAccountError,
  SERVICE_ACCOUNT_AUDIT_ACTIONS,
} from "$server/db/queries/service-accounts";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import type { AuthUser } from "$server/auth/types";

/** App.Locals slice these handlers read. */
type ServiceAccountLocals = {
  user?: AuthUser;
  apiKeyScopes?: import("$server/auth/api-key").ApiKeyScope[];
  authMethod?: import("$server/auth/middleware").AuthMethod;
};

/**
 * The two gates, in order, as ONE call — so a second method cannot ship with
 * only half of them. Returns the admin, or the denial to hand straight back.
 */
function gate(locals: ServiceAccountLocals): AuthUser | Response {
  const session = requireSessionAuth(locals);
  if (session instanceof Response) return session;
  return checkRole(locals, "admin");
}

/**
 * `max_tokens_per_day`, and there is no cents field — RULING 3: the token cap
 * is ENFORCED and cost is ADVISORY. A cost cap cannot bind an
 * OAuth-subscription model, which reports a null price and would spend without
 * bound under one (`src/db/schema.ts:548-551`). A body carrying
 * `maxCostCentsPerDay` is REFUSED rather than ignored: silently dropping it
 * would leave a caller believing they had set a cap.
 */
const createSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    projectId: z.string().min(1).nullable().optional(),
    scopes: z.array(z.string()).optional(),
    maxTokensPerDay: z.number().int().positive(),
  })
  .strict();

export const GET: RequestHandler = async ({ locals, url }) => {
  const admin = gate(locals as ServiceAccountLocals);
  if (admin instanceof Response) return admin;

  const projectId = url.searchParams.get("projectId") ?? undefined;
  const accounts = await listServiceAccounts(projectId);
  return json({
    accounts: accounts.map(toServiceAccountView),
    // Carried on the LIST too, not only on create: the picker that renders
    // these is the other place a human chooses a service account, and it needs
    // the same sentence.
    reach: serviceAccountReach(),
  });
};

export const POST: RequestHandler = async ({ locals, request }) => {
  const admin = gate(locals as ServiceAccountLocals);
  if (admin instanceof Response) return admin;

  const raw = await request.json().catch(() => null);
  if (raw === null || typeof raw !== "object") return errorJson(400, "Invalid body");
  if ("maxCostCentsPerDay" in (raw as Record<string, unknown>)) {
    return errorJson(
      400,
      "maxCostCentsPerDay is not a field: the enforced spend bound is maxTokensPerDay (tokens), because an unpriced model would spend without bound under a cost cap",
    );
  }
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed.error);

  let created: Awaited<ReturnType<typeof createServiceAccount>>;
  try {
    created = await createServiceAccount({
      name: parsed.data.name,
      description: parsed.data.description,
      createdBy: admin,
      projectId: parsed.data.projectId ?? null,
      scopes: parsed.data.scopes,
      maxTokensPerDay: parsed.data.maxTokensPerDay,
    });
  } catch (err) {
    if (err instanceof InvalidServiceAccountError) return errorJson(400, err.message);
    throw err;
  }

  // Scope NAMES only — the row carries no secret material to leak.
  await insertAuditEntry(
    admin.id,
    SERVICE_ACCOUNT_AUDIT_ACTIONS.CREATED,
    created.account.id,
    {
      name: created.account.name,
      projectId: created.account.projectId,
      scopes: created.account.scopes,
      droppedScopes: created.droppedScopes,
      maxTokensPerDay: created.account.maxTokensPerDay,
    },
  );

  return json(
    {
      account: toServiceAccountView(created.account),
      // What the clamp took away. Empty for every admin today (they resolve to
      // the all-scopes sentinel), non-empty the day narrower admin roles exist
      // — and a caller that is never told would think it got what it asked for.
      droppedScopes: created.droppedScopes,
      reach: created.reach,
    },
    { status: 201 },
  );
};
