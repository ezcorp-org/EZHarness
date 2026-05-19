import { json } from "@sveltejs/kit";
import { getUpdateCheck } from "$server/update-check";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
  const result = await getUpdateCheck();
  return json(result);
};
