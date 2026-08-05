/**
 * POST /api/workflows/delegations/preview — what consenting would authorize.
 *
 * The consent dialog cannot ask a person to approve a capability set it has
 * not shown them, and the set is only knowable by walking the workflow's
 * closure. `POST /api/workflows/delegations` returns that material, but only
 * AFTER writing the row — which is the wrong order for a consent decision.
 * This route is the same computation with no write.
 *
 * ## It re-uses the consent path exactly, and deliberately adds nothing
 *
 * `resolveDelegationConsentOr` + `buildDelegationConsent` are the same two
 * calls the POST makes, in the same order, with the same arguments. That is
 * what makes the preview trustworthy: a preview assembled from its own
 * lookup would be a second answer to "what does this authorize", and the
 * failure mode is the worst one available — a dialog that shows a capability
 * set the delegation does not actually get, or omits one it does.
 *
 * It follows that the consent-time REFUSAL is previewed too. A
 * service-account delegation for a `project`-visible workflow is refused
 * here with §6.1's sentence, so the dialog can disable its approve button
 * and say why while the person still has the owner-kind picker in front of
 * them — rather than after they commit.
 *
 * ## SESSION-ONLY, like the consent it previews
 *
 * `requireSessionAuth` allowlists a positively stamped
 * `locals.authMethod === "session"`. The preview reveals the capability
 * closure of a workflow the CALLER's chosen principal can run, which is
 * information about workflows; gating it below the write it describes would
 * make it the softer way to ask the same question. The gate RETURNS its
 * denial rather than throwing — SvelteKit answers 500 to a thrown Response.
 *
 * ## The reach warning rides along
 *
 * `GET /api/service-accounts` is admin-only, so a non-admin consenting to a
 * delegation can never read `reach` from there. Rather than widen an admin
 * surface, the same server-derived {@link serviceAccountReach} object ships
 * here — the one place a non-admin legitimately needs it. Still derived from
 * the live ladder, still never re-stated in the browser.
 */
import { json } from "@sveltejs/kit";
import { z } from "zod";
import { requireSessionAuth } from "$server/auth/middleware";
import { errorJson } from "$lib/server/http-errors";
import { resolveDelegationConsentOr } from "$lib/server/workflow-access";
import { buildDelegationConsent } from "$lib/server/delegation-consent";
import { ExtensionRegistry } from "$server/extensions/registry";
import { findLiveServiceAccount } from "$server/db/queries/service-accounts";
import { serviceAccountReach } from "$server/db/queries/service-accounts";
import { MAX_WORKFLOW_NESTING_DEPTH } from "$server/runtime/workflow-closure";
import { MAX_TOOL_CALLS_PER_TURN } from "$server/extensions/tool-executor/limits";
import { resolveModelObject } from "$server/providers/registry";
import { modelHonoursEffort } from "$server/runtime/routing/effort-support";
import type { ConsentHashMaterial } from "$server/runtime/workflow-capability-hash";
import type { RequestHandler } from "./$types";

/** The consent body minus the two bounds — a preview asks what a
 *  delegation WOULD authorize, and neither ceiling changes that. */
const previewBodySchema = z
  .object({
    extensionId: z.string().min(1),
    workflowName: z.string().min(1),
    ownerKind: z.enum(["user", "service"]),
    ownerServiceAccountId: z.string().min(1).optional(),
    projectId: z.string().nullable().optional(),
    triggerKind: z.string().min(1),
  })
  .strict();

/** A step whose declared reasoning effort the provider will drop. */
interface EffortNoop {
  workflowName: string;
  stepName: string;
  provider: string;
  model: string;
  effort: string;
}

/** One of the material's `stableStringify`-encoded binding fields, back
 *  as an object. `"null"` means the step declared none. */
function decodeBinding(encoded: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(encoded);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Steps that ask for a reasoning `effort` the bound model cannot honour.
 *
 * DERIVED, never asserted — the same discipline `serviceAccountReach`
 * follows. {@link resolveModelObject} is the function the runtime itself
 * uses, and for a provider/model pair it does not know it SYNTHESIZES an
 * entry with `reasoning: false` (`src/providers/registry.ts`), which is
 * exactly how a local or custom model arrives. So asking the resolver is
 * the same question the runtime will ask later, not a guess about it.
 *
 * The VERDICT on that resolved model is {@link modelHonoursEffort}, shared
 * verbatim with `createPiLlmAdapter` — which emits the same finding into the
 * run log at the call that drops the effort. Two implementations of "is this
 * a no-op?" could disagree, and a pre-flight warning that the run then
 * contradicts is worse than either warning alone.
 *
 * Reported ONLY when the binding names a concrete provider AND model. A
 * step that sets an effort without a provider falls back to the AGENT's
 * own binding, which is not knowable from the material — and a warning
 * that might be wrong is worse here than no warning, because the whole
 * point of the disclosure block is that everything in it is true.
 */
function findEffortNoops(material: ConsentHashMaterial): EffortNoop[] {
  const out: EffortNoop[] = [];
  for (const def of material.graph) {
    const defaultBinding = decodeBinding(def.defaultModel);
    for (const step of def.steps) {
      // A step's `model` REPLACES the definition's `defaultModel` whole
      // rather than merging field-by-field — the same rule the consent
      // hash follows when it attributes the `llm` capability.
      const binding = decodeBinding(step.model) ?? defaultBinding;
      if (binding === null) continue;

      const effort = binding.effort;
      const provider = binding.provider;
      const model = binding.model;
      if (
        typeof effort !== "string" ||
        typeof provider !== "string" ||
        typeof model !== "string"
      ) {
        continue;
      }

      let reasoning = true;
      try {
        reasoning = modelHonoursEffort(resolveModelObject(provider, model));
      } catch {
        // An unresolvable binding is not evidence of anything, and this
        // block only ever ADDS a caveat — so staying quiet is the honest
        // failure. Never a thrown 500 on a preview.
        continue;
      }
      if (!reasoning) {
        out.push({ workflowName: def.name, stepName: step.name, provider, model, effort });
      }
    }
  }
  return out;
}

export const POST: RequestHandler = async ({ request, locals }) => {
  const user = requireSessionAuth(locals);
  if (user instanceof Response) return user;

  const parsed = previewBodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return errorJson(400, "Invalid delegation preview body");
  const body = parsed.data;

  // Registry-resolved, never off the wire — the consent hash folds in the
  // extension NAME, so a name taken from the body would let one
  // extension's preview be shown under another's identity.
  const manifest = ExtensionRegistry.getInstance().getManifest(body.extensionId);
  if (manifest === undefined) return errorJson(404, "No such extension is installed");

  // The same owner resolution the write performs. `user` never comes off
  // the wire; `service` is checked for existence and liveness.
  let ownerId: string;
  if (body.ownerKind === "service") {
    if (body.ownerServiceAccountId === undefined) {
      return errorJson(400, "ownerServiceAccountId is required for a service delegation");
    }
    const account = await findLiveServiceAccount(body.ownerServiceAccountId);
    if (account === undefined) return errorJson(400, "No enabled service account with that id");
    ownerId = account.id;
  } else {
    if (body.ownerServiceAccountId !== undefined) {
      return errorJson(400, "ownerServiceAccountId is not valid for a user delegation");
    }
    ownerId = user.id;
  }

  // §6.1's consent-time check, previewed. Its refusal carries the reason
  // AND the remedy, so the dialog surfaces this verbatim instead of a
  // bare 403.
  const resolved = resolveDelegationConsentOr(body.workflowName, body.ownerKind, ownerId);
  if (resolved instanceof Response) return resolved;

  const consent = await buildDelegationConsent({
    entry: resolved.entry,
    extensionName: manifest.name,
    workflowName: body.workflowName,
    projectId: body.projectId ?? null,
    ownerKind: body.ownerKind,
    ownerId,
    trigger: { kind: body.triggerKind, spec: null },
  });
  if (consent instanceof Response) return consent;

  return json({
    material: consent.material,
    capabilitySet: consent.capabilitySet,
    consentHash: consent.consentHash,
    definitionVersionId: consent.definitionVersionId,
    effortNoops: findEffortNoops(consent.material),
    // Both ceilings ship as NUMBERS the dialog prints, rather than as copy
    // it hardcodes: the tool-call cap is env-overridable
    // (`EZCORP_MAX_TOOL_CALLS_PER_TURN`), so a dialog that said "100" would
    // be confidently wrong on any instance that tuned it.
    maxToolCallsPerRun: MAX_TOOL_CALLS_PER_TURN,
    maxNestingDepth: MAX_WORKFLOW_NESTING_DEPTH,
    reach: serviceAccountReach(),
  });
};
