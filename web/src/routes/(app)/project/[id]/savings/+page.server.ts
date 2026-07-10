import { error } from "@sveltejs/kit";
import { DEFAULT_RANGE_DAYS, savingsUrl, type SavingsResponse } from "$lib/savings-format";
import type { PageServerLoad } from "./$types";

/**
 * Project-scoped savings dashboard loader — THIN: guard + server-side
 * fetch for SSR first paint + pass-through.
 *
 * Ownership is enforced by the API endpoint, which collapses foreign
 * and unknown project ids to 404 (fail-closed, no existence leak) — we
 * pass that 404 through to the page verbatim. Auth mirrors the global
 * loader: unauthenticated requests only reach this loader in the
 * DB-less e2e preview (hooks.server.ts PI_SKIP_INIT fail-open); real
 * deployments are redirected to /login in hooks first, so the shell
 * fallback below never serves data-bearing content unauthenticated.
 */
export const load: PageServerLoad = async ({ locals, fetch, params }) => {
  if (!locals.user) {
    return { savings: null as SavingsResponse | null, rangeDays: DEFAULT_RANGE_DAYS };
  }

  const res = await fetch(savingsUrl(DEFAULT_RANGE_DAYS, params.id));
  if (res.status === 404) throw error(404, "Project not found");
  return {
    savings: res.ok ? ((await res.json()) as SavingsResponse) : null,
    rangeDays: DEFAULT_RANGE_DAYS,
  };
};
