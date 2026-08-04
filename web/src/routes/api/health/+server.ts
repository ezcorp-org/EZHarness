import { json } from "@sveltejs/kit";
import { buildHealthResponse } from "$server/health";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url, locals }) => {
  const detail = url.searchParams.get("detail") === "true";

  if (detail) {
    // The redundant `requireAuth(locals)` that used to lead this block THREW
    // its 401, and SvelteKit renders a thrown Response from a +server.ts
    // handler as a generic 500 — so `?detail=true` answered "Internal Error"
    // to every caller instead of the 401 the next three lines already produce.
    //
    // `route-contract.test.ts`'s thrown-Response scan cannot catch this: it
    // deliberately skips `requireAuth` on the grounds that hooks.server.ts
    // answers unauthenticated `/api/*` with 401 before the handler runs. True
    // for every route EXCEPT the hooks PUBLIC_PATHS allowlist — and
    // `/api/health` is on it, which is exactly why the throw was reachable.
    //
    // The `!user` branch below is the whole gate and it RETURNS. Reachability
    // is unchanged and still broken: a public path never populates
    // `locals.user`, so no admin can obtain the detailed probe either. That is
    // the same PUBLIC_PATHS defect F5 fixed for /api/auth/invite, still live
    // here and on POST /api/auth/reset-password. Fixing the allowlist is a
    // separate, reviewable change; answering 401 instead of 500 is not.
    const user = locals.user as { role?: string } | undefined;
    if (!user || user.role !== "admin") {
      return errorJson(401, "Admin access required");
    }
  }

  const result = await buildHealthResponse(detail);
  return json(result);
};
