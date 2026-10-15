import { handleFactoryApi } from "../../../../../_shared";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = event => handleFactoryApi(event, {
  scope: "read",
  build: () => ({
    kind: "draft.export",
    path: { projectId: event.params.projectId, factoryId: event.params.factoryId },
    query: { format: event.url.searchParams.get("format") },
  }),
});
