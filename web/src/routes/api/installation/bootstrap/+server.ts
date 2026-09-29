import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireSessionAuth } from "$server/auth/middleware";
import { getDb } from "$server/db/connection";
import { FactoryBootstrapError, factoryBootstrapHost } from "$server/factory/provisioning/bootstrap";
import { FactoryGrantError } from "$server/factory/grants";
import { readBoundedJson } from "$lib/server/security/bounded-json";

/**
 * The installation's human bootstrap (C01, C12 step 7).
 *
 * The public status the operator's control plane observes lives at
 * `./status`. This route is the consent act. Session only: an API key or a service principal
 * can never consent for a human. The body must carry the exact acknowledgement
 * sentence and the bootstrap project.
 */
const STATUS: Readonly<Record<string, number>> = {
  bootstrap_not_redeemed: 409, bootstrap_already_consented: 409, bootstrap_not_administrator: 403,
  bootstrap_human_required: 403, bootstrap_acknowledgement_required: 400, bootstrap_project_invalid: 400,
};

export const POST: RequestHandler = async ({ request, locals }) => {
  const user = requireSessionAuth(locals);
  if (user instanceof Response) return user;
  const host = await factoryBootstrapHost(process.env, getDb).catch(() => null);
  if (!host) return json({ error: "not_a_provisioned_installation" }, { status: 404 });
  const body = await readBoundedJson(request, 16 * 1024).catch(() => undefined) as { projectId?: unknown; acknowledgement?: unknown } | undefined;
  if (!body || typeof body.projectId !== "string" || typeof body.acknowledgement !== "string") return json({ error: "bootstrap_request_invalid" }, { status: 400 });
  try {
    const consent = await host.bootstrap.consent({ kind: "user", id: user.id, authentication: "session" }, { projectId: body.projectId, acknowledgement: body.acknowledgement }, { invitation: host.invitation, nowMs: Date.now() });
    return json({ state: "consented", ...consent }, { status: 201 });
  } catch (error) {
    if (error instanceof FactoryBootstrapError) return json({ error: error.code }, { status: STATUS[error.code] ?? 400 });
    if (error instanceof FactoryGrantError) return json({ error: error.code }, { status: 403 });
    throw error;
  }
};
