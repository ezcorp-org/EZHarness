import { error } from "@sveltejs/kit";
import { requireAdminSession } from "$server/auth/middleware";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
	const admin = requireAdminSession(locals);
	if (admin instanceof Response) throw error(admin.status, "Administrator session required");
	return { breadcrumbTail: "Incus sandboxes", operatorId: admin.id };
};
