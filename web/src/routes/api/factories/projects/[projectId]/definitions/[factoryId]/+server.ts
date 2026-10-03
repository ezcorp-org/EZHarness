import { handleFactoryApi, readFactoryJson } from "../../../../_shared";
import type { RequestHandler } from "./$types";

function path(params: { projectId: string; factoryId: string }) {
  return { projectId: params.projectId, factoryId: params.factoryId };
}

export const GET: RequestHandler = event => handleFactoryApi(event, {
  scope: "read",
  build: () => ({ kind: "draft.get", path: path(event.params) }),
});

export const PUT: RequestHandler = event => handleFactoryApi(event, {
  scope: "write",
  build: async () => ({ kind: "draft.update", path: path(event.params), body: await readFactoryJson(event.request) }),
});

export const DELETE: RequestHandler = event => handleFactoryApi(event, {
  scope: "write",
  build: () => ({ kind: "draft.delete", path: path(event.params) }),
});
