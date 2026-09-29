import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireSessionAuth } from "$server/auth/middleware";
import { getDb } from "$server/db/connection";
import { FactoryPurgeApprovalError, issueFactoryPurgeApproval } from "$server/factory/provisioning/purge-approval";
import { readBoundedJson } from "$lib/server/security/bounded-json";

/**
 * An administrator's approval to purge this installation (C12). Session only:
 * an API key or a service principal can never approve a purge for a human.
 * The body carries the exact acknowledgement sentence and a reason. The
 * operator names the returned approval ID to the provisioner, which verifies
 * it in this installation's retained database; the operator cannot mint one.
 */
const STATUS: Readonly<Record<string, number>> = {
  purge_approval_human_required: 403, purge_approval_not_administrator: 403,
  purge_approval_acknowledgement_required: 400, purge_approval_reason_invalid: 400,
};

export const POST: RequestHandler = async ({ request, locals }) => {
  const user = requireSessionAuth(locals);
  if (user instanceof Response) return user;
  const installationId = process.env.EZCORP_INSTALLATION_ID?.trim();
  if (!installationId || !process.env.EZCORP_FACTORY_BOOTSTRAP_INVITATION?.trim()) return json({ error: "not_a_provisioned_installation" }, { status: 404 });
  const body = await readBoundedJson(request, 16 * 1024).catch(() => undefined) as { acknowledgement?: unknown; reason?: unknown } | undefined;
  if (!body || typeof body !== "object") return json({ error: "purge_approval_request_invalid" }, { status: 400 });
  try {
    const approval = await issueFactoryPurgeApproval(getDb(), installationId, { kind: "user", id: user.id, authentication: "session" }, { acknowledgement: body.acknowledgement, reason: body.reason }, Date.now());
    return json(approval, { status: 201 });
  } catch (error) {
    if (error instanceof FactoryPurgeApprovalError) return json({ error: error.code }, { status: STATUS[error.code] });
    throw error;
  }
};
