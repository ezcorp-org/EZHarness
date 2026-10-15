import { factoryListQuery, handleFactorySessionApi } from "../../../../_shared";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = event => handleFactorySessionApi(event, () => ({
  kind: "release.notification.list",
  path: { projectId: event.params.projectId },
  query: factoryListQuery(event.url),
}));
