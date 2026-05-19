import { json } from "@sveltejs/kit";
import { getReadiness } from "$server/readiness";
import type { RequestHandler } from "./$types";

/**
 * Readiness endpoint — orthogonal to /api/health. Liveness (can the process
 * answer HTTP?) is /api/health; readiness (has migrate() succeeded and is
 * this image safe to route traffic to?) is here. Orchestrators like
 * Watchtower and Kubernetes should gate rollouts on this.
 */
export const GET: RequestHandler = async () => {
  const r = getReadiness();
  const status = r.state === "ready" ? 200 : 503;
  return json(r, { status });
};
