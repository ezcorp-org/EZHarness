import { factoryListQuery, handleFactoryApi, handleFactorySessionApi, readFactoryJson } from "../../../_shared";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = event => handleFactoryApi(event, {
  scope: "read",
  build: () => ({ kind: "package.list", path: { projectId: event.params.projectId }, query: factoryListQuery(event.url) }),
});

/** Binds an installed v4 release to the project. A human session; the service requires the tenant administrator. */
export const POST: RequestHandler = event => handleFactorySessionApi(event, async () => ({
  kind: "package.install", path: { projectId: event.params.projectId }, body: await readFactoryJson(event.request),
}));
