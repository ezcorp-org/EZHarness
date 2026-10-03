import { handleFactorySessionApi, readFactoryJson } from "../../../../../_shared";
import type { RequestHandler } from "./$types";

export const PUT: RequestHandler = event => handleFactorySessionApi(event, async () => ({
  kind: "release.contract.put", path: { projectId: event.params.projectId, contractId: event.params.contractId }, body: await readFactoryJson(event.request),
}));
