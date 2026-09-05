import { json } from "@sveltejs/kit";
import { z } from "zod";
import { requireSessionAuth } from "$server/auth/middleware";
import { errorJson } from "$lib/server/http-errors";
import { resolveDelegationConsentOr } from "$lib/server/workflow-access";
import { buildDelegationConsent } from "$lib/server/delegation-consent";
import { ExtensionRegistry } from "$server/extensions/registry";
import {
  createWorkflowDelegation,
  listWorkflowDelegationsConsentedBy,
  toWorkflowDelegationView,
} from "$server/db/queries/workflow-delegations";
// The existence-and-liveness read lives with the rest of the
// service-account query layer, not with delegation CRUD: it is a
// `service_accounts` read, and one module owning that table is what stops
// two liveness predicates for it drifting apart.
import { findLiveServiceAccount } from "$server/db/queries/service-accounts";
import type { RequestHandler } from "./$types";

// Boundary validation only. Every consent rule lives behind
// `resolveDelegationConsentOr` and `buildDelegationConsent`, so this
// route re-derives none of them and cannot drift from the fire-time
// ladder that asks the same questions.
//
// `ownerId` is accepted ONLY for the `service` arm — see the handler.
const consentBodySchema = z
  .object({
    extensionId: z.string().min(1),
    jobRef: z.string().min(1),
    workflowName: z.string().min(1),
    ownerKind: z.enum(["user", "service"]),
    ownerServiceAccountId: z.string().min(1).optional(),
    projectId: z.string().nullable().optional(),
    triggerKind: z.string().min(1),
    triggerSpec: z.record(z.string(), z.unknown()).nullable().optional(),
    // Both bounds are REQUIRED and neither has an "unlimited" value. A
    // delegation is unattended authority; a default would be a number
    // nobody chose, and an unlimited option would be the number everybody
    // chooses. TOKENS, never cents: an unpriced (OAuth-subscription)
    // model reports a null price and would spend without bound under a
    // cost cap (`db/schema.ts:647-653`).
    maxTokensPerRun: z.number().int().positive(),
    maxRunsPerDay: z.number().int().positive(),
  })
  .strict();

/**
 * The delegations THIS human consented to.
 *
 * Session-only for the same reason the write is: the list is the only
 * place a person can see what they have authorized an extension to do
 * unattended, and it is the entry point to revoking it.
 */
export const GET: RequestHandler = async ({ locals }) => {
  const user = requireSessionAuth(locals);
  if (user instanceof Response) return user;
  const rows = await listWorkflowDelegationsConsentedBy(user.id);
  return json({ delegations: rows.map(toWorkflowDelegationView) });
};

/**
 * Consent to a delegation — C3's authority-minting act.
 *
 * ## SESSION-ONLY from the first commit
 *
 * `requireSessionAuth` (`auth/middleware.ts:169`) allowlists a positively
 * stamped `locals.authMethod === "session"`. It is NOT the negative
 * inference `locals.apiKeyScopes === undefined`, which happens to be
 * equivalent today and silently flips to ALLOW the day a fourth auth
 * method populates `locals.user` without that field. This route mints
 * standing, unattended authority over someone's workflows; a long-lived
 * bearer key must not be able to spend it, and the sibling approval-answer
 * route already draws exactly this line.
 *
 * ## The owner is never taken from the wire for the `user` arm
 *
 * `owner_kind: "user"` binds the delegation to the SESSION's user, full
 * stop. A body-supplied user id would let any authenticated caller mint a
 * delegation that runs as somebody else — the confused deputy the whole
 * table is shaped to prevent (`db/schema.ts:592-597`: "the wire carries a
 * `job_ref` and NEVER a principal"). The `service` arm does take an id,
 * because a service account is a named non-human principal an admin
 * created for this purpose; it is checked for existence and liveness
 * before anything is written.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
  const user = requireSessionAuth(locals);
  if (user instanceof Response) return user;

  const parsed = consentBodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return errorJson(400, "Invalid delegation consent body");
  const body = parsed.data;

  // Registry-resolved, never off the wire: the consent hash folds in the
  // extension NAME, and a name taken from the body would let one
  // extension's consent be presented under another's identity.
  const manifest = ExtensionRegistry.getInstance().getManifest(body.extensionId);
  if (manifest === undefined) {
    return errorJson(404, "No such extension is installed");
  }

  let ownerId: string;
  if (body.ownerKind === "service") {
    if (body.ownerServiceAccountId === undefined) {
      return errorJson(400, "ownerServiceAccountId is required for a service delegation");
    }
    const account = await findLiveServiceAccount(body.ownerServiceAccountId);
    if (account === undefined) {
      return errorJson(400, "No enabled service account with that id");
    }
    ownerId = account.id;
  } else {
    if (body.ownerServiceAccountId !== undefined) {
      // Refused rather than ignored: a body that names both arms is
      // asking for something the row cannot express, and silently
      // dropping half of it is how a caller ends up believing they
      // consented to something else.
      return errorJson(400, "ownerServiceAccountId is not valid for a user delegation");
    }
    ownerId = user.id;
  }

  // ── The load-bearing consent-time check (amended spec §6.1) ─────────
  //
  // Authorized AS THE PRINCIPAL THE DELEGATION WILL CARRY, not as the
  // human clicking the button. Those differ whenever the owner is a
  // service account, and the refusal names the reason and the remedy
  // rather than being a bare 403 — a service account reaches
  // `system`-visible workflows only, while fork (C3's headline use case)
  // stamps `project`, so "run as a service account" and "delegate my
  // fork" are silently incompatible. Without this the user finds out at
  // the first cron tick, as a generic denial in an audit row, while
  // `consecutive_failures` climbs to the auto-disable threshold.
  //
  // This does NOT replace the fire-time re-ask: visibility is mutable, so
  // the ladder asks again on every fire and refuses with its own distinct
  // code. This exists so the HUMAN learns immediately.
  const resolved = await resolveDelegationConsentOr(body.workflowName, body.ownerKind, ownerId, body.projectId ?? null);
  if (resolved instanceof Response) return resolved;

  const consent = await buildDelegationConsent({
    entry: resolved.entry,
    extensionName: manifest.name,
    workflowName: body.workflowName,
    projectId: body.projectId ?? null,
    ownerKind: body.ownerKind,
    ownerId,
    trigger: { kind: body.triggerKind, spec: body.triggerSpec ?? null },
  });
  if (consent instanceof Response) return consent;

  const created = await createWorkflowDelegation({
    extensionId: body.extensionId,
    jobRef: body.jobRef,
    ownerKind: body.ownerKind,
    ownerId,
    workflowName: body.workflowName,
    definitionVersionId: consent.definitionVersionId,
    projectId: body.projectId ?? null,
    triggerKind: body.triggerKind,
    triggerSpec: body.triggerSpec ?? null,
    consentHash: consent.consentHash,
    definitionHash: consent.definitionHash,
    capabilitySet: consent.capabilitySet,
    maxTokensPerRun: body.maxTokensPerRun,
    maxRunsPerDay: body.maxRunsPerDay,
    consentedByUserId: user.id,
  });
  if (!created.ok) return errorJson(409, created.message);

  return json(
    {
      delegation: toWorkflowDelegationView(created.delegation),
      supersededId: created.supersededId,
      // The exact material the hash was taken over, so the dialog and a
      // later stale-consent diff read the same object rather than each
      // deriving its own.
      material: consent.material,
    },
    { status: 201 },
  );
};
