import { handleFactorySessionApi, readFactoryJson } from "../../../../../../_shared";
import type { RequestHandler } from "./$types";

function path(params: { projectId: string; principalKind: string; principalId: string; action: string }) {
  return { projectId: params.projectId, principalKind: params.principalKind, principalId: params.principalId, action: params.action };
}

export const PUT: RequestHandler = event => handleFactorySessionApi(event,
  async () => ({ kind: "grant.set", path: path(event.params), body: await readFactoryJson(event.request) }),
);

export const DELETE: RequestHandler = event => handleFactorySessionApi(event,
  () => ({ kind: "grant.revoke", path: path(event.params) }),
);
