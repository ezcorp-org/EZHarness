import { handleFactoryApi, readFactoryJson } from "../../../../../../_shared";
import type { RequestHandler } from "./$types";

function path(params: { projectId: string; principalKind: string; principalId: string; action: string }) {
  return { projectId: params.projectId, principalKind: params.principalKind, principalId: params.principalId, action: params.action };
}

// C01 assigns grant management to a tenant administrator under the `admin`
// scope. `handleFactoryApi` gates that scope on the admin role as well as the
// key scope, and the product layer still checks the issuer's own authority.
export const PUT: RequestHandler = event => handleFactoryApi(event, {
  scope: "admin",
  build: async () => ({ kind: "grant.set", path: path(event.params), body: await readFactoryJson(event.request) }),
});

export const DELETE: RequestHandler = event => handleFactoryApi(event, {
  scope: "admin",
  build: () => ({ kind: "grant.revoke", path: path(event.params) }),
});
