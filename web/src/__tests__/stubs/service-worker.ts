/**
 * Test-only stub for SvelteKit's `$service-worker` virtual module.
 *
 * That module is generated at build time and is unresolvable under vitest.
 * `service-worker.shell.unit.test.ts` imports the real SW shell to line-cover
 * it, so this provides the `{ version, build, files }` (and the rest of the
 * surface) the shell — and any future SW code — destructures at import time.
 * The shell test `vi.mock`s this path with concrete fixtures when it needs to
 * assert on the precache list.
 */
export const base = "";
export const build: string[] = [];
export const files: string[] = [];
export const prerendered: string[] = [];
export const version = "test";
