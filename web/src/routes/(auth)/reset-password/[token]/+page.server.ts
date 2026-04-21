import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ params }) => {
  return { token: params.token };
};
