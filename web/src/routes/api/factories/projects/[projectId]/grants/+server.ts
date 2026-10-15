import { factoryGrantListQuery, handleFactoryApi } from "../../../_shared";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = event => handleFactoryApi(event, {
  scope: "read",
  build: () => ({ kind: "grant.list", path: { projectId: event.params.projectId }, query: factoryGrantListQuery(event.url) }),
});
