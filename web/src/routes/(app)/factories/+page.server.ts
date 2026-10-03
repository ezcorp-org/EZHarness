import { error } from "@sveltejs/kit";
import { factoryBootConfig } from "$server/factory/boot";
import { getFactoryApplication } from "$server/factory/application";
import type { PageServerLoad } from "./$types";

/**
 * The console needs two facts the browser cannot know: the installation's
 * tenant (the purge request names it) and whether the viewer is a tenant
 * administrator (the actions that need one are disabled for everyone else).
 * Neither grants anything; every action is authorized again on the server.
 */
export const load: PageServerLoad = ({ locals }) => {
	if (!factoryBootConfig.enabled) error(404, "Factories are disabled.");
	return { tenantId: getFactoryApplication()?.tenantId ?? null, administrator: locals.user?.role === "admin" };
};
