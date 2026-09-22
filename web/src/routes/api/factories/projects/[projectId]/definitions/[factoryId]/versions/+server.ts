import { factoryListQuery, handleFactoryApi, readFactoryJson } from "../../../../../_shared";
import type { RequestHandler } from "./$types";

function path(params: { projectId: string; factoryId: string }) {
  return { projectId: params.projectId, factoryId: params.factoryId };
}

export const GET: RequestHandler = event => handleFactoryApi(event, {
  scope: "read",
  build: () => ({ kind: "version.list", path: path(event.params), query: factoryListQuery(event.url) }),
});

// C01: publishing a version needs the project's `factory.publish` grant and an
// independently approved contract revision, under the `write` API-key scope.
// The product layer still enforces the grant and the contract; this verb is not
// one of C01's human-session rows.
export const POST: RequestHandler = event => handleFactoryApi(event, {
  scope: "write",
  build: async () => ({ kind: "version.publish", path: path(event.params), body: await readFactoryJson(event.request) }),
});
