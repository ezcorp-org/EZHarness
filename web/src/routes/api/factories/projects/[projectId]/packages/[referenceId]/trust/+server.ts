import { handleFactorySessionApi, readFactoryJson } from "../../../../../_shared";
import type { RequestHandler } from "./$types";

/** Publish, quarantine, or revoke at the exact current trust revision (`If-Match`). A human tenant administrator. */
export const POST: RequestHandler = event => handleFactorySessionApi(event, async () => ({
  kind: "package.trust", path: { projectId: event.params.projectId, referenceId: event.params.referenceId }, body: await readFactoryJson(event.request),
}));
