import { handleFactorySessionApi } from "../../../_shared";
import type { RequestHandler } from "./$types";

/** The closing preconditions and the audit a purge would destroy. A human tenant administrator. */
export const GET: RequestHandler = event => handleFactorySessionApi(event, () => ({ kind: "purge.preview", path: { tenantId: event.params.tenantId } }));
