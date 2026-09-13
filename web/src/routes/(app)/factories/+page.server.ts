import { error } from "@sveltejs/kit";
import { factoryBootConfig } from "$server/factory/boot";

export function load(): Record<string, never> {
	if (!factoryBootConfig.enabled) error(404, "Factories are disabled.");
	return {};
}
