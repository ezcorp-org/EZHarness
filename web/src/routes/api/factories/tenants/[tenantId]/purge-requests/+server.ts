import { handleFactorySessionApi, readFactoryJson } from "../../../_shared";
import type { RequestHandler } from "./$types";

/**
 * Records a tenant purge request. It deletes nothing: open work refuses it,
 * and a queued request is carried out and certified under W19.
 */
export const POST: RequestHandler = event => handleFactorySessionApi(event, async () => ({
  kind: "purge.request", path: { tenantId: event.params.tenantId }, body: await readFactoryJson(event.request),
}));
