import { factoryListQuery, handleFactoryApi, handleFactorySessionApi, readFactoryJson } from "../../../../../_shared";
import type { RequestHandler } from "./$types";

function path(params: { projectId: string; factoryId: string }) {
  return { projectId: params.projectId, factoryId: params.factoryId };
}

export const GET: RequestHandler = event => handleFactoryApi(event, {
  scope: "read",
  build: () => ({ kind: "version.list", path: path(event.params), query: factoryListQuery(event.url) }),
});

export const POST: RequestHandler = event => handleFactorySessionApi(event,
  async () => ({ kind: "version.publish", path: path(event.params), body: await readFactoryJson(event.request) }),
);
