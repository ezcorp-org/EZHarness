import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { hasAnyProvider } from "$server/db/queries/quickstart";

export const load: PageServerLoad = async ({ locals }) => {
  // Defensive: in production, hooks.server.ts redirects unauth users to
  // /login before this load runs (/onboarding is not in PUBLIC_PATHS).
  // The branch survives for E2E (PI_SKIP_INIT bypasses the hook gate)
  // and any future config that loosens the path list.
  if (!locals.user) {
    throw redirect(302, "/login");
  }
  // The hook stashed `onboardedAt` on locals during the upstream lookup,
  // so we don't re-query getUserById here.
  if (locals.onboardedAt) {
    throw redirect(302, "/");
  }

  return {
    user: { id: locals.user.id, name: locals.user.name, email: locals.user.email },
    hasProvider: await hasAnyProvider(),
  };
};
