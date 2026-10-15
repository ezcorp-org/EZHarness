import { handleFactoryApi } from "../../../../../_shared";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = event => handleFactoryApi(event, {
  scope: "read",
  build: () => ({ kind: "run.inspect", path: { projectId: event.params.projectId, runId: event.params.runId }, query: inspectionQuery(event.url) }),
});

function inspectionQuery(url: URL): Record<string, unknown> {
  const query: Record<string, unknown> = {};
  for (const key of ["section", "cursor", "search"] as const) {
    const value = url.searchParams.get(key);
    if (value !== null) query[key] = value;
  }
  const limit = url.searchParams.get("limit");
  if (limit !== null) query.limit = Number(limit);
  return query;
}
