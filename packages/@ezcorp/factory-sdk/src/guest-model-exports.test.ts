import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FACTORY_GUEST_MODEL_LIMITS, FACTORY_LIMITS } from "./index";

/**
 * The guest model bounds must be importable, not merely declared.
 *
 * `index.ts` re-exports `types.js` with `export type *`, which carries TYPES
 * ONLY. A runtime constant declared in `types.ts` is therefore invisible to
 * every consumer unless it is also named in the explicit value-export list, and
 * nothing in the type system says so: the source compiles, the declaration is
 * right there, and the import silently yields `undefined`. W10 and W11 are told
 * by the interface freeze to respect these bounds, so an unimportable constant
 * is a contract they cannot obey.
 */

const BUILT = join(import.meta.dir, "../dist/index.js");

test("the guest model bounds are a value on the barrel, not a type-only re-export", () => {
  expect(FACTORY_GUEST_MODEL_LIMITS).toEqual({
    maxMessages: 64, maxMessageBytes: 16 * 1024, maxInputBytes: 32 * 1024,
    maxOutputTokens: 8_192, maxResponseBytes: 128 * 1024,
  });
  // Frozen, because a consumer that could widen its own bound is not bound.
  expect(Object.isFrozen(FACTORY_GUEST_MODEL_LIMITS)).toBe(true);
  // The control: a constant that was already reachable stays reachable.
  expect(FACTORY_LIMITS).toBeDefined();
});

test("the BUILT package exports them too, with the same values", async () => {
  // `postinstall` builds this package, so dist is present in any worktree that
  // followed the install steps. Consumers outside the bun workspace resolve
  // `import` to dist, never to src, so the source check above cannot stand in
  // for this one.
  expect(existsSync(BUILT), `${BUILT} is missing — run bun run --cwd packages/@ezcorp/factory-sdk build`).toBe(true);
  const built = await import(BUILT) as Record<string, unknown>;
  expect(built.FACTORY_GUEST_MODEL_LIMITS).toEqual(FACTORY_GUEST_MODEL_LIMITS);
  expect(built.FACTORY_LIMITS).toEqual(FACTORY_LIMITS);
  for (const name of ["validateFactoryGuestModelRequest", "validateFactoryGuestModelResponse", "isFactoryGuestModelRequest", "isFactoryGuestModelResponse"]) {
    expect(typeof built[name], `${name} is not on the built barrel`).toBe("function");
  }
});
