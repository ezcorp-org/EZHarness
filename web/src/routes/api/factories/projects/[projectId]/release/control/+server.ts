import { handleFactorySessionApi, readFactoryJson } from "../../../../_shared";
import type { RequestHandler } from "./$types";

export const PUT: RequestHandler = event => handleFactorySessionApi(event, async () => ({
  kind: "release.control.set",
  path: { projectId: event.params.projectId },
  body: await readFactoryJson(event.request),
}));
