import { factoryDefinitionListQuery, handleFactoryApi, readFactoryJson } from "../../../_shared";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = event => handleFactoryApi(event, {
  scope: "read",
  build: () => ({ kind: "draft.list", path: { projectId: event.params.projectId }, query: factoryDefinitionListQuery(event.url) }),
});

export const POST: RequestHandler = event => handleFactoryApi(event, {
  scope: "write",
  build: async () => ({ kind: "draft.create", path: { projectId: event.params.projectId }, body: await readFactoryJson(event.request) }),
});
