import { DEFAULT_RANGE_DAYS, savingsUrl, type SavingsResponse } from "$lib/savings-format";
import type { PageServerLoad } from "./$types";

/**
 * Global per-user savings dashboard loader — THIN by design: guard +
 * server-side fetch of the per-user endpoint for the SSR first paint +
 * pass-through. All math/formatting lives in `$lib/savings-format` and
 * the API; all rendering in `SavingsDashboard.svelte`.
 *
 * Auth: every real deployment redirects unauthenticated page requests
 * to /login in hooks.server.ts before loaders run. The ONLY environment
 * where an unauthenticated request reaches this loader is the DB-less
 * e2e preview (PI_SKIP_INIT fail-open, hooks.server.ts:493-500) — there
 * we return a data-less shell and the page hydrates via its own
 * (auth-gated) client-side fetch instead of 401ing the whole document.
 * A non-ok SSR fetch degrades the same way (client retry), matching the
 * admin-dashboard's per-source fail-soft convention.
 */
export const load: PageServerLoad = async ({ locals, fetch }) => {
  if (!locals.user) {
    return { savings: null as SavingsResponse | null, rangeDays: DEFAULT_RANGE_DAYS };
  }

  const res = await fetch(savingsUrl(DEFAULT_RANGE_DAYS));
  return {
    savings: res.ok ? ((await res.json()) as SavingsResponse) : null,
    rangeDays: DEFAULT_RANGE_DAYS,
  };
};
