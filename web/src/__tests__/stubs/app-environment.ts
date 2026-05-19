/**
 * jsdom stub for `$app/environment` — vitest's resolver can't reach
 * `.svelte-kit/runtime/app` (the runtime dir only exists after a
 * SvelteKit build). Mirrors the existing `app-navigation` /
 * `app-state` / `app-stores` stub pattern so components that read
 * `browser` / `dev` / `building` import-resolve under jsdom. Tests
 * needing a specific value `vi.mock("$app/environment", …)` on top.
 */
export const browser = true;
export const dev = false;
export const building = false;
export const version = "test";
