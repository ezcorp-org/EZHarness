import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getDb } from "$server/db/connection";
import { factoryBootstrapHost } from "$server/factory/provisioning/bootstrap";

/**
 * Where the installation's human bootstrap stands, for the operator's control
 * plane, which observes it from outside through the ingress. Public, and it
 * says only a state and the invitation it concerns: no person, no project, no
 * grant. An installation that was not provisioned answers 404.
 */
export const GET: RequestHandler = async () => {
  const host = await factoryBootstrapHost(process.env, getDb).catch(() => null);
  if (!host) return json({ error: "not_a_provisioned_installation" }, { status: 404 });
  return json(await host.bootstrap.status());
};
