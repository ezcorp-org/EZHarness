import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

// The pipelines subsystem was renamed to Workflows. This single permanent
// redirect keeps a bookmarked exact `/pipelines` link working for one
// release. (Only the exact path redirects — there is no `/pipelines/[name]`
// or `/pipelines/new` route, so those deep links now 404 rather than funnel
// here; the redirect deliberately covers just the index.)
export const load: PageServerLoad = async () => {
  throw redirect(308, "/workflows");
};
