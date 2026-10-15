import { handleFactorySessionApi } from "../../../../../../_shared";
import type { RequestHandler } from "./$types";

export const DELETE: RequestHandler = event => handleFactorySessionApi(event, () => ({
  kind: "service-credential.revoke",
  path: {
    projectId: event.params.projectId,
    serviceAccountId: event.params.serviceAccountId,
    credentialId: event.params.credentialId,
  },
}));
