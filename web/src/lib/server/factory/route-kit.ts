import { checkAuth, checkRole, requireSessionAuth } from "$server/auth/middleware";
import type { FactoryApplication } from "$server/factory/application";
import { FactoryDefinitionError } from "$server/factory/definitions";
import { FactoryGrantError, type FactoryPrincipal } from "$server/factory/grants";
import { FactoryRunLifecycleError } from "$server/factory/run-lifecycle";
import { FactoryMutationError } from "$server/factory/mutations";
import { FactoryServiceCredentialError } from "$server/factory/service-credentials";
import { FactoryReleaseAuthorityError } from "$server/factory/release-authority";
import { FactoryAssuranceError } from "$server/factory/assurance";
import { FactoryReleaseError } from "$server/factory/releases";
import { FactoryAssuranceCommandError } from "$server/factory/assurance-commands";
import { FactoryRunControlError } from "$server/factory/run-controls";
import { requireScope } from "$lib/server/security/api-keys";
import {
  FACTORY_API_RESPONSE_SCHEMA_VERSION,
  FactoryParseError,
  validateFactoryApiResponse,
  type FactoryApiRequest,
  type FactoryApiResponse,
  type ValidationIssue,
} from "@ezcorp/factory-sdk";

/**
 * The factory route kit: the authentication gate, the error mapping, and the
 * response encoding every factory API route shares, plus the one extension
 * point for request kinds that live outside the built-in dispatch.
 */

// C01's authority table names five API-key columns for factory actions.
// `admin` covers tenant-administrator rows; `session` still means no key of any
// scope can call the verb.
export type FactoryRouteScope = "read" | "write" | "chat" | "admin" | "session";

/**
 * Resolves who is calling, under the route's scope, or the refusal to return.
 * A service credential is used only on a non-session route; otherwise the
 * caller must be a session or API-key user holding the scope.
 */
export function resolveFactoryPrincipal(event: { readonly locals: App.Locals }, options: { readonly scope: FactoryRouteScope }): FactoryPrincipal | Response {
  const service = event.locals.factoryServicePrincipal;
  if (options.scope !== "session" && service) {
    // A service credential carries only C01's delegable scopes. The admin rows
    // belong to a tenant administrator, and C01 is explicit that a service
    // principal cannot create consent or trust, so an admin row is refused here
    // rather than looked up in a vocabulary that cannot express it.
    if (options.scope === "admin") return factoryErrorResponse(403, "factory_service_scope_required", "A service credential cannot perform a tenant administrator action.");
    if (!service.scopes.includes(options.scope)) return factoryErrorResponse(403, "factory_service_scope_required", "The service credential does not permit this factory operation.");
    return { kind: "service", id: service.serviceAccountId, authentication: "service", credential: service };
  }
  const user = options.scope === "session" ? requireSessionAuth(event.locals) : checkAuth(event.locals);
  if (user instanceof Response) return user;
  if (options.scope !== "session") {
    const scope = requireScope(event.locals, options.scope);
    if (scope) return scope;
  }
  // `requireScope(locals, "admin")` is allow-all for a cookie session, because
  // a cookie carries no `apiKeyScopes`. C01 gives the admin rows to a tenant
  // administrator, so the admin scope is gated on both axes here — the role as
  // well as the key scope — rather than on the key alone.
  if (options.scope === "admin") {
    const role = checkRole(event.locals, "admin");
    if (role instanceof Response) return role;
  }
  const userPrincipal = requestPrincipal(event.locals, user.id);
  if (!userPrincipal) return factoryErrorResponse(403, "factory_principal_unsupported", "This authentication method cannot use factories.");
  return userPrincipal;
}

function requestPrincipal(locals: App.Locals, userId: string): FactoryPrincipal | null {
  if (locals.authMethod === "session") return { kind: "user", id: userId, authentication: "session" };
  if (locals.authMethod === "api-key") return { kind: "user", id: userId, authentication: "api-key" };
  return null;
}

/**
 * Answers one validated request whose kind it owns, or returns `null` for any
 * other kind. Registered dispatchers run after the built-in ones, in
 * registration order, and the first answer wins.
 */
export type FactoryRequestDispatcher = (application: FactoryApplication, principal: FactoryPrincipal, request: FactoryApiRequest) => Promise<FactoryApiResponse | null>;

const registeredDispatchers: FactoryRequestDispatcher[] = [];

/** Adds a dispatcher for request kinds the built-in dispatch does not own. Returns the function that removes it. */
export function registerFactoryDispatcher(dispatcher: FactoryRequestDispatcher): () => void {
  registeredDispatchers.push(dispatcher);
  return () => {
    const index = registeredDispatchers.indexOf(dispatcher);
    if (index >= 0) registeredDispatchers.splice(index, 1);
  };
}

/** The first registered dispatcher's answer, or `null` when none owns the kind. */
export async function dispatchRegisteredFactoryRequest(application: FactoryApplication, principal: FactoryPrincipal, request: FactoryApiRequest): Promise<FactoryApiResponse | null> {
  for (const dispatcher of [...registeredDispatchers]) {
    const response = await dispatcher(application, principal, request);
    if (response) return response;
  }
  return null;
}

export function factoryResponse(value: FactoryApiResponse): Response {
  const validation = validateFactoryApiResponse(value);
  if (!validation.ok) throw new Error(`Invalid factory API response: ${validation.issues[0]?.code ?? "unknown"}`);
  return Response.json(value, { status: value.kind === "mutation.accepted" ? 202 : 200 });
}

type FactoryCodedError = Error & { readonly code: string; readonly diagnostics?: unknown };

/** One HTTP answer shared by a set of error codes of one family. */
export interface ErrorAnswer {
  readonly status: number;
  readonly message: string;
  readonly codes: ReadonlySet<string>;
  /** Attach the error's `diagnostics` as the response issues. */
  readonly diagnostics?: true;
}

/**
 * The answers one error class can produce. A code no answer names falls back
 * to a retryable 500 with the `storage` message, or is rethrown when the family
 * has no such fallback.
 */
export interface ErrorFamily {
  readonly type: abstract new (...args: never[]) => FactoryCodedError;
  readonly storage: string | null;
  readonly answers: readonly ErrorAnswer[];
}

export function answer(status: number, message: string, ...codes: string[]): ErrorAnswer {
  return { status, message, codes: new Set(codes) };
}

// Every error class below extends Error directly, so at most one family
// matches and the list order does not decide the answer.
const ERROR_FAMILIES: readonly ErrorFamily[] = [
  {
    type: FactoryMutationError,
    storage: "The durable mutation receipt is unavailable.",
    answers: [
      answer(409, "The idempotency key was already used for a different request.", "idempotency_conflict"),
      answer(400, "A bounded Idempotency-Key is required.", "invalid_idempotency_key"),
    ],
  },
  {
    type: FactoryServiceCredentialError,
    storage: "Factory service credential storage is unavailable.",
    answers: [
      answer(412, "The service credential revision is stale.", "factory_service_credential_conflict"),
      answer(404, "Factory service credential not found.", "factory_service_credential_not_found"),
      answer(403, "Factory service credential authority is required.", "factory_service_credential_forbidden", "factory_human_required"),
      answer(400, "The factory service credential request is invalid.", "factory_service_credential_invalid"),
    ],
  },
  {
    type: FactoryReleaseAuthorityError,
    storage: "Release authority storage is unavailable.",
    answers: [
      answer(412, "The release authority revision is stale.", "factory_release_trust_conflict", "factory_release_control_conflict"),
      answer(404, "Release trust not found.", "factory_release_trust_missing"),
      answer(403, "Human release authority is required.", "factory_release_authority_human_required", "factory_release_authority_scope"),
      answer(400, "The release authority request is invalid.", "factory_release_authority_invalid"),
    ],
  },
  {
    type: FactoryAssuranceError,
    storage: "Release assurance storage is unavailable.",
    answers: [
      answer(404, "Release assurance record not found.", "factory_assurance_not_found"),
      answer(412, "The release assurance precondition is stale.", "factory_assurance_stale", "factory_assurance_conflict"),
      answer(400, "The release assurance request is invalid.", "factory_assurance_invalid"),
      answer(422, "The candidate does not satisfy the current assurance contract.", "factory_assurance_claim_failed", "factory_assurance_evidence_stale"),
    ],
  },
  {
    type: FactoryAssuranceCommandError,
    storage: "Factory approval storage is unavailable.",
    answers: [
      answer(503, "Factory approval services are not ready.", "factory_command_approval_unavailable"),
      answer(404, "Factory approval not found.", "factory_command_approval_not_found"),
      answer(403, "Factory approval authority is required.", "factory_command_approval_forbidden", "factory_command_approval_scope"),
      answer(412, "The factory approval precondition is stale.", "factory_command_approval_stale", "factory_command_approval_conflict"),
      answer(400, "The factory approval request is invalid.", "factory_command_approval_invalid"),
    ],
  },
  {
    type: FactoryReleaseError,
    storage: "Release storage is unavailable.",
    answers: [
      answer(503, "Release services are not ready.", "factory_release_application_unavailable"),
      answer(503, "Release reconciliation proof timed out.", "factory_release_reconciliation_timeout"),
      answer(404, "Release operation not found.", "factory_release_not_found"),
      answer(409, "A different release record already uses this identity.", "factory_release_conflict", "factory_release_policy_conflict"),
      answer(412, "The release precondition is stale.", "factory_release_precondition", "factory_release_policy_stale", "factory_release_reconciliation_stale", "factory_release_not_claimable", "factory_release_stale", "factory_release_authority_stale", "factory_release_trust_changed", "factory_release_destination_changed"),
      answer(403, "The automatic release policy does not permit this operation.", "factory_release_policy_denied"),
      answer(403, "A human session is required to reconcile a release.", "factory_release_human_required"),
      answer(422, "The provider evidence does not prove the requested reconciliation.", "factory_release_absence_unproved", "factory_release_foreign_receipt"),
      answer(400, "The release request is invalid.", "factory_release_invalid", "factory_release_policy_invalid", "factory_release_reconciliation_invalid"),
    ],
  },
  {
    type: FactoryGrantError,
    storage: "Factory grant storage is unavailable.",
    answers: [
      answer(412, "The factory grant revision is stale.", "factory_grant_conflict", "factory_grant_stale"),
      answer(404, "Factory grant not found.", "factory_grant_not_found"),
      answer(403, "Factory authority is required.", "factory_forbidden", "factory_human_required", "factory_grant_widening"),
      answer(400, "The factory grant request is invalid.", "factory_grant_invalid", "factory_page_invalid"),
    ],
  },
  {
    type: FactoryRunLifecycleError,
    storage: "Factory run storage is unavailable.",
    answers: [
      answer(412, "The factory run revision is stale.", "factory_revision_conflict", "factory_revision_invalid"),
      answer(404, "Factory run or command not found.", "factory_run_not_found", "factory_command_not_found"),
      answer(409, "The factory run request conflicts with current state.", "factory_run_terminal", "factory_run_stopped", "factory_definition_conflict"),
      answer(400, "The factory run request is invalid.", "factory_input_invalid", "factory_page_invalid"),
      answer(503, "The required factory execution service is unavailable.", "factory_interpreter_unavailable", "factory_control_unavailable"),
    ],
  },
  {
    type: FactoryRunControlError,
    storage: null,
    answers: [
      answer(412, "The factory run control precondition is stale.", "factory_control_stale"),
      answer(403, "The replacement factory widens the current run authority.", "factory_control_widening"),
      answer(422, "The factory run control cannot apply to the current node.", "factory_control_invalid"),
      answer(500, "Factory run control authority is corrupt.", "factory_control_corrupt"),
    ],
  },
  {
    type: FactoryDefinitionError,
    storage: "Factory definition storage is unavailable.",
    answers: [
      answer(412, "The factory definition revision is stale.", "factory_revision_conflict", "factory_revision_invalid"),
      answer(404, "Factory definition not found.", "factory_definition_not_found", "factory_version_not_found"),
      answer(409, "The factory version conflicts with existing content.", "factory_version_conflict"),
      { ...answer(422, "The factory definition is not publishable.", "factory_definition_invalid"), diagnostics: true },
      answer(400, "The factory definition request is invalid.", "factory_definition_schema_invalid", "factory_definition_identity_mismatch", "factory_definition_too_large", "factory_format_invalid", "factory_page_invalid"),
    ],
  },
];

const registeredFamilies: ErrorFamily[] = [];

/**
 * Adds the error family of a registered dispatcher, so its refusals map to a
 * status like the built-in ones. It must not name a class a built-in family
 * already owns. Returns the function that removes it.
 */
export function registerFactoryErrorFamily(family: ErrorFamily): () => void {
  if (ERROR_FAMILIES.some(candidate => candidate.type === family.type)) throw new Error("A built-in factory error family already owns this class.");
  registeredFamilies.push(family);
  return () => {
    const index = registeredFamilies.indexOf(family);
    if (index >= 0) registeredFamilies.splice(index, 1);
  };
}

/**
 * Maps a thrown factory error to its HTTP answer. A 5xx answer is retryable and
 * a 4xx answer is not; an error outside every family is rethrown.
 */
export function mappedFactoryError(error: unknown): Response {
  if (error instanceof FactoryParseError) return factoryErrorResponse(400, error.code, error.message);
  const family = [...ERROR_FAMILIES, ...registeredFamilies].find(candidate => error instanceof candidate.type);
  if (!family) throw error;
  const { code, diagnostics } = error as FactoryCodedError;
  const found = family.answers.find(candidate => candidate.codes.has(code));
  if (found) return factoryErrorResponse(found.status, code, found.message, found.status >= 500, found.diagnostics ? diagnostics as readonly ValidationIssue[] : undefined);
  if (family.storage === null) throw error;
  return factoryErrorResponse(500, code, family.storage, true);
}

export function factoryErrorResponse(status: number, code: string, message: string, retryable = false, issues?: readonly ValidationIssue[]): Response {
  const value = {
    schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION,
    kind: "error",
    error: { code, message, retryable, ...(issues === undefined ? {} : { issues }) },
  } as FactoryApiResponse;
  const validation = validateFactoryApiResponse(value);
  if (!validation.ok) throw new Error(`Invalid factory API error response: ${validation.issues[0]?.code ?? "unknown"}`);
  return Response.json(value, { status });
}
