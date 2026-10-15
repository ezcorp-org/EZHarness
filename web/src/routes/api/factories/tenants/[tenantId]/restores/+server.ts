import { handleFactorySessionApi } from "../../../_shared";
import type { RequestHandler } from "./$types";

/** The tenant's restore epochs and their recovery reports. A human tenant administrator session only (review L4). */
export const GET: RequestHandler = event => handleFactorySessionApi(event, () => ({ kind: "restore.list", path: { tenantId: event.params.tenantId } }));
