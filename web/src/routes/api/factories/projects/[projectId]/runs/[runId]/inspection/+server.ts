import { handleFactoryConsoleApi } from "../../../../../_console";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = event => handleFactoryConsoleApi(event, {
  scope: "read",
  build: () => ({ kind: "run.inspect", path: { projectId: event.params.projectId, runId: event.params.runId }, query: inspectionQuery(event.url) }),
  run: async ({ principal, console, request }) => {
    const query = request.kind === "run.inspect" ? request.query : {};
    const result = await console.inspections.inspect(principal, { projectId: event.params.projectId, runId: event.params.runId }, query);
    return "section" in result
      ? { schemaVersion: "factory.api.response.v1", kind: "run.inspection.page", resource: result } as const
      : { schemaVersion: "factory.api.response.v1", kind: "run.inspection", resource: result } as const;
  },
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
