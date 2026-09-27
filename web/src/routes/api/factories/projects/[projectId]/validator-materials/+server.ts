import { handleFactoryApi } from "../../../_shared";
import type { RequestHandler } from "./$types";

/** The registered validator material of a published version, or of a validator lock (W09d O2). */
export const GET: RequestHandler = event => handleFactoryApi(event, {
  scope: "read",
  build: () => {
    const query: Record<string, string> = {};
    for (const key of ["factoryId", "factoryVersion", "validatorLockDigest"] as const) {
      const value = event.url.searchParams.get(key);
      if (value !== null) query[key] = value;
    }
    return { kind: "validator.material", path: { projectId: event.params.projectId }, query };
  },
});
