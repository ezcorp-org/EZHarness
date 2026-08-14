import { listExtensions } from "$server/db/queries/extensions";
import { redactExtensionSecrets } from "$server/extensions/mcp-secret-redaction";
import { withListFlagsAll } from "$server/extensions/list-flags";
import type { PageServerLoad } from "./$types";

/**
 * Phase 52.1 — Library tabs server loader.
 *
 * Splits the existing card grid into two lists at the data layer so the
 * client doesn't have to filter twice. Both lists come from the same
 * underlying `extensions` table — `isBundled` is the only discriminator,
 * matching the column-level provenance flag added in Phase 12.
 *
 * Data shape mirrors what the legacy client-side `GET /api/extensions`
 * returned (the SSR loader pre-loads the same rows the page would have
 * fetched on mount). The page still performs runtime mutations through
 * `/api/extensions/*` and re-fetches the merged list — the SSR data is a
 * progressive-enhancement starting point, not a write barrier.
 */
export const load: PageServerLoad = async () => {
  // Soft-fail to empty arrays if the DB is unavailable — the existing
  // client-side `loadExtensions()` (kept for post-mutation refresh)
  // re-fetches via `GET /api/extensions` on mount and surfaces a toast
  // on failure. SSR errors here would block the entire page; SSR is
  // an enhancement, not a load-bearing barrier.
  try {
    const [bundledExtensions, installedExtensions] = await Promise.all([
      listExtensions({ bundled: true }),
      listExtensions({ bundled: false }),
    ]);
    // Same derived flags `GET /api/extensions` attaches, so the SSR first
    // paint and the post-mutation re-fetch render identical cards.
    // #205: page data is serialized into the SSR HTML for ANY authenticated
    // user, so it needs the same scrub `GET /api/extensions` applies — the
    // client re-fetch already got it and the first paint did not.
    return {
      bundledExtensions: withListFlagsAll(bundledExtensions.map(redactExtensionSecrets)),
      installedExtensions: withListFlagsAll(installedExtensions.map(redactExtensionSecrets)),
    };
  } catch {
    return { bundledExtensions: [], installedExtensions: [] };
  }
};
