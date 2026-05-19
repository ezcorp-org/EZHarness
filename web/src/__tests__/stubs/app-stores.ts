/**
 * jsdom stub for `$app/stores` (SvelteKit's classic readable-store
 * page surface). Tests can `vi.mock("$app/stores", ...)` to provide
 * a richer fake; this stub keeps the import resolver happy.
 */
import { readable } from "svelte/store";

const pageValue = {
	url: new URL("http://localhost/"),
	route: { id: null as string | null },
	params: {} as Record<string, string>,
	form: null as unknown,
	data: {} as Record<string, unknown>,
	state: {} as Record<string, unknown>,
	error: null as unknown,
	status: 200,
};

export const page = readable(pageValue);
export const navigating = readable(null);
export const updated = readable(false);
