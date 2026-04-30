/**
 * jsdom stub for `$app/navigation` — vitest's resolver can't reach
 * `.svelte-kit/runtime/app` because the runtime directory only exists
 * after a SvelteKit build. Tests that pull in the navigation API use
 * `vi.mock("$app/navigation", ...)` to assert behaviour; this stub just
 * exists so the import resolves.
 */
export const goto = (..._args: unknown[]): Promise<void> => Promise.resolve();
export const invalidate = (..._args: unknown[]): Promise<void> => Promise.resolve();
export const invalidateAll = (): Promise<void> => Promise.resolve();
export const beforeNavigate = (..._args: unknown[]): void => {};
export const afterNavigate = (..._args: unknown[]): void => {};
export const onNavigate = (..._args: unknown[]): void => {};
export const preloadCode = (..._args: unknown[]): Promise<void> => Promise.resolve();
export const preloadData = (..._args: unknown[]): Promise<unknown> => Promise.resolve(null);
export const pushState = (..._args: unknown[]): void => {};
export const replaceState = (..._args: unknown[]): void => {};
export const disableScrollHandling = (): void => {};
