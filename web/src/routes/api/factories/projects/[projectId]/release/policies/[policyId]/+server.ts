import { handleFactorySessionApi, readFactoryJson } from "../../../../../_shared";
import type { RequestHandler } from "./$types";

export const PUT: RequestHandler = event => handleFactorySessionApi(event, async () => ({
  kind: "release.policy.put", path: { projectId: event.params.projectId, policyId: event.params.policyId }, body: await readFactoryJson(event.request),
}));

export const DELETE: RequestHandler = event => handleFactorySessionApi(event, () => ({
  kind: "release.policy.delete", path: { projectId: event.params.projectId, policyId: event.params.policyId },
}));
