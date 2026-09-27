import { handleFactorySessionApi, readFactoryJson } from "../../../../../_shared";
import type { RequestHandler } from "./$types";

/**
 * Signs one recovery report by digest. W15's restore records the signature and
 * reopens service; the console first refuses a report that no longer matches
 * its stored digest. A human tenant administrator session only (review L4).
 */
export const POST: RequestHandler = event => handleFactorySessionApi(event, async () => ({
  kind: "restore.sign", path: { tenantId: event.params.tenantId, restoreId: event.params.restoreId }, body: await readFactoryJson(event.request),
}));
