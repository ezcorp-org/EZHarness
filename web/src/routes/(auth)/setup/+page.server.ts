import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { getUserCount } from "$server/db/queries/users";

export const load: PageServerLoad = async () => {
  const count = await getUserCount();
  if (count > 0) {
    throw redirect(302, "/login");
  }
  return {};
};
