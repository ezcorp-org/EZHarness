/**
 * jsdom stub for `$app/state` (SvelteKit 2 runes-style page object).
 * Tests that need a specific page state use `vi.mock("$app/state",
 * ...)`; this stub just ensures the import resolves under vitest
 * (the real `.svelte-kit/runtime/app/state` only exists after a
 * SvelteKit build).
 */
export const page = {
	url: { pathname: "/", search: "", href: "http://localhost/" } as URL | { pathname: string; search: string; href?: string },
	route: { id: null as string | null },
	params: {} as Record<string, string>,
	form: null as unknown,
	data: {} as Record<string, unknown>,
	state: {} as Record<string, unknown>,
	error: null as unknown,
	status: 200,
};

export const navigating = null;
export const updated = { current: false, check: async () => false };
