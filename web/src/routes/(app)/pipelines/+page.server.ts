import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

// The pipelines subsystem was renamed to Workflows. This single permanent
// redirect keeps any bookmarked `/pipelines` link (and the legacy
// `/pipelines/*` deep links, which SvelteKit funnels here when no more
// specific route matches) working for one release.
export const load: PageServerLoad = async () => {
  throw redirect(308, "/workflows");
};
