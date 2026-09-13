import { factoryRunListQuery, handleFactoryApi } from "../../../_shared";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = event => handleFactoryApi(event, {
  scope: "read",
  build: () => ({ kind: "run.list", path: { projectId: event.params.projectId }, query: factoryRunListQuery(event.url) }),
});
