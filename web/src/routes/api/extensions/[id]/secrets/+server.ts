/**
 * POST / DELETE /api/extensions/:id/secrets
 *
 * The generic, reusable host entry-route for writing / clearing an extension's
 * scope-isolated secrets. `:id` is the extensions-table UUID; we resolve it to
 * the stable manifest slug (`ext.name`) — the FK the host-side secrets store
 * (src/extensions/secrets-store.ts) keys by — and the store handles AEAD,
 * scope-binding, and audit.
 *
 * Body (POST):   `{ projectId?: string|null, name: string, value: string }`
 * Body (DELETE): `{ projectId?: string|null, name: string }`
 *
 * SECURITY:
 *   - Authed: `extensions` scope + a real session/key user (BOTH required).
 *   - When `projectId` is supplied it must name a real project (mirrors the
 *     github-projects connect route) — a 404 for a missing project/extension
 *     is opaque, never an enumeration oracle.
 *   - The plaintext `value` is NEVER echoed in any response and NEVER logged.
 */
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { getExtension } from "$server/db/queries/extensions";
import { getProject } from "$server/db/queries/projects";
import { setSecret, deleteSecret } from "$server/extensions/secrets-store";
import type { AuthUser } from "$server/auth/types";

/** App.Locals slice this route reads (auth user + key scopes). */
type SecretsRouteLocals = {
  user?: AuthUser;
  apiKeyScopes?: import("$lib/server/security/api-keys").ApiKeyScope[];
};

interface SecretBody {
  projectId?: unknown;
  name?: unknown;
  value?: unknown;
}

/** Gate on the `extensions` scope + a real session/key user. Returns the authed
 *  user, or a Response to short-circuit the handler with. Mirrors the
 *  github-projects `authGithubRoute` contract. */
function authSecretsRoute(
  locals: SecretsRouteLocals,
): { user: AuthUser } | { error: Response } {
  const scopeErr = requireScope(locals, "extensions");
  if (scopeErr) return { error: scopeErr };
  try {
    return { user: requireAuth(locals) };
  } catch (resp) {
    // requireAuth throws a Response (401) — surface it as an early return.
    return { error: resp as Response };
  }
}

/** Resolve the optional `projectId` to a validated value, or an error Response.
 *  A null/undefined projectId is the (valid) instance-wide scope. A supplied
 *  projectId must name a real project — opaque 404 otherwise. */
async function resolveProjectId(
  projectId: unknown,
): Promise<{ projectId: string | null } | { error: Response }> {
  if (projectId === undefined || projectId === null) return { projectId: null };
  if (typeof projectId !== "string") {
    return { error: errorJson(400, "projectId must be a string") };
  }
  const project = await getProject(projectId);
  if (!project) return { error: errorJson(404, "Project not found") };
  return { projectId };
}

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const auth = authSecretsRoute(locals);
  if ("error" in auth) return auth.error;
  const { user } = auth;

  const body = (await request.json().catch(() => null)) as SecretBody | null;
  if (!body || typeof body !== "object") return errorJson(400, "Invalid body");

  const name = typeof body.name === "string" ? body.name : "";
  if (!name) return errorJson(400, "name is required");
  const value = typeof body.value === "string" ? body.value : "";
  if (!value) return errorJson(400, "value is required");

  const ext = await getExtension(params.id);
  if (!ext) return errorJson(404, "Not found");

  const projectRes = await resolveProjectId(body.projectId);
  if ("error" in projectRes) return projectRes.error;

  await setSecret(ext.name, projectRes.projectId, name, value, { userId: user.id });

  // The plaintext value is NEVER echoed back.
  return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ locals, params, request }) => {
  const auth = authSecretsRoute(locals);
  if ("error" in auth) return auth.error;
  const { user } = auth;

  const body = (await request.json().catch(() => null)) as SecretBody | null;
  if (!body || typeof body !== "object") return errorJson(400, "Invalid body");

  const name = typeof body.name === "string" ? body.name : "";
  if (!name) return errorJson(400, "name is required");

  const ext = await getExtension(params.id);
  if (!ext) return errorJson(404, "Not found");

  const projectRes = await resolveProjectId(body.projectId);
  if ("error" in projectRes) return projectRes.error;

  const deleted = await deleteSecret(ext.name, projectRes.projectId, name, {
    userId: user.id,
  });
  return json({ deleted });
};
