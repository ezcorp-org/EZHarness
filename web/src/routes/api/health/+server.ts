import { json } from "@sveltejs/kit";
import { buildHealthResponse } from "$server/health";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url, locals }) => {
  const detail = url.searchParams.get("detail") === "true";

  if (detail) {
    // This gate RETURNS its denial; it must never throw one. SvelteKit does
    // not recognise a thrown Response from a `+server.ts` handler — it runs
    // handleError and answers a generic 500 — which is what the old leading
    // `requireAuth(locals)` did, so `?detail=true` used to answer "Internal
    // Error" to every caller instead of a 401.
    //
    // `route-contract.test.ts`'s thrown-Response scan cannot catch that: it
    // skips `requireAuth` on the grounds that hooks.server.ts answers
    // unauthenticated `/api/*` with 401 before the handler runs. True for
    // every route EXCEPT the hooks PUBLIC_PATHS allowlist, and `/api/health`
    // is on it (a liveness probe's bare path must answer anonymously
    // forever), which is exactly why the throw was reachable.
    //
    // Being on that allowlist also used to mean `locals.user` was never
    // populated, so this gate answered 401 to ADMINS too and the detailed
    // probe was unreachable over HTTP. hooks.server.ts now resolves a
    // presented session cookie opportunistically on public `/api/*` paths —
    // identification is separated from enforcement — so an admin lands here
    // with a principal while the cookieless probe stays anonymous and free.
    const user = locals.user as { role?: string } | undefined;
    if (!user || user.role !== "admin") {
      return errorJson(401, "Admin access required");
    }
  }

  const result = await buildHealthResponse(detail);
  return json(result);
};
